import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

let mf, db, bucket, cache, files;
const token = 'a'.repeat(64);
const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 104, 101, 105, 99, 0, 255, 128, 1]);
let nextId = 1;
before(async () => {
  // Run the actual Worker in workerd. Only the harness counts real R2 calls;
  // D1, R2 and Cache API are NOT mocked.
  const bundle = await build({ stdin: { resolveDir: process.cwd(), contents: `
    import app from './src/server/index.js';
    let gets = 0, heads = 0;
    export default { async fetch(request, env, ctx) {
      if (new URL(request.url).pathname === '/__test/counts') return Response.json({ gets, heads });
      const BUCKET = {
        head: (...args) => { heads++; return env.BUCKET.head(...args); },
        get: (...args) => { gets++; return env.BUCKET.get(...args); },
        put: (...args) => env.BUCKET.put(...args),
        delete: (...args) => env.BUCKET.delete(...args)
      };
      return app.fetch(request, { ...env, BUCKET }, ctx);
    } };
  ` }, bundle: true, write: false, format: 'esm', platform: 'browser' });
  const helpers = await build({ entryPoints: ['src/server/utils/resourceFiles.js'], bundle: true,
    write: false, format: 'esm', platform: 'browser' });
  files = await import(`data:text/javascript;base64,${Buffer.from(helpers.outputFiles[0].text).toString('base64')}`);
  mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2024-01-15', compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'], r2Buckets: ['BUCKET'], bindings: { TOKEN: 'legacy-test-token' } });
  db = await mf.getD1Database('DB'); bucket = await mf.getR2Bucket('BUCKET');
  cache = (await mf.getCaches()).default;
  const schema = (await readFile('schema.sql', 'utf8')).replace(/--[^\n]*/g, '');
  await db.batch(schema.split(';').map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
  await db.prepare("INSERT INTO users(id,username,nickname,password_hash) VALUES(1,'owner','Owner','test')").run();
  await db.prepare("INSERT INTO api_tokens(user_id,name,token) VALUES(1,'test',?)").bind(token).run();
});
after(async () => { await mf?.dispose(); });
const fetchFile = (path, options = {}) => mf.dispatchFetch(`http://localhost${path}`, options);
const counts = async () => (await fetchFile('/__test/counts')).json();
function privateResponse(response) {
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('cdn-cache-control'), 'no-store');
  assert.equal(response.headers.get('cloudflare-cdn-cache-control'), 'no-store');
}
async function fixture({ filename = '原图.HEIC', type = 'application/octet-stream', external = false } = {}) {
  const id = nextId++;
  const filepath = external ? 'https://files.example.test/original.heic?stored=1' : `1_${800000 + id}.heic`;
  if (!external) await bucket.put(filepath, bytes);
  await db.batch([
    db.prepare('INSERT INTO resources(id,creator_id,filename,filepath,type,size) VALUES(?,1,?,?,?,?)').bind(id, filename, filepath, type, bytes.length),
    db.prepare("INSERT INTO memos(id,creator_id,content,visibility) VALUES(?,1,'cache test','PUBLIC')").bind(id),
    db.prepare('INSERT INTO memo_resources(memo_id,resource_id) VALUES(?,?)').bind(id, id),
  ]);
  const paths = [`/api/v1/resource/${id}/file`, `/o/r/${id}/${encodeURIComponent(filename)}`, `/${filepath}`];
  async function key() {
    const metadata = await bucket.head(filepath);
    const version = JSON.stringify([id, filepath, filename, files.effectiveFileType(filename, type),
      metadata.httpEtag, metadata.version, metadata.size]);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(version));
    const hash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
    return `http://localhost/__resource-original-cache/v1/${hash}`;
  }
  return { id, filepath, paths, key, fetch: options => fetchFile(paths[0], options) };
}
async function cached(f) {
  const key = await f.key();
  for (let i = 0; i < 100; i++) {
    const hit = await cache.match(key);
    if (hit) return hit;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('full public original was not stored in real Cache API');
}
async function warm(f) {
  const response = await f.fetch();
  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  return cached(f);
}

test('HEIC/HEIF octet-stream inference, explicit MIME and image sequences stay inline', () => {
  for (const ext of ['heic', 'heif']) {
    for (const type of ['', 'application/octet-stream', 'Application/Octet-Stream; charset=binary']) {
      assert.equal(files.effectiveFileType(`原图.${ext.toUpperCase()}`, type), `image/${ext}`);
    }
    assert.equal(files.effectiveFileType(`x.${ext}`, 'image/png'), 'image/png');
    for (const type of [`image/${ext}`, `image/${ext}-sequence`]) {
      assert.equal(files.effectiveFileType('unknown.bin', type), type);
      assert.match(files.contentDisposition('原图', type), /^inline;/);
    }
  }
  assert.equal(files.effectiveFileType('unknown.bin', 'application/octet-stream'), 'application/octet-stream');
  assert.match(files.contentDisposition('unknown.bin', 'application/octet-stream'), /^attachment;/);
});

test('public original bytes are cached by Cloudflare after auth and reused across canonical/legacy URLs', async () => {
  const f = await fixture();
  const stored = await warm(f);
  assert.equal(stored.status, 200);
  assert.equal(stored.headers.get('cache-control'), 'public, max-age=300, no-transform');
  assert.equal(stored.headers.get('content-type'), 'image/heic');
  assert.deepEqual(new Uint8Array(await stored.arrayBuffer()), bytes);
  const before = await counts();
  for (const path of f.paths) {
    const response = await fetchFile(path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
    assert.equal(response.headers.get('cloudflare-cdn-cache-control'), 'no-store');
    assert.match(response.headers.get('content-disposition'), /^inline;/);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  }
  const after = await counts();
  assert.equal(after.gets, before.gets, 'cache hits must avoid R2.get');
  assert.equal(after.heads, before.heads + 3, 'each hit must recheck R2 metadata');
});

test('warm cache cannot bypass private/protected/archive/unlink/disablePublic/delete permissions', async () => {
  for (const change of ['private', 'protected', 'archive', 'unlink', 'disable', 'delete']) {
    const f = await fixture();
    await warm(f);
    if (change === 'private' || change === 'protected') {
      await db.prepare('UPDATE memos SET visibility=? WHERE id=?').bind(change.toUpperCase(), f.id).run();
    } else if (change === 'archive') {
      await db.prepare("UPDATE memos SET row_status='ARCHIVED' WHERE id=?").bind(f.id).run();
    } else if (change === 'unlink') {
      await db.prepare('DELETE FROM memo_resources WHERE resource_id=?').bind(f.id).run();
    } else if (change === 'disable') {
      await db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('disable-public-memos','true')").run();
    } else {
      await db.prepare('DELETE FROM resources WHERE id=?').bind(f.id).run();
    }
    const before = await counts();
    try {
      for (const path of f.paths) for (const method of ['GET', 'HEAD']) {
        const denied = await fetchFile(path, { method, headers: { 'If-None-Match': '*' } });
        assert.equal(denied.status, 404, `${change}: ${path}`); privateResponse(denied);
      }
      assert.deepEqual(await counts(), before, 'denied requests must not even HEAD R2');
    } finally {
      await db.prepare("DELETE FROM settings WHERE key='disable-public-memos'").run();
    }
  }
});

test('credentials, even cookies, blank token parameters and legacy TOKEN bypass internal cache', async () => {
  const f = await fixture(); await warm(f);
  for (const headers of [{ Authorization: `Bearer ${token}` }, { 'X-Token': token },
    { Cookie: 'session=opaque' }, { Authorization: 'Bearer legacy-test-token' }]) {
    const before = await counts();
    const response = await f.fetch({ headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store', `credential header: ${Object.keys(headers).join(',')}, empty=${Object.values(headers)[0] === ''}`);
    privateResponse(response); await response.arrayBuffer();
    assert.equal((await counts()).gets, before.gets + 1);
  }
  for (const query of [`?token=${token}`, '?token=']) {
    const before = await counts();
    const response = await fetchFile(f.paths[0] + query);
    assert.equal(response.status, 200); privateResponse(response); await response.arrayBuffer();
    assert.equal((await counts()).gets, before.gets + 1);
  }
  for (const options of [{ headers: { Authorization: 'Bearer invalid' } },
    { headers: { 'X-Token': 'invalid' } }]) {
    const before = await counts(); const denied = await f.fetch(options);
    assert.equal(denied.status, 401); privateResponse(denied); assert.deepEqual(await counts(), before);
  }
});

test('private and credentialed complete reads never populate Cache API', async () => {
  const f = await fixture();
  await db.prepare("UPDATE memos SET visibility='PRIVATE' WHERE id=?").bind(f.id).run();
  for (let i = 0; i < 2; i++) {
    const response = await f.fetch({ headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200); privateResponse(response); await response.arrayBuffer();
  }
  assert.equal(await cache.match(await f.key()), undefined);
  await db.prepare("UPDATE memos SET visibility='PUBLIC' WHERE id=?").bind(f.id).run();
  const response = await f.fetch({ headers: { Cookie: 'logged-in=1' } });
  privateResponse(response); await response.arrayBuffer();
  assert.equal(await cache.match(await f.key()), undefined);
});

test('R2 content version and metadata changes miss old cache; deleted storage never returns cached bytes', async () => {
  const f = await fixture(); await warm(f);
  const oldKey = await f.key(); const newer = new Uint8Array([4, 3, 2, 255]);
  await bucket.put(f.filepath, newer);
  assert.notEqual(await f.key(), oldKey);
  const before = await counts();
  const changed = await f.fetch(); assert.equal(changed.status, 200);
  assert.deepEqual(new Uint8Array(await changed.arrayBuffer()), newer);
  assert.equal((await counts()).gets, before.gets + 1);
  assert.deepEqual(new Uint8Array(await (await cached(f)).arrayBuffer()), newer);
  await db.prepare("UPDATE resources SET filename='renamed.heif',type='image/heif-sequence' WHERE id=?").bind(f.id).run();
  const renamed = await f.fetch(); assert.equal(renamed.headers.get('content-type'), 'image/heif-sequence');
  assert.match(renamed.headers.get('content-disposition'), /^inline;.*renamed.heif/); await renamed.arrayBuffer();
  await bucket.delete(f.filepath);
  const missing = await f.fetch(); assert.equal(missing.status, 404); privateResponse(missing);
});

test('warm or cold Range/If-Range/HEAD/If-None-Match obey HTTP and do not populate full-object cache', async () => {
  for (const warmed of [false, true]) {
    const f = await fixture(); if (warmed) await warm(f);
    const metadata = await bucket.head(f.filepath);
    const before = await counts();
    for (const method of ['GET', 'HEAD']) {
      for (const etag of [metadata.httpEtag, `W/${metadata.httpEtag}`, `"other", ${metadata.httpEtag}`, '*']) {
        const response = await f.fetch({ method, headers: { 'If-None-Match': etag, Range: 'bytes=0-2' } });
        assert.equal(response.status, 304); assert.equal(await response.text(), '');
        assert.equal(response.headers.get('etag'), metadata.httpEtag);
        assert.equal(response.headers.get('cloudflare-cdn-cache-control'), 'no-store');
      }
    }
    const head = await f.fetch({ method: 'HEAD', headers: { Range: 'bytes=999-' } });
    assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(bytes.length));
    assert.equal(await head.text(), ''); assert.equal((await counts()).gets, before.gets);
    for (const [range, slice] of [['bytes=1-3', bytes.slice(1, 4)], ['bytes=-3', bytes.slice(-3)]]) {
      const partial = await f.fetch({ headers: { Range: range, 'If-Range': metadata.httpEtag } });
      assert.equal(partial.status, 206);
      assert.deepEqual(new Uint8Array(await partial.arrayBuffer()), slice);
    }
    for (const range of ['bytes=999-', 'bytes=0-1,3-4']) {
      const invalid = await f.fetch({ headers: { Range: range } });
      assert.equal(invalid.status, 416); privateResponse(invalid);
    }
    const full = await f.fetch({ headers: { Range: 'bytes=1-3', 'If-Range': '"stale"' } });
    assert.equal(full.status, 200); assert.deepEqual(new Uint8Array(await full.arrayBuffer()), bytes);
    if (!warmed) assert.equal(await cache.match(await f.key()), undefined);
    const stale = await f.fetch({ headers: { 'If-None-Match': '"stale"' } });
    assert.equal(stale.status, 200); assert.deepEqual(new Uint8Array(await stale.arrayBuffer()), bytes);
  }
});

test('public redirects and missing R2 files never enter cache', async () => {
  const f = await fixture({ external: true });
  const before = await counts();
  const response = await f.fetch({ redirect: 'manual' });
  assert.equal(response.status, 302); privateResponse(response);
  assert.equal(response.headers.get('location'), 'https://files.example.test/original.heic?stored=1');
  assert.deepEqual(await counts(), before);
  const missing = await fixture(); const key = await missing.key(); await bucket.delete(missing.filepath);
  const denied = await missing.fetch(); assert.equal(denied.status, 404); privateResponse(denied);
  assert.equal(await cache.match(key), undefined);
});

test('multipart HEIC/HEIF originals retain upload bytes and MIME without conversion', async () => {
  for (const [filename, inputType, expectedType] of [
    ['相机.HEIC', 'application/octet-stream', 'image/heic'],
    ['相机.heif', 'application/octet-stream', 'image/heif'],
    ['连拍.heif', 'image/heif-sequence', 'image/heif-sequence'],
    ['连拍.heic', 'image/heic-sequence', 'image/heic-sequence'],
  ]) {
    const form = new FormData(); form.set('file', new Blob([bytes], { type: inputType }), filename);
    const encoded = new Request('http://localhost/api/v1/resource/blob', {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
    });
    const uploaded = await mf.dispatchFetch(encoded.url, {
      method: 'POST', headers: encoded.headers, body: await encoded.arrayBuffer(),
    });
    assert.equal(uploaded.status, 200); privateResponse(uploaded);
    const resource = await uploaded.json();
    assert.equal(resource.filename, filename); assert.equal(resource.type, expectedType);
    assert.deepEqual(new Uint8Array(await (await bucket.get(resource.filepath)).arrayBuffer()), bytes);
    const url = `/api/v1/resource/${resource.id}/file`;
    assert.equal((await fetchFile(url)).status, 404);
    const file = await fetchFile(url, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(file.status, 200); privateResponse(file);
    assert.equal(file.headers.get('content-type'), expectedType);
    assert.match(file.headers.get('content-disposition'), /^inline;/);
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes);
  }
});
