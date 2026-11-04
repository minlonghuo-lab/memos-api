import { authenticateIfPresent, errorResponse } from './auth';

// Resolve permissions before touching R2 or exposing a stored external URL.
export async function readableResource(c, { filepath } = {}) {
  const authError = await authenticateIfPresent(c);
  if (authError) return { error: authError };

  const resource = await c.env.DB.prepare(`
    SELECT id, creator_id, filename, filepath, type, size, created_ts
    FROM resources WHERE ${filepath === undefined ? 'id' : 'filepath'} = ?
  `).bind(filepath === undefined ? c.req.param('id') : filepath).first();
  if (!resource) return { error: errorResponse('Resource not found', 404) };

  const { results: memos } = await c.env.DB.prepare(`
    SELECT m.creator_id, m.row_status, m.visibility
    FROM memo_resources mr JOIN memos m ON m.id = mr.memo_id
    WHERE mr.resource_id = ?
  `).bind(resource.id).all();
  const setting = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'disable-public-memos'").first();
  const user = c.get('user');
  const publicMemo = memos.some(m => m.row_status === 'NORMAL' && m.visibility === 'PUBLIC');
  const isPublic = publicMemo && setting?.value !== 'true';
  const allowed = isPublic || (user && (
    resource.creator_id === user.id || memos.some(m =>
      m.creator_id === user.id || (m.row_status === 'NORMAL' && ['PUBLIC', 'PROTECTED'].includes(m.visibility))
    )
  ));
  // No administrator bypass: private memo reads are owner-only too.
  if (!allowed) return { error: errorResponse('Resource not found', 404) };
  return { resource, isPublic: isPublic && !user };
}

export function setResourceCacheHeaders(c, publicFile = false) {
  const headers = new Headers(c.res.headers);
  // Public files must be revalidated: visibility/associations can change at any time.
  headers.set('Cache-Control', publicFile ? 'public, max-age=0, must-revalidate' : 'private, no-store');
  headers.set('CDN-Cache-Control', 'no-store');
  headers.set('Cloudflare-CDN-Cache-Control', 'no-store');
  const vary = new Set((headers.get('Vary') || '').split(',').map(v => v.trim()).filter(Boolean));
  for (const name of ['Authorization', 'X-Token', 'Cookie']) vary.add(name);
  headers.set('Vary', [...vary].join(', '));
  // Hono's response setter merges old headers over new ones. Use its header API
  // instead, which also safely clones immutable redirect response headers.
  for (const name of ['Cache-Control', 'CDN-Cache-Control', 'Cloudflare-CDN-Cache-Control', 'Vary']) {
    c.header(name, headers.get(name));
  }
}
