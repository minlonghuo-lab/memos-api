import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

let app;
before(async () => {
  const bundle = await build({ entryPoints: ['src/server/index.js'], bundle: true,
    write: false, format: 'esm', platform: 'browser' });
  app = (await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)).default;
});

// Request mocks run the actual Worker/Hono middleware without requiring workerd.
// Miniflare compatibility tests separately exercise real D1/R2 and uploads.
function fixture({ visibility = 'PRIVATE', status = 'NORMAL', linked = true, disabled = false, external = false } = {}) {
  const resource = { id: 1, creator_id: 1, filename: '项目.pdf', filepath: external ? 'https://files.example.test/document.pdf?stored=1' : '1_1000.pdf', type: 'application/pdf', size: 9, created_ts: 1 };
  const memos = linked ? [{ creator_id: 1, row_status: status, visibility }] : [];
  const storage = [];
  const DB = { prepare(sql) {
    let values;
    const stmt = { bind(...args) { values = args; return stmt; }, async first() {
      if (sql.includes('FROM sessions')) return null;
      if (sql.includes('FROM api_tokens')) {
        const id = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)].indexOf(values[0]) + 1;
        return id ? { user_id: id, username: `user${id}`, is_admin: id === 3, role: id === 3 ? 'admin' : 'user', expires_ts: null } : null;
      }
      if (sql.includes('FROM resources')) {
        return (sql.includes('WHERE filepath') ? values[0] === resource.filepath : String(values[0]) === '1') ? { ...resource } : null;
      }
      if (sql.includes('FROM settings')) return { value: disabled ? 'true' : 'false' };
      throw new Error(`Unexpected query: ${sql}`);
    }, async all() {
      if (sql.includes('FROM memo_resources')) return { results: memos };
      throw new Error(`Unexpected query: ${sql}`);
    } };
    return stmt;
  } };
  const BUCKET = {
    async head(key) { storage.push(['head', key]); return { size: 9, httpEtag: '"test"' }; },
    async get(key, options) {
      storage.push(['get', key]);
      const text = options?.range ? 'first PDF'.slice(options.range.offset, options.range.offset + options.range.length) : 'first PDF';
      return { body: text, size: 9, httpEtag: '"test"' };
    },
  };
  return { resource, memos, storage, async request(path = '/api/v1/resource/1/file', { user, method = 'GET', headers = {}, query = '' } = {}) {
    if (user) headers = { ...headers, Authorization: `Bearer ${String.fromCharCode(96 + user).repeat(64)}` };
    return app.fetch(new Request(`http://localhost${path}${query}`, { method, headers }),
      { DB, BUCKET, ASSETS: { fetch: () => new Response('asset') } }, { waitUntil() {} });
  } };
}
const paths = ['/api/v1/resource/1/file', '/api/v1/resource/1', '/o/r/1/项目.pdf', '/1_1000.pdf'];
function privateCache(response) {
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('cdn-cache-control'), 'no-store');
  assert.equal(response.headers.get('cloudflare-cdn-cache-control'), 'no-store');
  assert.match(response.headers.get('vary'), /Authorization/);
  assert.match(response.headers.get('vary'), /X-Token/);
}

test('private, protected, archived and orphan resource paths deny anonymous reads before R2', async () => {
  for (const options of [{}, { visibility: 'PROTECTED' }, { visibility: 'PUBLIC', status: 'ARCHIVED' }, { linked: false }]) {
    const f = fixture(options);
    for (const path of paths) {
      for (const method of ['GET', 'HEAD']) {
        const response = await f.request(path, { method, headers: { Range: 'bytes=0-2' } });
        assert.equal(response.status, 404, path); privateCache(response);
        const body = await response.text();
        assert.ok(!body.includes(f.resource.filepath));
      }
    }
    assert.deepEqual(f.storage, []);
  }
});

test('owner reads private, archived and orphan resources, not other users or administrators', async () => {
  for (const options of [{}, { status: 'ARCHIVED' }, { linked: false }]) {
    const f = fixture(options);
    for (const path of paths) {
      for (const user of [2, 3]) {
        const denied = await f.request(path, { user });
        assert.equal(denied.status, 404); privateCache(denied);
      }
      const allowed = await f.request(path, { user: 1 });
      assert.equal(allowed.status, 200); privateCache(allowed);
    }
  }
});

test('normal public resources support anonymous metadata, HEAD, range, If-Range and 416 on every file path', async () => {
  const f = fixture({ visibility: 'PUBLIC' });
  const metadata = await f.request('/api/v1/resource/1');
  assert.equal(metadata.status, 200); privateCache(metadata);
  for (const path of paths.filter(p => p !== '/api/v1/resource/1')) {
    const full = await f.request(path);
    assert.equal(full.status, 200); assert.equal(await full.text(), 'first PDF');
    assert.equal(full.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
    assert.equal(full.headers.get('cloudflare-cdn-cache-control'), 'no-store');
    const head = await f.request(path, { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), '9'); assert.equal(await head.text(), '');
    const range = await f.request(path, { headers: { Range: 'bytes=1-3' } });
    assert.equal(range.status, 206); assert.equal(await range.text(), 'irs');
    assert.equal(range.headers.get('content-range'), 'bytes 1-3/9');
    const suffix = await f.request(path, { headers: { Range: 'bytes=-3' } });
    assert.equal(await suffix.text(), 'PDF');
    assert.equal((await f.request(path, { headers: { Range: 'bytes=1-3', 'If-Range': '"stale"' } })).status, 200);
    const invalid = await f.request(path, { headers: { Range: 'bytes=999-' } });
    assert.equal(invalid.status, 416); privateCache(invalid);
    privateCache(await f.request(path, { user: 1 }));
  }
});

test('protected normal resources require a user token and disablePublic blocks anonymous public resources', async () => {
  for (const options of [{ visibility: 'PROTECTED' }, { visibility: 'PUBLIC', disabled: true }]) {
    const f = fixture(options);
    for (const path of paths) {
      assert.equal((await f.request(path)).status, 404);
      const response = await f.request(path, { user: 2 });
      assert.equal(response.status, 200); privateCache(response);
    }
  }
});

test('invalid supplied credentials never fall back to the public subset or touch R2', async () => {
  const f = fixture({ visibility: 'PUBLIC' });
  for (const path of paths) {
    for (const options of [{ headers: { Authorization: 'Bearer invalid-token' } },
      { headers: { 'X-Token': 'd'.repeat(64) } }, { query: '?token=invalid-token' }]) {
      const response = await f.request(path, options);
      assert.equal(response.status, 401); privateCache(response);
    }
  }
  assert.deepEqual(f.storage, []);
});

test('external redirects are authorized first and do not forward request tokens', async () => {
  const f = fixture({ external: true });
  for (const path of ['/api/v1/resource/1', '/api/v1/resource/1/file', '/o/r/1/document.pdf']) {
    const denied = await f.request(path);
    assert.equal(denied.status, 404); assert.equal(denied.headers.get('location'), null); privateCache(denied);
    const allowed = await f.request(path, { query: `?token=${'a'.repeat(64)}` });
    assert.equal(allowed.status, 302); privateCache(allowed);
    assert.equal(allowed.headers.get('location'), f.resource.filepath);
    assert.ok(!allowed.headers.get('location').includes('token='));
  }
  assert.deepEqual(f.storage, []);
});

test('visibility, archival and last-unlink changes revoke anonymous reads without cached private responses', async () => {
  const f = fixture({ visibility: 'PUBLIC' });
  for (const update of [
    () => { f.memos[0].visibility = 'PRIVATE'; },
    () => { f.memos[0].visibility = 'PUBLIC'; f.memos[0].row_status = 'ARCHIVED'; },
    () => { f.memos.length = 0; },
  ]) {
    f.memos[0] = { creator_id: 1, row_status: 'NORMAL', visibility: 'PUBLIC' };
    for (const path of paths) assert.equal((await f.request(path)).status, 200);
    update();
    const calls = f.storage.length;
    for (const path of paths) {
      const denied = await f.request(path, { headers: { 'If-None-Match': '"test"', Range: 'bytes=0-2' } });
      assert.equal(denied.status, 404); privateCache(denied);
    }
    assert.equal(f.storage.length, calls);
  }
});

test('one normal public association permits access despite private/archive associations; memo owners retain reads', async () => {
  const f = fixture();
  f.memos.push({ creator_id: 2, row_status: 'ARCHIVED', visibility: 'PRIVATE' });
  assert.equal((await f.request('/api/v1/resource/1/file', { user: 2 })).status, 200);
  f.memos.push({ creator_id: 1, row_status: 'NORMAL', visibility: 'PUBLIC' });
  assert.equal((await f.request()).status, 200);
  f.memos.pop();
  assert.equal((await f.request()).status, 404);
});

test('unregistered raw R2 keys are denied without fetching storage', async () => {
  const f = fixture({ visibility: 'PUBLIC' });
  for (const path of ['/9_9999.pdf', '/o/r/999/file.pdf', '/api/v1/resource/999/file']) {
    const response = await f.request(path);
    assert.equal(response.status, 404); privateCache(response);
  }
  assert.deepEqual(f.storage, []);
});
