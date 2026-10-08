import { Hono } from 'hono';
import { requireAuth, jsonResponse, errorResponse, ensureDefaultUser } from '../utils/auth';

const app = new Hono();

const resourceFileUrl = (origin, resource) => `${origin}/api/v1/resource/${resource.id}/file`;

const formatResource = (resource, origin) => ({
  id: resource.id,
  creatorId: resource.creator_id ?? resource.creatorId,
  creatorID: resource.creator_id ?? resource.creatorId,
  filename: resource.filename,
  filepath: resource.filepath,
  externalLink: resource.filepath?.startsWith('http') ? resource.filepath : resourceFileUrl(origin, resource),
  type: resource.type,
  size: resource.size,
  createdTs: resource.created_ts ?? resource.createdTs,
  updatedTs: resource.updated_ts ?? resource.updatedTs ?? resource.created_ts ?? resource.createdTs,
  memoId: resource.memoId ?? resource.memo_id ?? null,
  name: resource.filepath || `${resource.id}/${resource.filename}`,
  uid: resource.filepath || `${resource.id}/${resource.filename}`,
});

async function createResourceFromUpload(c) {
  const authError = await requireAuth(c);
  if (authError) return authError;

  try {
    const db = c.env.DB;
    const bucket = c.env.BUCKET;

    const formData = await c.req.formData();
    const file = formData.get('file');
    const externalLink = formData.get('externalLink');

    if (!file) {
      if (!externalLink) {
        return errorResponse('No file provided');
      }

      const currentUser = c.get('user');
      const filename = formData.get('filename') || String(externalLink).split('/').pop() || 'external-resource';
      const type = formData.get('type') || 'application/octet-stream';

      const result = await db.prepare(`
        INSERT INTO resources (creator_id, filename, filepath, type, size)
        VALUES (?, ?, ?, ?, ?)
      `).bind(currentUser.id, filename, String(externalLink), type, 0).run();

      return jsonResponse(formatResource({
        id: result.meta.last_row_id,
        creator_id: currentUser.id,
        filename,
        filepath: String(externalLink),
        type,
        size: 0,
        created_ts: Math.floor(Date.now() / 1000),
      }, new URL(c.req.url).origin));
    }

    const MAX_FILE_SIZE = 32 * 1024 * 1024;
    if (file.size > MAX_FILE_SIZE) {
      return errorResponse(`File size exceeds maximum allowed size of ${MAX_FILE_SIZE / 1024 / 1024}MB`);
    }

    const filename = file.name;
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return errorResponse('Invalid filename');
    }

    let creatorId = c.get('user')?.id;
    if (!creatorId) {
      creatorId = await ensureDefaultUser(c.env.DB);
    }

    const timestamp = Date.now();
    const fileExtension = file.name.split('.').pop();
    const uniqueFilename = `${creatorId}_${timestamp}.${fileExtension}`;

    const uploadResult = await bucket.put(uniqueFilename, file.stream(), {
      httpMetadata: {
        contentType: file.type || 'application/octet-stream',
      },
    });

    if (!uploadResult) {
      return errorResponse('Failed to upload file', 500);
    }

    const stmt = db.prepare(`
      INSERT INTO resources (creator_id, filename, filepath, type, size)
      VALUES (?, ?, ?, ?, ?)
    `);

    const result = await stmt.bind(
      creatorId,
      file.name,
      uniqueFilename,
      file.type || 'application/octet-stream',
      file.size
    ).run();

    const resource = {
      id: result.meta.last_row_id,
      creator_id: creatorId,
      filename: file.name,
      filepath: uniqueFilename,
      type: file.type || 'application/octet-stream',
      size: file.size,
      created_ts: Math.floor(Date.now() / 1000),
    };

    return jsonResponse({
      ...formatResource(resource, new URL(c.req.url).origin),
      message: 'File uploaded successfully',
    });
  } catch (error) {
    console.error('Error uploading resource:', error);
    return errorResponse('Failed to upload resource', 500);
  }
}

// 获取资源列表 - 只返回当前用户的资源
app.get('/', async (c) => {
  const authError = await requireAuth(c);
  if (authError) return authError;

  try {
    const db = c.env.DB;
    const currentUser = c.get('user');
    const limit = parseInt(c.req.query('limit')) || 20;
    const offset = parseInt(c.req.query('offset')) || 0;

    // 只返回当前用户创建的资源
    // 使用子查询获取第一个关联的 memo_id（只返回状态为 NORMAL 的 memo）
    // 如果 memo 被删除，memoId 返回 NULL，资源会被归类为"未使用的资源"
    const stmt = db.prepare(`
      SELECT r.id, r.filename, r.filepath, r.type, r.size, r.created_ts,
             u.username as creator_username, u.nickname as creator_name,
             (
               SELECT mr.memo_id
               FROM memo_resources mr
               JOIN memos m ON mr.memo_id = m.id AND m.row_status = 'NORMAL'
               WHERE mr.resource_id = r.id
               LIMIT 1
             ) as memoId
      FROM resources r
      LEFT JOIN users u ON r.creator_id = u.id
      WHERE r.creator_id = ?
      ORDER BY r.created_ts DESC
      LIMIT ? OFFSET ?
    `);

    const { results } = await stmt.bind(currentUser.id, limit, offset).all();

    // 转换时间戳为毫秒并转换字段名为 camelCase
    const origin = new URL(c.req.url).origin;
    const formattedResults = results.map(r => ({
      ...formatResource(r, origin),
      creatorUsername: r.creator_username,
      creatorName: r.creator_name,
      createdTs: r.created_ts,
      updatedTs: r.created_ts,
    }));

    return jsonResponse(formattedResults);
  } catch (error) {
    console.error('Error fetching resources:', error);
    return errorResponse('Failed to fetch resources', 500);
  }
});

// Memos 0.21 / MoeMemos-compatible upload endpoint.
app.post('/blob', createResourceFromUpload);

// 文件代理路由 - 直接从 R2 读取并返回
app.get('/:id/file', async (c) => {
  try {
    const db = c.env.DB;
    const bucket = c.env.BUCKET;
    const id = c.req.param('id');

    const stmt = db.prepare(`
      SELECT id, filename, filepath, type, size
      FROM resources
      WHERE id = ?
    `);

    const resource = await stmt.bind(id).first();

    if (!resource) {
      return errorResponse('Resource not found', 404);
    }

    // 从 filepath 中提取 R2 对象的 key（文件名）
    let objectKey = resource.filepath;

    // 如果 filepath 是完整 URL，提取文件名部分
    if (objectKey.startsWith('http')) {
      const url = new URL(objectKey);
      objectKey = url.pathname.substring(1); // 移除开头的 /
    }

    // 从 R2 获取文件
    const object = await bucket.get(objectKey);

    if (!object) {
      return errorResponse('File not found in storage', 404);
    }

    // 返回文件内容
    return new Response(object.body, {
      headers: {
        'Content-Type': resource.type || 'application/octet-stream',
        'Content-Length': resource.size?.toString() || '',
        'Content-Disposition': `inline; filename="${encodeURIComponent(resource.filename)}"`,
        'Cache-Control': 'public, max-age=31536000',
      },
    });
  } catch (error) {
    console.error('Error proxying resource:', error);
    return errorResponse('Failed to access resource', 500);
  }
});

// 获取单个资源 - 无需权限
app.get('/:id', async (c) => {
  try {
    const db = c.env.DB;
    const id = c.req.param('id');
    
    const stmt = db.prepare(`
      SELECT id, filename, filepath, type, size, created_ts
      FROM resources
      WHERE id = ?
    `);
    
    const resource = await stmt.bind(id).first();
    
    if (!resource) {
      return errorResponse('Resource not found', 404);
    }
    
    // 如果是图片，直接重定向到存储的URL
    if (resource.filepath.startsWith('http')) {
      return Response.redirect(resource.filepath, 302);
    }
    
    return jsonResponse(formatResource(resource, new URL(c.req.url).origin));
  } catch (error) {
    console.error('Error fetching resource:', error);
    return errorResponse('Failed to fetch resource', 500);
  }
});

// 上传资源 - 需要权限
app.post('/', async (c) => {
  const contentType = c.req.header('Content-Type') || '';
  if (contentType.includes('multipart/form-data')) {
    return createResourceFromUpload(c);
  }

  const authError = await requireAuth(c);
  if (authError) return authError;

  try {
    const db = c.env.DB;
    const body = await c.req.json();
    const currentUser = c.get('user');

    if (!body.filename || !body.externalLink) {
      return errorResponse('filename and externalLink are required');
    }

    const stmt = db.prepare(`
      INSERT INTO resources (creator_id, filename, filepath, type, size)
      VALUES (?, ?, ?, ?, ?)
    `);

    const result = await stmt.bind(
      currentUser.id,
      body.filename,
      body.externalLink,
      body.type || 'application/octet-stream',
      body.size || 0
    ).run();

    return jsonResponse(formatResource({
      id: result.meta.last_row_id,
      creator_id: currentUser.id,
      filename: body.filename,
      filepath: body.externalLink,
      type: body.type || 'application/octet-stream',
      size: body.size || 0,
      created_ts: Math.floor(Date.now() / 1000),
    }, new URL(c.req.url).origin));
  } catch (error) {
    console.error('Error creating resource:', error);
    return errorResponse('Failed to create resource', 500);
  }
});

app.patch('/:id', async (c) => {
  const authError = await requireAuth(c);
  if (authError) return authError;

  try {
    const db = c.env.DB;
    const id = c.req.param('id');
    const body = await c.req.json();
    const currentUser = c.get('user');

    const existing = await db.prepare('SELECT creator_id FROM resources WHERE id = ?').bind(id).first();
    if (!existing) return errorResponse('Resource not found', 404);
    if (existing.creator_id !== currentUser.id && !currentUser.isAdmin) {
      return errorResponse('Permission denied', 403);
    }

    if (body.filename) {
      await db.prepare('UPDATE resources SET filename = ? WHERE id = ?').bind(body.filename, id).run();
    }
    if (body.memoId !== undefined) {
      await db.prepare('DELETE FROM memo_resources WHERE resource_id = ?').bind(id).run();
      if (body.memoId) {
        await db.prepare('INSERT INTO memo_resources (memo_id, resource_id) VALUES (?, ?)').bind(body.memoId, id).run();
      }
    }

    const resource = await db.prepare('SELECT * FROM resources WHERE id = ?').bind(id).first();
    return jsonResponse(formatResource(resource, new URL(c.req.url).origin));
  } catch (error) {
    console.error('Error updating resource:', error);
    return errorResponse('Failed to update resource', 500);
  }
});

app.delete('/:id', async (c) => {
  const authError = await requireAuth(c);
  if (authError) return authError;

  try {
    const db = c.env.DB;
    const id = c.req.param('id');
    const currentUser = c.get('user');

    const resource = await db.prepare('SELECT creator_id, filepath FROM resources WHERE id = ?').bind(id).first();
    if (!resource) return errorResponse('Resource not found', 404);
    if (resource.creator_id !== currentUser.id && !currentUser.isAdmin) {
      return errorResponse('Permission denied', 403);
    }

    await db.prepare('DELETE FROM memo_resources WHERE resource_id = ?').bind(id).run();
    await db.prepare('DELETE FROM resources WHERE id = ?').bind(id).run();
    if (resource.filepath && !resource.filepath.startsWith('http')) {
      await c.env.BUCKET.delete(resource.filepath);
    }

    return jsonResponse(true);
  } catch (error) {
    console.error('Error deleting resource:', error);
    return errorResponse('Failed to delete resource', 500);
  }
});

export default app;
