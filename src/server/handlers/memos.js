import { Hono } from 'hono';
import { requireAuth, authenticateIfPresent, jsonResponse, errorResponse, hashPassword, generateSecurePassword } from '../utils/auth';
import { simpleMD5 } from '../utils/gravatar';
import { sendAllNotifications } from '../utils/notifications.js';
import { attachTagToMemo, extractTagNamesFromMemoContent } from '../utils/tags.js';
import { parsePagination } from '../utils/pagination.js';

const app = new Hono();

async function attachMemoMetadata(db, memos) {
  const byId = new Map(memos.map(memo => {
    memo.tagList = [];
    memo.relationList = [];
    return [memo.id, memo];
  }));
  // D1 has a bound-parameter limit. Batch metadata instead of issuing two
  // queries per memo, which also exceeds free-plan query limits on full syncs.
  for (let start = 0; start < memos.length; start += 80) {
    const ids = memos.slice(start, start + 80).map(memo => memo.id);
    const placeholders = ids.map(() => '?').join(',');
    const { results: tags } = await db.prepare(`
      SELECT mt.memo_id AS memoId, t.id, t.name FROM tags t
      JOIN memo_tags mt ON t.id = mt.tag_id
      WHERE mt.memo_id IN (${placeholders}) ORDER BY t.id
    `).bind(...ids).all();
    for (const tag of tags) byId.get(tag.memoId).tagList.push({ id: tag.id, name: tag.name });
    const { results: relations } = await db.prepare(`
      SELECT id, memo_id AS memoId, related_memo_id AS relatedMemoId, type, created_ts AS createdTs
      FROM memo_relations WHERE memo_id IN (${placeholders}) ORDER BY created_ts DESC, id DESC
    `).bind(...ids).all();
    for (const relation of relations) byId.get(relation.memoId).relationList.push(relation);
  }
}

async function resourceIdsForRequest(db, value, creatorId) {
  if (!Array.isArray(value) || value.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    return null;
  }
  const ids = [...new Set(value)];
  for (let start = 0; start < ids.length; start += 80) {
    const chunk = ids.slice(start, start + 80);
    const { results } = await db.prepare(`
      SELECT id FROM resources WHERE creator_id = ? AND id IN (${chunk.map(() => '?').join(',')})
    `).bind(creatorId, ...chunk).all();
    if (results.length !== chunk.length) return null;
  }
  return ids;
}

// 获取memo列表
app.get('/', async (c) => {
  try {
    const db = c.env.DB;

    let creatorId = c.req.query('creatorId');
    const creatorUsername = c.req.query('creatorUsername');
    const rowStatus = c.req.query('rowStatus');
    const visibility = c.req.query('visibility');

    // 搜索参数
    const searchText = c.req.query('text');
    const searchTag = c.req.query('tag');
    const dateFrom = c.req.query('dateFrom') ? parseInt(c.req.query('dateFrom')) : null;
    const dateTo = c.req.query('dateTo') ? parseInt(c.req.query('dateTo')) : null;

    const authError = await authenticateIfPresent(c);
    if (authError) return authError;
    const currentUser = c.get('user') || null;

    // 如果提供了 creatorUsername，转换为 creatorId
    if (creatorUsername && !creatorId) {
      const userStmt = db.prepare('SELECT id FROM users WHERE username = ?');
      const user = await userStmt.bind(creatorUsername).first();
      if (!user) return jsonResponse([]);
      creatorId = user.id.toString();
    }

    // 获取 Worker URL
    const workerUrl = new URL(c.req.url).origin;

    let limit, offset;
    try {
      ({ limit, offset } = parsePagination(c.req, currentUser && rowStatus ? -1 : 20));
    } catch {
      return errorResponse('Invalid pagination', 400);
    }
    if (rowStatus && !['NORMAL', 'ARCHIVED'].includes(rowStatus)) {
      return errorResponse('Invalid rowStatus', 400);
    }
    if (rowStatus === 'ARCHIVED' && !currentUser) {
      return errorResponse('Authentication required for archived memos', 401);
    }

    // 检查是否禁用公共备忘录
    const disablePublicMemosStmt = db.prepare("SELECT value FROM settings WHERE key = 'disable-public-memos'");
    const disablePublicMemosSetting = await disablePublicMemosStmt.first();
    const isPublicMemosDisabled = disablePublicMemosSetting?.value === 'true';

    // 如果禁用了公共备忘录且用户未登录，返回空列表
    if (isPublicMemosDisabled && !currentUser) {
      return jsonResponse([]);
    }

    // 构建动态查询条件
    let whereConditions = [];
    let whereValues = [];
    let needsTagJoin = false;

    // 默认条件
    if (!rowStatus) {
      whereConditions.push('m.row_status = ?');
      whereValues.push('NORMAL');
    } else {
      whereConditions.push('m.row_status = ?');
      whereValues.push(rowStatus);
    }

    // 搜索条件：文本搜索
    if (searchText) {
      whereConditions.push('m.content LIKE ?');
      whereValues.push(`%${searchText}%`);
    }

    // 搜索条件：标签搜索
    if (searchTag) {
      needsTagJoin = true;
      whereConditions.push('t.name = ?');
      whereValues.push(searchTag);
    }

    // 搜索条件：日期范围
    if (dateFrom) {
      whereConditions.push('m.display_ts >= ?');
      whereValues.push(dateFrom);
    }
    if (dateTo) {
      whereConditions.push('m.display_ts <= ?');
      whereValues.push(dateTo);
    }

    // Apply access control independently of requested visibility filters.
    if (creatorId) {
      whereConditions.push('m.creator_id = ?');
      whereValues.push(creatorId);
    } else if (currentUser && rowStatus && c.req.query('limit') === undefined) {
      // Unpaginated personal sync defaults to this account. Explicit Web pages
      // keep their existing feed behavior; Explore also has /all.
      whereConditions.push('m.creator_id = ?');
      whereValues.push(currentUser.id);
    }
    if (currentUser) {
      whereConditions.push('(m.creator_id = ? OR (m.row_status = ? AND m.visibility IN (?, ?)))');
      whereValues.push(currentUser.id, 'NORMAL', 'PUBLIC', 'PROTECTED');
    } else {
      whereConditions.push('m.visibility = ?');
      whereValues.push('PUBLIC');
    }
    if (visibility) {
      whereConditions.push('m.visibility = ?');
      whereValues.push(visibility);
    }

    const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';

    // 读取系统设置：是否按更新时间排序
    const settingStmt = db.prepare(`SELECT value FROM settings WHERE key = ?`);
    const settingResult = await settingStmt.bind('memo-display-with-updated-ts').first();
    const useUpdatedTime = settingResult?.value === 'true';

    // 根据设置决定排序字段
    const sortField = useUpdatedTime ? 'm.updated_ts' : 'm.display_ts';

    // 使用 LEFT JOIN 一次性获取所有 memo 和资源,避免 N+1 查询
    // 如果需要标签搜索，添加标签表 JOIN
    const tagJoinClause = needsTagJoin
      ? `LEFT JOIN memo_tags mt ON m.id = mt.memo_id
         LEFT JOIN tags t ON mt.tag_id = t.id`
      : '';

    const stmt = db.prepare(`
      WITH selected_memos AS (
        SELECT ${needsTagJoin ? 'DISTINCT' : ''} m.* FROM memos m
        ${tagJoinClause}
        ${whereClause}
        ORDER BY m.pinned DESC, ${sortField} DESC, m.id DESC
        LIMIT ? OFFSET ?
      )
      SELECT ${needsTagJoin ? 'DISTINCT' : ''}
        m.id,
        m.row_status as rowStatus,
        m.creator_id as creatorId,
        m.created_ts as createdTs,
        m.updated_ts as updatedTs,
        m.display_ts as displayTs,
        m.content,
        m.visibility,
        m.pinned,
        m.parent_id as parent,
        u.nickname as creatorName,
        u.username as creatorUsername,
        u.email as creatorEmail,
        r.id as resourceId,
        r.creator_id as resourceCreatorId,
        r.filename as resourceFilename,
        r.filepath as resourceFilepath,
        r.type as resourceType,
        r.size as resourceSize,
        r.created_ts as resourceCreatedTs
      FROM selected_memos m
      LEFT JOIN users u ON m.creator_id = u.id
      LEFT JOIN memo_resources mr ON m.id = mr.memo_id
      LEFT JOIN resources r ON mr.resource_id = r.id
      ORDER BY m.pinned DESC, ${sortField} DESC, m.id DESC, r.id ASC
    `);

    // 绑定参数
    const bindValues = [...whereValues, limit, offset];
    const { results: rawResults } = await stmt.bind(...bindValues).all();

    // 合并结果,将资源组合到对应的 memo 中
    const memosMap = new Map();

    for (const row of rawResults) {
      if (!memosMap.has(row.id)) {
        memosMap.set(row.id, {
          id: row.id,
          rowStatus: row.rowStatus,
          creatorId: row.creatorId,
          creatorID: row.creatorId,
          createdTs: row.createdTs,
          updatedTs: row.updatedTs,
          displayTs: row.displayTs,
          content: row.content,
          visibility: row.visibility,
          pinned: Boolean(row.pinned),
          parent: row.parent,
          parentID: row.parent,
          creatorName: row.creatorName,
          creatorUsername: row.creatorUsername,
          creatorEmail: row.creatorEmail,
          resourceList: [],
          relationList: []
        });
      }

      // 添加资源到列表
      if (row.resourceId) {
        const memo = memosMap.get(row.id);

        memo.resourceList.push({
          id: row.resourceId,
          creatorId: row.resourceCreatorId,
          creatorID: row.resourceCreatorId,
          createdTs: row.resourceCreatedTs,
          updatedTs: row.resourceCreatedTs,
          filename: row.resourceFilename,
          externalLink: `${workerUrl}/api/v1/resource/${row.resourceId}/file`,
          type: row.resourceType,
          size: row.resourceSize
        });
      }
    }

    // 转换为数组并限制数量
    const results = Array.from(memosMap.values());

    await attachMemoMetadata(db, results);

    // 隐藏邮箱地址保护隐私，但保留emailHash用于头像
    for (const memo of results) {
      if (memo.creatorEmail) {
        // 计算email的MD5 hash用于Gravatar头像
        const emailLower = memo.creatorEmail.toLowerCase().trim();
        memo.creatorEmailHash = simpleMD5(emailLower);
      }
      delete memo.creatorEmail;
    }

    // 直接返回数组，不包装在 data 中
    return jsonResponse(results);
  } catch (error) {
    console.error('Error fetching memos:', error);
    return errorResponse('Failed to fetch memos', 500);
  }
});

// 搜索memo - 无需权限
app.get('/search', async (c) => {
  try {
    const db = c.env.DB;
    const query = c.req.query('q');
    const searchContent = c.req.query('content') === 'true';
    const searchTags = c.req.query('tags') === 'true';
    const searchUsername = c.req.query('username') === 'true';

    if (!query) {
      return errorResponse('Search query is required');
    }

    const searchPattern = `%${query}%`;
    let memoIds = new Set();

    // 搜索内容
    if (searchContent) {
      const contentStmt = db.prepare(`
        SELECT id FROM memos
        WHERE content LIKE ? AND row_status = 'NORMAL' AND visibility = 'PUBLIC'
      `);
      const { results } = await contentStmt.bind(searchPattern).all();
      results.forEach(r => memoIds.add(r.id));
    }

    // 搜索标签
    if (searchTags) {
      const tagStmt = db.prepare(`
        SELECT mt.memo_id
        FROM memo_tags mt
        JOIN tags t ON mt.tag_id = t.id
        JOIN memos m ON mt.memo_id = m.id
        WHERE t.name LIKE ? AND m.row_status = 'NORMAL' AND m.visibility = 'PUBLIC'
      `);
      const { results } = await tagStmt.bind(searchPattern).all();
      results.forEach(r => memoIds.add(r.memo_id));
    }

    // 搜索用户名
    if (searchUsername) {
      const userStmt = db.prepare(`
        SELECT m.id
        FROM memos m
        JOIN users u ON m.creator_id = u.id
        WHERE (u.username LIKE ? OR u.nickname LIKE ?)
        AND m.row_status = 'NORMAL' AND m.visibility = 'PUBLIC'
      `);
      const { results } = await userStmt.bind(searchPattern, searchPattern).all();
      results.forEach(r => memoIds.add(r.id));
    }

    if (memoIds.size === 0) {
      return jsonResponse([]);
    }

    // 读取系统设置：是否按更新时间排序
    const settingStmt2 = db.prepare(`SELECT value FROM settings WHERE key = ?`);
    const settingResult2 = await settingStmt2.bind('memo-display-with-updated-ts').first();
    const useUpdatedTime = settingResult2?.value === 'true';

    // 根据设置决定排序字段
    const sortField = useUpdatedTime ? 'm.updated_ts' : 'm.display_ts';

    // 获取memo详情
    const memoIdsArray = Array.from(memoIds);
    const placeholders = memoIdsArray.map(() => '?').join(',');

    const stmt = db.prepare(`
      SELECT
        m.id,
        m.row_status as rowStatus,
        m.creator_id as creatorId,
        m.created_ts as createdTs,
        m.updated_ts as updatedTs,
        m.display_ts as displayTs,
        m.content,
        m.visibility,
        m.pinned,
        m.parent_id as parent,
        u.nickname as creatorName,
        u.username as creatorUsername,
        u.email as creatorEmail
      FROM memos m
      LEFT JOIN users u ON m.creator_id = u.id
      WHERE m.id IN (${placeholders})
      ORDER BY m.pinned DESC, ${sortField} DESC
    `);

    const { results: memos } = await stmt.bind(...memoIdsArray).all();

    // 获取每个memo的资源和标签
    for (const memo of memos) {
      // 获取资源
      const resourceStmt = db.prepare(`
        SELECT r.id, r.filename, r.filepath, r.type, r.size
        FROM resources r
        JOIN memo_resources mr ON r.id = mr.resource_id
        WHERE mr.memo_id = ?
      `);
      const { results: resources } = await resourceStmt.bind(memo.id).all();
      memo.resourceList = (resources || []).map(r => ({
        ...r,
        filepath: r.filepath.startsWith('http') || r.filepath.startsWith('/api/')
          ? r.filepath
          : `/api/v1/resource/${r.id}/file`
      }));

      // 获取标签
      const tagStmt = db.prepare(`
        SELECT t.id, t.name
        FROM tags t
        JOIN memo_tags mt ON t.id = mt.tag_id
        WHERE mt.memo_id = ?
      `);
      const { results: tags } = await tagStmt.bind(memo.id).all();
      memo.tagList = tags || [];

      // 计算email hash用于头像
      if (memo.creatorEmail) {
        const emailLower = memo.creatorEmail.toLowerCase().trim();
        memo.creatorEmailHash = simpleMD5(emailLower);
      }
      delete memo.creatorEmail;
      memo.pinned = Boolean(memo.pinned);
    }

    return jsonResponse(memos);
  } catch (error) {
    console.error('Error searching memos:', error);
    return errorResponse('Failed to search memos', 500);
  }
});

// 获取用户memo统计信息 - 无需权限
app.get('/stats', async (c) => {
  try {
    const db = c.env.DB;
    const creatorId = c.req.query('creatorId');
    const creatorUsername = c.req.query('creatorUsername');

    if (!creatorId && !creatorUsername) {
      return errorResponse('creatorId or creatorUsername parameter is required', 400);
    }

    let userId = creatorId;

    // 如果提供的是 username，先查找对应的 user ID
    if (creatorUsername && !creatorId) {
      const userStmt = db.prepare('SELECT id FROM users WHERE username = ?');
      const user = await userStmt.bind(creatorUsername).first();

      if (!user) {
        return errorResponse('User not found', 404);
      }

      userId = user.id;
    } else if (creatorId) {
      // 验证用户是否存在
      const userStmt = db.prepare('SELECT id FROM users WHERE id = ?');
      const user = await userStmt.bind(creatorId).first();

      if (!user) {
        return errorResponse('User not found', 404);
      }
    }

    // 获取用户的所有memo创建时间戳，按时间倒序排列
    const stmt = db.prepare(`
      SELECT created_ts as createdTs
      FROM memos
      WHERE creator_id = ? AND row_status = 'NORMAL'
      ORDER BY created_ts DESC
    `);

    const { results } = await stmt.bind(userId).all();

    // 只返回时间戳数组
    const timestamps = results.map(memo => memo.createdTs);

    return jsonResponse(timestamps);
  } catch (error) {
    console.error('Error fetching memo stats:', error);
    return errorResponse('Failed to fetch memo stats', 500);
  }
});

/**
 * GET /api/v1/memo/all - 获取所有公开的 memos（用于 Explore 页面）
 * 查询参数：
 * - limit: 返回的 memo 数量限制（默认: 20）
 * - offset: 偏移量（默认: 0）
 * - creatorUsername: 按创建者用户名筛选（可选）
 *
 * 返回所有 visibility 不是 PRIVATE 的 memos
 * 注意：必须放在 /:id 之前，否则会被 /:id 路由匹配
 */
app.get('/all', async (c) => {
  try {
    const db = c.env.DB;

    let limit, offset;
    try {
      ({ limit, offset } = parsePagination(c.req));
    } catch {
      return errorResponse('Invalid pagination', 400);
    }
    const creatorUsername = c.req.query('creatorUsername');

    // 获取 Worker URL
    const workerUrl = new URL(c.req.url).origin;

    const authError = await authenticateIfPresent(c);
    if (authError) return authError;
    const currentUser = c.get('user') || null;

    // 检查是否禁用公共备忘录
    const disablePublicMemosStmt = db.prepare("SELECT value FROM settings WHERE key = 'disable-public-memos'");
    const disablePublicMemosSetting = await disablePublicMemosStmt.first();
    const isPublicMemosDisabled = disablePublicMemosSetting?.value === 'true';

    // 如果禁用了公共备忘录且用户未登录，返回空列表
    if (isPublicMemosDisabled && !currentUser) {
      return jsonResponse([]);
    }

    // 构建动态查询条件
    let whereConditions = ['m.row_status = ?', currentUser ? 'm.visibility IN (?, ?)' : 'm.visibility = ?'];
    let whereValues = currentUser ? ['NORMAL', 'PUBLIC', 'PROTECTED'] : ['NORMAL', 'PUBLIC'];

    // 按创建者用户名筛选
    if (creatorUsername) {
      whereConditions.push('u.username = ?');
      whereValues.push(creatorUsername);
    }

    const whereClause = whereConditions.join(' AND ');

    // 读取系统设置：是否按更新时间排序
    const settingStmt = db.prepare(`SELECT value FROM settings WHERE key = ?`);
    const settingResult = await settingStmt.bind('memo-display-with-updated-ts').first();
    const useUpdatedTime = settingResult?.value === 'true';

    // 根据设置决定排序字段
    const sortField = useUpdatedTime ? 'm.updated_ts' : 'm.created_ts';

    // 使用 LEFT JOIN 查询 memos 和资源
    const stmt = db.prepare(`
      WITH selected_memos AS (
        SELECT m.* FROM memos m
        LEFT JOIN users u ON m.creator_id = u.id
        WHERE ${whereClause}
        ORDER BY ${sortField} DESC, m.id DESC
        LIMIT ? OFFSET ?
      )
      SELECT
        m.id,
        m.creator_id,
        m.content,
        m.visibility,
        m.pinned,
        m.created_ts,
        m.updated_ts,
        m.row_status,
        u.id as user_id,
        u.username,
        u.nickname,
        u.email,
        r.id as resourceId,
        r.creator_id as resourceCreatorId,
        r.filename as resourceFilename,
        r.filepath as resourceFilepath,
        r.type as resourceType,
        r.size as resourceSize,
        r.created_ts as resourceCreatedTs
      FROM selected_memos m
      LEFT JOIN users u ON m.creator_id = u.id
      LEFT JOIN memo_resources mr ON m.id = mr.memo_id
      LEFT JOIN resources r ON mr.resource_id = r.id
      ORDER BY ${sortField} DESC, m.id DESC, r.id ASC
    `);

    const { results: rawResults } = await stmt.bind(...whereValues, limit, offset).all();

    // 合并结果，将资源组合到对应的 memo 中
    const memosMap = new Map();

    for (const row of rawResults) {
      if (!memosMap.has(row.id)) {
        // 生成 Gravatar URL
        const emailHash = simpleMD5((row.email || '').toLowerCase().trim());
        const gravatarUrl = `https://gravatar.loli.net/avatar/${emailHash}?d=mp`;

        memosMap.set(row.id, {
          id: row.id,
          creatorId: row.creator_id,
          creatorID: row.creator_id,
          createdTs: row.created_ts,
          updatedTs: row.updated_ts,
          displayTs: row.created_ts,
          content: row.content,
          visibility: row.visibility,
          pinned: Boolean(row.pinned),
          rowStatus: row.row_status,
          creatorUsername: row.username,
          creatorName: row.nickname || row.username,
          resourceList: [],
          relationList: [],
          creator: {
            id: row.user_id,
            username: row.username,
            nickname: row.nickname,
            email: row.email || '',
            avatarUrl: gravatarUrl
          }
        });
      }

      // 添加资源到列表
      if (row.resourceId) {
        const memo = memosMap.get(row.id);
        memo.resourceList.push({
          id: row.resourceId,
          creatorId: row.resourceCreatorId,
          creatorID: row.resourceCreatorId,
          createdTs: row.resourceCreatedTs,
          updatedTs: row.resourceCreatedTs,
          filename: row.resourceFilename,
          externalLink: `${workerUrl}/api/v1/resource/${row.resourceId}/file`,
          type: row.resourceType,
          size: row.resourceSize
        });
      }
    }

    // 转换为数组并限制数量
    const memos = Array.from(memosMap.values());

    return c.json(memos);
  } catch (error) {
    console.error('Error fetching all memos:', error);
    return errorResponse('Failed to fetch memos', 500);
  }
});

// 获取单个memo详情
async function getMemo(c, id = c.req.param('id'), alreadyAuthorized = false) {
  try {
    const db = c.env.DB;

    // 使用 LEFT JOIN 一次性获取 memo 和所有资源
    const stmt = db.prepare(`
      SELECT
        m.id,
        m.row_status as rowStatus,
        m.creator_id as creatorId,
        m.created_ts as createdTs,
        m.updated_ts as updatedTs,
        m.display_ts as displayTs,
        m.content,
        m.visibility,
        m.pinned,
        m.parent_id as parent,
        u.nickname as creatorName,
        u.username as creatorUsername,
        u.email as creatorEmail,
        r.id as resourceId,
        r.creator_id as resourceCreatorId,
        r.filename as resourceFilename,
        r.filepath as resourceFilepath,
        r.type as resourceType,
        r.size as resourceSize,
        r.created_ts as resourceCreatedTs
      FROM memos m
      LEFT JOIN users u ON m.creator_id = u.id
      LEFT JOIN memo_resources mr ON m.id = mr.memo_id
      LEFT JOIN resources r ON mr.resource_id = r.id
      WHERE m.id = ?
    `);

    const { results: rawResults } = await stmt.bind(id).all();

    if (!rawResults || rawResults.length === 0) {
      return errorResponse('Memo not found', 404);
    }

    // 构建 memo 对象
    const firstRow = rawResults[0];

    const authError = await authenticateIfPresent(c);
    if (authError) return authError;
    const currentUser = c.get('user') || null;

    // 检查是否禁用公共备忘录
    const disablePublicMemosStmt = db.prepare("SELECT value FROM settings WHERE key = 'disable-public-memos'");
    const disablePublicMemosSetting = await disablePublicMemosStmt.first();
    const isPublicMemosDisabled = disablePublicMemosSetting?.value === 'true';

    // 如果禁用了公共备忘录且用户未登录，拒绝访问
    if (isPublicMemosDisabled && !currentUser) {
      return errorResponse('Access denied. Please login to view memos.', 403);
    }

    if (!alreadyAuthorized && firstRow.rowStatus === 'ARCHIVED' && (!currentUser || currentUser.id !== firstRow.creatorId)) {
      return errorResponse('Memo not found', 404);
    }
    if (!alreadyAuthorized && firstRow.visibility === 'PROTECTED' && !currentUser) {
      return errorResponse('Authentication required', 401);
    }

    // 如果 memo 是私密的，只有创建者可以查看
    if (!alreadyAuthorized && firstRow.visibility === 'PRIVATE' && (!currentUser || currentUser.id !== firstRow.creatorId)) {
      return errorResponse('Access denied. This memo is private.', 403);
    }

    const memo = {
      id: firstRow.id,
      rowStatus: firstRow.rowStatus,
      creatorId: firstRow.creatorId,
      creatorID: firstRow.creatorId,
      createdTs: firstRow.createdTs,
      updatedTs: firstRow.updatedTs,
      displayTs: firstRow.displayTs,
      content: firstRow.content,
      visibility: firstRow.visibility,
      pinned: Boolean(firstRow.pinned),
      parent: firstRow.parent,
      parentID: firstRow.parent,
      creatorName: firstRow.creatorName,
      creatorUsername: firstRow.creatorUsername,
      creatorEmail: firstRow.creatorEmail,
      resourceList: [],
      relationList: []
    };

    // 添加所有资源
    for (const row of rawResults) {
      if (row.resourceId) {
        memo.resourceList.push({
          id: row.resourceId,
          creatorId: row.resourceCreatorId,
          creatorID: row.resourceCreatorId,
          createdTs: row.resourceCreatedTs,
          updatedTs: row.resourceCreatedTs,
          filename: row.resourceFilename,
          externalLink: `${new URL(c.req.url).origin}/api/v1/resource/${row.resourceId}/file`,
          type: row.resourceType,
          size: row.resourceSize
        });
      }
    }

    // 获取标签
    const tagStmt = db.prepare(`
      SELECT t.id, t.name
      FROM tags t
      JOIN memo_tags mt ON t.id = mt.tag_id
      WHERE mt.memo_id = ?
    `);
    const { results: tags } = await tagStmt.bind(id).all();
    memo.tagList = tags || [];

    // 获取关系（评论和引用）
    const relationStmt = db.prepare(`
      SELECT
        mr.id,
        mr.memo_id as memoId,
        mr.related_memo_id as relatedMemoId,
        mr.type,
        mr.created_ts as createdTs
      FROM memo_relations mr
      WHERE mr.memo_id = ?
      ORDER BY mr.created_ts DESC
    `);
    const { results: relations } = await relationStmt.bind(id).all();
    memo.relationList = relations || [];

    // 隐藏邮箱地址保护隐私
    delete memo.creatorEmail;

    return jsonResponse(memo);
  } catch (error) {
    console.error('Error fetching memo:', error);
    return errorResponse('Failed to fetch memo', 500);
  }
}

app.get('/:id', c => getMemo(c));

// 创建memo - 需要权限
app.post('/', async (c) => {
  const authError = await requireAuth(c);
  if (authError) return authError;

  try {
    const db = c.env.DB;
    const body = await c.req.json();

    // 允许内容为空，但至少要有内容或资源
    if (!body.content && (!body.resourceIdList || body.resourceIdList.length === 0)) {
      return errorResponse('Content or resources are required');
    }
    
    // 获取当前登录用户的ID
    let creatorId = c.get('user')?.id;

    // 如果没有用户信息，说明使用的是管理员TOKEN，创建默认管理员用户
    if (!creatorId) {
      const userCheck = await db.prepare('SELECT COUNT(*) as count FROM users').first();

      if (userCheck.count === 0) {
        // 生成安全的随机密码
        const randomPassword = generateSecurePassword(16);
        const passwordHash = await hashPassword(randomPassword);

        // 创建第一个用户（管理员）
        const userStmt = db.prepare(`
          INSERT INTO users (username, nickname, password_hash, is_admin)
          VALUES (?, ?, ?, 1)
        `);
        const userResult = await userStmt.bind('admin', '管理员', passwordHash).run();
        creatorId = userResult.meta.last_row_id;

        // 记录密码到日志
        console.log('='.repeat(60));
        console.log('⚠️  IMPORTANT: Default admin user created');
        console.log('Username: admin');
        console.log(`Password: ${randomPassword}`);
        console.log('Please change this password immediately after first login!');
        console.log('='.repeat(60));
      } else {
        creatorId = 1; // 默认使用第一个用户
      }
    }

    const resourceIds = await resourceIdsForRequest(db, body.resourceIdList ?? [], creatorId);
    if (resourceIds === null) return errorResponse('Invalid or inaccessible resourceIdList', 400);
    const now = Math.floor(Date.now() / 1000);
    const createdTs = body.createdTs ?? now;
    if (!Number.isSafeInteger(createdTs) || createdTs < 0) {
      return errorResponse('Invalid createdTs', 400);
    }

    // 提取并保存标签（但保留在内容中）
    const tagNames = extractTagNamesFromMemoContent(body.content);

    const stmt = db.prepare(`
      INSERT INTO memos (creator_id, content, visibility, created_ts, updated_ts, display_ts)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const result = await stmt.bind(
      creatorId,
      body.content || '', // 保留原始内容，包括 tag
      body.visibility || 'PUBLIC',
      createdTs,
      now,
      createdTs
    ).run();

    const memoId = result.meta.last_row_id;

    // 保存标签
    for (const tagName of tagNames) {
      await attachTagToMemo(db, memoId, tagName, creatorId);
    }

    if (resourceIds.length) {
      await db.batch(resourceIds.map(resourceId => db.prepare(
        'INSERT INTO memo_resources (memo_id, resource_id) VALUES (?, ?)'
      ).bind(memoId, resourceId)));
    }

    // 获取创建者信息用于通知
    const userStmt = db.prepare('SELECT id, username, nickname FROM users WHERE id = ?');
    const creator = await userStmt.bind(creatorId).first();

    // 发送通知（异步，不阻塞响应）
    const notificationData = {
      id: memoId,
      content: body.content || '',
      visibility: body.visibility || 'PUBLIC',
      creatorId: creatorId,
      creatorUsername: creator?.username || 'unknown',
      creatorName: creator?.nickname || creator?.username || 'unknown',
      createdTs: now,
      tags: tagNames,
      resourceCount: resourceIds.length,
    };

    console.log('📝 Memo created, preparing to send notifications:', {
      memoId,
      visibility: notificationData.visibility,
      creatorId: notificationData.creatorId,
      creatorUsername: notificationData.creatorUsername
    });

    // 异步发送通知，不等待结果
    c.executionCtx.waitUntil(
      sendAllNotifications(db, notificationData).catch(err => {
        console.error('❌ Notification error in waitUntil:', err);
      })
    );

    return getMemo(c, memoId, true);
  } catch (error) {
    console.error('Error creating memo:', error);
    return errorResponse('Failed to create memo', 500);
  }
});

// 部分修改memo - 需要权限和所有权 (支持归档等操作)
app.patch('/:id', async (c) => {
  const authError = await requireAuth(c);
  if (authError) return authError;

  try {
    const db = c.env.DB;
    const id = c.req.param('id');
    const body = await c.req.json();

    // 检查是否至少提供了一个字段
    if (['content', 'rowStatus', 'visibility', 'pinned', 'resourceIdList', 'deleteResourceIds', 'updatedTs', 'createdTs'].every(key => body[key] === undefined)) {
      return errorResponse('At least one field is required for update', 400);
    }

    // 检查memo是否存在并获取创建者信息
    const memoStmt = db.prepare(`
      SELECT creator_id
      FROM memos
      WHERE id = ?
    `);
    const memo = await memoStmt.bind(id).first();

    if (!memo) {
      return errorResponse('Memo not found', 404);
    }

    // 权限检查：只有创建者或管理员才能编辑
    const currentUser = c.get('user');
    if (!currentUser) {
      return errorResponse('User information not found', 401);
    }

    if (memo.creator_id !== currentUser.id && !currentUser.isAdmin) {
      return errorResponse('Permission denied: You can only edit your own memos', 403);
    }

    const resourceIds = body.resourceIdList === undefined ? undefined :
      await resourceIdsForRequest(db, body.resourceIdList, memo.creator_id);
    if (resourceIds === null) return errorResponse('Invalid or inaccessible resourceIdList', 400);
    for (const key of ['createdTs', 'updatedTs']) {
      if (body[key] !== undefined && (!Number.isSafeInteger(body[key]) || body[key] < 0)) {
        return errorResponse(`Invalid ${key}`, 400);
      }
    }

    // 构建更新字段
    const updateFields = ['updated_ts = ?'];
    const updateValues = [body.updatedTs ?? Math.floor(Date.now() / 1000)];

    if (body.createdTs !== undefined) {
      updateFields.push('created_ts = ?', 'display_ts = ?');
      updateValues.push(body.createdTs, body.createdTs);
    }

    // 可选字段：内容
    if (body.content !== undefined) {
      updateFields.push('content = ?');
      updateValues.push(body.content);
    }

    // 可选字段：状态
    if (body.rowStatus !== undefined) {
      updateFields.push('row_status = ?');
      updateValues.push(body.rowStatus);
    }

    // 可选字段：可见性
    if (body.visibility !== undefined) {
      updateFields.push('visibility = ?');
      updateValues.push(body.visibility);
    }

    // 可选字段：置顶状态
    if (body.pinned !== undefined) {
      updateFields.push('pinned = ?');
      updateValues.push(body.pinned ? 1 : 0);
    }

    // 执行更新
    const updateStmt = db.prepare(`
      UPDATE memos
      SET ${updateFields.join(', ')}
      WHERE id = ?
    `);

    updateValues.push(id);
    const result = await updateStmt.bind(...updateValues).run();

    if (result.changes === 0) {
      return errorResponse('Failed to update memo', 500);
    }

    if (body.content !== undefined) {
      await db.prepare(`
        DELETE FROM memo_tags
        WHERE memo_id = ?
      `).bind(id).run();

      const tagNames = extractTagNamesFromMemoContent(body.content);
      for (const tagName of tagNames) {
        await attachTagToMemo(db, id, tagName, memo.creator_id);
      }
    }

    // 处理附件：删除指定的附件
    if (body.deleteResourceIds && Array.isArray(body.deleteResourceIds)) {
      for (const resourceId of body.deleteResourceIds) {
        const deleteStmt = db.prepare(`
          DELETE FROM memo_resources
          WHERE memo_id = ? AND resource_id = ?
        `);
        await deleteStmt.bind(id, resourceId).run();
      }
    }

    // Memos 0.21 sends the complete attachment set, including [] for removal.
    if (resourceIds !== undefined) {
      await db.batch([
        db.prepare('DELETE FROM memo_resources WHERE memo_id = ?').bind(id),
        ...resourceIds.map(resourceId => db.prepare(
          'INSERT INTO memo_resources (memo_id, resource_id) VALUES (?, ?)'
        ).bind(id, resourceId)),
      ]);
    }

    return getMemo(c, id, true);
  } catch (error) {
    console.error('Error updating memo:', error);
    return errorResponse('Failed to update memo', 500);
  }
});

// 修改memo - 需要权限和所有权
app.put('/:id', async (c) => {
  const authError = await requireAuth(c);
  if (authError) return authError;

  try {
    const db = c.env.DB;
    const id = c.req.param('id');
    const body = await c.req.json();

    if (!body.content) {
      return errorResponse('Content is required');
    }

    // 检查memo是否存在并获取创建者信息
    const memoStmt = db.prepare(`
      SELECT creator_id
      FROM memos
      WHERE id = ? AND row_status = 'NORMAL'
    `);
    const memo = await memoStmt.bind(id).first();

    if (!memo) {
      return errorResponse('Memo not found', 404);
    }

    // 权限检查：只有创建者或管理员才能编辑
    const currentUser = c.get('user');
    if (!currentUser) {
      return errorResponse('User information not found', 401);
    }

    if (memo.creator_id !== currentUser.id && !currentUser.isAdmin) {
      return errorResponse('Permission denied: You can only edit your own memos', 403);
    }

    // 构建更新字段
    const updateFields = ['content = ?', 'updated_ts = ?'];
    const updateValues = [body.content, Math.floor(Date.now() / 1000)];

    // 可选字段：可见性
    if (body.visibility !== undefined) {
      updateFields.push('visibility = ?');
      updateValues.push(body.visibility);
    }

    // 可选字段：置顶状态
    if (body.pinned !== undefined) {
      updateFields.push('pinned = ?');
      updateValues.push(body.pinned ? 1 : 0);
    }

    // 执行更新
    const updateStmt = db.prepare(`
      UPDATE memos
      SET ${updateFields.join(', ')}
      WHERE id = ? AND row_status = 'NORMAL'
    `);

    updateValues.push(id);
    const result = await updateStmt.bind(...updateValues).run();

    if (result.changes === 0) {
      return errorResponse('Failed to update memo', 500);
    }

    await db.prepare(`
      DELETE FROM memo_tags
      WHERE memo_id = ?
    `).bind(id).run();

    const tagNames = extractTagNamesFromMemoContent(body.content);
    for (const tagName of tagNames) {
      await attachTagToMemo(db, id, tagName, memo.creator_id);
    }

    // 处理附件：删除指定的附件
    if (body.deleteResourceIds && Array.isArray(body.deleteResourceIds)) {
      for (const resourceId of body.deleteResourceIds) {
        const deleteStmt = db.prepare(`
          DELETE FROM memo_resources
          WHERE memo_id = ? AND resource_id = ?
        `);
        await deleteStmt.bind(id, resourceId).run();
      }
    }

    // 处理附件：添加新附件
    if (body.resourceIdList && Array.isArray(body.resourceIdList)) {
      for (const resourceId of body.resourceIdList) {
        // 检查是否已经关联，避免重复
        const checkStmt = db.prepare(`
          SELECT COUNT(*) as count
          FROM memo_resources
          WHERE memo_id = ? AND resource_id = ?
        `);
        const existing = await checkStmt.bind(id, resourceId).first();

        if (existing.count === 0) {
          const linkStmt = db.prepare(`
            INSERT INTO memo_resources (memo_id, resource_id)
            VALUES (?, ?)
          `);
          await linkStmt.bind(id, resourceId).run();
        }
      }
    }

    return jsonResponse({ message: 'Memo updated successfully' });
  } catch (error) {
    console.error('Error updating memo:', error);
    return errorResponse('Failed to update memo', 500);
  }
});

// 删除memo - 需要权限和所有权
app.delete('/:id', async (c) => {
  const authError = await requireAuth(c);
  if (authError) return authError;

  try {
    const db = c.env.DB;
    const id = c.req.param('id');
    
    // 检查memo是否存在并获取创建者信息
    const memoStmt = db.prepare(`
      SELECT creator_id, row_status
      FROM memos
      WHERE id = ?
    `);
    const memo = await memoStmt.bind(id).first();
    
    if (!memo) {
      return errorResponse('Memo not found', 404);
    }
    
    // 权限检查：只有创建者或管理员才能删除
    const currentUser = c.get('user');
    if (!currentUser) {
      return errorResponse('User information not found', 401);
    }

    if (memo.creator_id !== currentUser.id && !currentUser.isAdmin) {
      return errorResponse('Permission denied: You can only delete your own memos', 403);
    }
    
    // 执行删除：如果已归档则永久删除，否则软删除
    const now = Math.floor(Date.now() / 1000);
    let result;

    if (memo.row_status === 'ARCHIVED') {
      // 永久删除已归档的 memo
      const deleteStmt = db.prepare(`DELETE FROM memos WHERE id = ?`);
      result = await deleteStmt.bind(id).run();
    } else {
      // 软删除正常状态的 memo
      const archiveStmt = db.prepare(`
        UPDATE memos
        SET row_status = 'ARCHIVED', updated_ts = ?
        WHERE id = ?
      `);
      result = await archiveStmt.bind(now, id).run();
    }

    if (result.changes === 0) {
      return errorResponse('Failed to delete memo', 500);
    }

    return jsonResponse({
      message: memo.row_status === 'ARCHIVED' ? 'Memo permanently deleted' : 'Memo archived successfully'
    });
  } catch (error) {
    console.error('Error deleting memo:', error);
    return errorResponse('Failed to delete memo', 500);
  }
});

// 获取热力图数据 - 最近一个月的发布统计
app.get('/stats/heatmap', async (c) => {
  try {
    const db = c.env.DB;

    // 获取最近30天的日期范围
    const now = Math.floor(Date.now() / 1000);
    const thirtyDaysAgo = now - (30 * 24 * 60 * 60);

    // 查询每天的memo数量
    const stmt = db.prepare(`
      SELECT
        DATE(created_ts, 'unixepoch') as date,
        COUNT(*) as count
      FROM memos
      WHERE row_status = 'NORMAL'
        AND visibility = 'PUBLIC'
        AND created_ts >= ?
      GROUP BY DATE(created_ts, 'unixepoch')
      ORDER BY date ASC
    `);

    const { results } = await stmt.bind(thirtyDaysAgo).all();

    // 转换为日期->数量的映射
    const heatmapData = {};
    results.forEach(row => {
      heatmapData[row.date] = row.count;
    });

    return jsonResponse(heatmapData);
  } catch (error) {
    console.error('Error fetching heatmap data:', error);
    return errorResponse('Failed to fetch heatmap data', 500);
  }
});

/**
 * POST /api/v1/memo/:id/organizer - 置顶/取消置顶memo
 * 参考 Memos: POST /api/v1/memo/{memoId}/organizer
 *
 * Body:
 * {
 *   "pinned": true/false
 * }
 */
app.post('/:id/organizer', async (c) => {
  const authError = await requireAuth(c);
  if (authError) return authError;

  try {
    const db = c.env.DB;
    const id = c.req.param('id');
    const body = await c.req.json();

    if (body.pinned === undefined) {
      return errorResponse('pinned field is required', 400);
    }

    // 检查memo是否存在并获取创建者信息
    const memoStmt = db.prepare(`
      SELECT creator_id
      FROM memos
      WHERE id = ? AND row_status = 'NORMAL'
    `);
    const memo = await memoStmt.bind(id).first();

    if (!memo) {
      return errorResponse('Memo not found', 404);
    }

    // 权限检查：只有创建者或管理员才能置顶
    const currentUser = c.get('user');
    if (!currentUser) {
      return errorResponse('User information not found', 401);
    }

    if (memo.creator_id !== currentUser.id && !['host', 'admin'].includes(currentUser.role)) {
      return errorResponse('Permission denied: You can only organize your own memos', 403);
    }

    // 更新置顶状态
    const updateStmt = db.prepare(`
      UPDATE memos
      SET pinned = ?, updated_ts = ?
      WHERE id = ? AND row_status = 'NORMAL'
    `);

    const now = Math.floor(Date.now() / 1000);
    const result = await updateStmt.bind(body.pinned ? 1 : 0, now, id).run();

    if (result.changes === 0) {
      return errorResponse('Failed to update memo organizer', 500);
    }

    return getMemo(c, id, true);
  } catch (error) {
    console.error('Error updating memo organizer:', error);
    return errorResponse('Failed to update memo organizer', 500);
  }
});

export default app;
