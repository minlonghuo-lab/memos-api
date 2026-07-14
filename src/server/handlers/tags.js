import { Hono } from 'hono';
import { requireAuth, jsonResponse, errorResponse } from '../utils/auth';
import { getTagSchema, upsertTagRecord } from '../utils/tags.js';

const app = new Hono();

/**
 * GET /api/v1/tag - 列出所有标签
 * 参考 Memos: GET /api/v1/tag
 */
app.get('/', async (c) => {
  // 获取当前用户（如果已登录）
  const token = c.req.header('Authorization')?.replace('Bearer ', '') ||
                c.req.header('X-Token') ||
                c.req.query('token');
  let currentUser = null;

  if (token) {
    try {
      // 优先尝试JWT验证
      if (token.startsWith('eyJ')) {
        const { verifyJWT, getJWTSecret } = await import('../utils/jwt.js');
        const jwtSecret = getJWTSecret(c.env);
        const payload = await verifyJWT(token, jwtSecret);

        if (payload) {
          currentUser = { id: payload.id };
        }
      } else {
        // 回退到session token验证
        const { validateSession } = await import('../utils/auth.js');
        const sessionUser = await validateSession(c.env.DB, token);
        if (sessionUser) {
          currentUser = { id: sessionUser.id };
        }
      }
    } catch (e) {
      // 忽略验证错误，继续作为未登录用户
    }
  }

  try {
    const db = c.env.DB;
    const tagSchema = await getTagSchema(db);

    // 获取URL参数中的userId（可能是用户名或用户ID）
    const userIdParam = c.req.query('userId');
    let targetUserId = null;

    // 如果提供了userId参数，尝试查找该用户
    if (userIdParam) {
      // 判断是用户名还是用户ID（数字）
      const isNumeric = /^\d+$/.test(userIdParam);

      if (isNumeric) {
        // 如果是数字，直接使用
        targetUserId = parseInt(userIdParam);
      } else {
        // 如果是字符串，查找用户名对应的ID
        const userStmt = db.prepare('SELECT id FROM users WHERE username = ?');
        const user = await userStmt.bind(userIdParam).first();
        if (user) {
          targetUserId = user.id;
        }
      }
    } else if (currentUser) {
      // 如果没有提供userId参数，使用当前登录用户
      targetUserId = currentUser.id;
    }

    // 如果没有目标用户ID，返回空数组
    if (!targetUserId) {
      return jsonResponse([]);
    }

    const selectColumns = [
      't.id',
      't.name',
      tagSchema.hasCreatorId ? 't.creator_id as creatorId' : 'NULL as creatorId',
      tagSchema.hasCreatedTs ? 't.created_ts as createdTs' : 'NULL as createdTs',
      'COUNT(DISTINCT mt.memo_id) as memoCount',
    ];
    const groupByColumns = ['t.id', 't.name'];
    if (tagSchema.hasCreatorId) {
      groupByColumns.push('t.creator_id');
    }
    if (tagSchema.hasCreatedTs) {
      groupByColumns.push('t.created_ts');
    }

    let query = `
      SELECT
        ${selectColumns.join(',\n        ')}
      FROM tags t
      LEFT JOIN memo_tags mt ON t.id = mt.tag_id
      LEFT JOIN memos m ON mt.memo_id = m.id AND m.row_status = 'NORMAL'
    `;

    const whereConditions = [];
    const bindValues = [];

    // 只返回目标用户创建的标签
    if (tagSchema.hasCreatorId) {
      whereConditions.push('(t.creator_id = ? OR t.creator_id IS NULL)');
      bindValues.push(targetUserId);
    }

    if (whereConditions.length > 0) {
      query += ' WHERE ' + whereConditions.join(' AND ');
    }

    query += `
      GROUP BY ${groupByColumns.join(', ')}
      ORDER BY memoCount DESC, t.name ASC
    `;

    const stmt = db.prepare(query);
    const { results } = await stmt.bind(...bindValues).all();

    return jsonResponse(results || []);
  } catch (error) {
    console.error('Error fetching tags:', error);
    return errorResponse('Failed to fetch tags', 500);
  }
});

/**
 * POST /api/v1/tag - 创建标签
 * 参考 Memos: POST /api/v1/tag
 *
 * Body:
 * {
 *   "name": "标签名"
 * }
 */
app.post('/', async (c) => {
  const authError = await requireAuth(c);
  if (authError) return authError;

  try {
    const db = c.env.DB;
    const body = await c.req.json();
    const currentUser = c.get('user');

    if (!currentUser) {
      return errorResponse('User information not found', 401);
    }

    if (!body.name || !body.name.trim()) {
      return errorResponse('Tag name is required', 400);
    }

    const tagName = body.name.trim();

    const { tag, created, conflict } = await upsertTagRecord(db, tagName, currentUser.id);

    if (conflict) {
      return errorResponse('Tag name already exists', 409);
    }

    return jsonResponse({
      ...tag,
      message: created ? 'Tag created successfully' : 'Tag already exists',
    }, created ? 201 : 200);
  } catch (error) {
    console.error('Error creating tag:', error);
    return errorResponse('Failed to create tag', 500);
  }
});

/**
 * GET /api/v1/tag/suggestion - 标签建议
 * 参考 Memos: GET /api/v1/tag/suggestion
 *
 * 返回最常用的标签作为建议
 */
app.get('/suggestion', async (c) => {
  try {
    const db = c.env.DB;
    const limit = parseInt(c.req.query('limit')) || 10;

    const stmt = db.prepare(`
      SELECT
        t.id,
        t.name,
        COUNT(DISTINCT mt.memo_id) as memoCount
      FROM tags t
      JOIN memo_tags mt ON t.id = mt.tag_id
      JOIN memos m ON mt.memo_id = m.id
      WHERE m.row_status = 'NORMAL'
      GROUP BY t.id, t.name
      ORDER BY memoCount DESC, t.name ASC
      LIMIT ?
    `);

    const { results } = await stmt.bind(limit).all();

    return jsonResponse(results || []);
  } catch (error) {
    console.error('Error fetching tag suggestions:', error);
    return errorResponse('Failed to fetch tag suggestions', 500);
  }
});

/**
 * POST /api/v1/tag/delete - 删除标签
 * 参考 Memos: POST /api/v1/tag/delete (在Memos中是POST，不是DELETE)
 *
 * Body:
 * {
 *   "name": "标签名"
 * }
 */
app.post('/delete', async (c) => {
  const authError = await requireAuth(c);
  if (authError) return authError;

  try {
    const db = c.env.DB;
    const body = await c.req.json();
    const currentUser = c.get('user');
    const tagSchema = await getTagSchema(db);

    if (!currentUser) {
      return errorResponse('User information not found', 401);
    }

    if (!body.name) {
      return errorResponse('Tag name is required', 400);
    }

    const selectColumns = tagSchema.hasCreatorId ? 'id, creator_id' : 'id, NULL as creator_id';
    const checkStmt = db.prepare(`SELECT ${selectColumns} FROM tags WHERE name = ?`);
    const tag = await checkStmt.bind(body.name).first();

    if (!tag) {
      return errorResponse('Tag not found', 404);
    }

    // 权限检查：只有创建者才能删除
    if (tagSchema.hasCreatorId && tag.creator_id !== null && tag.creator_id !== currentUser.id) {
      return errorResponse('Permission denied: You can only delete tags you created', 403);
    }

    // 删除标签（会级联删除memo_tags中的关联，因为有ON DELETE CASCADE）
    const deleteStmt = db.prepare('DELETE FROM tags WHERE id = ?');
    const result = await deleteStmt.bind(tag.id).run();

    if (result.changes === 0) {
      return errorResponse('Failed to delete tag', 500);
    }

    return jsonResponse({
      message: 'Tag deleted successfully',
      name: body.name
    });
  } catch (error) {
    console.error('Error deleting tag:', error);
    return errorResponse('Failed to delete tag', 500);
  }
});

/**
 * DELETE /api/v1/tag/:id - 按ID删除标签（额外提供的RESTful方式）
 */
app.delete('/:id', async (c) => {
  const authError = await requireAuth(c);
  if (authError) return authError;

  try {
    const db = c.env.DB;
    const tagId = c.req.param('id');
    const currentUser = c.get('user');
    const tagSchema = await getTagSchema(db);

    if (!currentUser) {
      return errorResponse('User information not found', 401);
    }

    // 检查标签是否存在且属于当前用户
    const selectColumns = tagSchema.hasCreatorId ? 'id, name, creator_id' : 'id, name, NULL as creator_id';
    const checkStmt = db.prepare(`SELECT ${selectColumns} FROM tags WHERE id = ?`);
    const tag = await checkStmt.bind(tagId).first();

    if (!tag) {
      return errorResponse('Tag not found', 404);
    }

    // 权限检查：只有创建者才能删除
    if (tagSchema.hasCreatorId && tag.creator_id !== null && tag.creator_id !== currentUser.id) {
      return errorResponse('Permission denied: You can only delete tags you created', 403);
    }

    // 删除标签
    const deleteStmt = db.prepare('DELETE FROM tags WHERE id = ?');
    const result = await deleteStmt.bind(tagId).run();

    if (result.changes === 0) {
      return errorResponse('Failed to delete tag', 500);
    }

    return jsonResponse({
      message: 'Tag deleted successfully',
      name: tag.name
    });
  } catch (error) {
    console.error('Error deleting tag:', error);
    return errorResponse('Failed to delete tag', 500);
  }
});

export default app;
