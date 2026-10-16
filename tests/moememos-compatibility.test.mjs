import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { generateJWT } from '../src/server/utils/jwt.js';

let mf, db, jwt;
const apiToken = 'a'.repeat(64);
const secret = 'local-compatibility-test-secret-only';

before(async () => {
  const bundle = await build({ entryPoints: ['src/server/index.js'], bundle: true,
    write: false, format: 'esm', platform: 'browser' });
  mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2024-01-15', compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'], r2Buckets: ['BUCKET'], bindings: { JWT_SECRET: secret } });
  db = await mf.getD1Database('DB');
  const schema = (await readFile('schema.sql', 'utf8')).replace(/--[^\n]*/g, '');
  await db.batch(schema.split(';').map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
  await db.batch([
    db.prepare("INSERT INTO users(id,username,nickname,password_hash) VALUES(1,'owner','Owner','test'),(2,'other','Other','test')"),
    db.prepare("INSERT INTO api_tokens(user_id,name,token) VALUES(1,'test',?)").bind(apiToken),
    db.prepare("INSERT INTO tags(id,name,creator_id) VALUES(1,'test',1)"),
  ]);
  // More than one page, shared timestamps, private entries, and multiple accounts.
  await db.batch(Array.from({ length: 90 }, (_, i) => db.prepare(`
    INSERT INTO memos(id,creator_id,content,visibility,row_status,created_ts,updated_ts,display_ts)
    VALUES(?,1,?,'PRIVATE',?,1000,1000,1000)
  `).bind(i + 1, `Memo ${i + 1}`, i < 65 ? 'NORMAL' : 'ARCHIVED')));
  await db.batch([
    db.prepare("INSERT INTO memos(id,creator_id,content,visibility,created_ts,display_ts) VALUES(100,2,'Other public','PUBLIC',1000,1000),(101,2,'Other private','PRIVATE',1000,1000)"),
    db.prepare("INSERT INTO memo_tags(memo_id,tag_id) VALUES(1,1)"),
    ...Array.from({ length: 30 }, (_, i) => db.prepare(`
      INSERT INTO resources(id,creator_id,filename,filepath,type,size) VALUES(?,1,?,?,'image/png',5)
    `).bind(i + 1, `${i + 1}.png`, `${i + 1}.png`)),
    ...Array.from({ length: 25 }, (_, i) => db.prepare('INSERT INTO memo_resources(memo_id,resource_id) VALUES(65,?)').bind(i + 1)),
  ]);
  jwt = await generateJWT({ id: 1 }, secret);
});
after(async () => { await mf?.dispose(); });

async function request(path, { token = jwt, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return mf.dispatchFetch(`http://localhost/api/v1/${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function json(path, options) {
  const response = await request(path, options);
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
}
function assertMemo(memo) {
  // Required fields in MoeMemos 2.0.7's generated OpenAPI decoder.
  assert.equal(typeof memo.id, 'number');
  assert.equal(typeof memo.createdTs, 'number');
  assert.equal(typeof memo.content, 'string');
  assert.equal(typeof memo.updatedTs, 'number');
}

test('personal sync returns every normal memo and excludes other users', async () => {
  const memos = await json('memo?rowStatus=NORMAL');
  assert.equal(memos.length, 65);
  assert.ok(memos.every(m => m.creatorID === 1 && m.rowStatus === 'NORMAL'));
  for (const memo of memos) assertMemo(memo);
});
test('personal sync returns all archived memos', async () => {
  assert.equal((await json('memo?rowStatus=ARCHIVED')).length, 25);
});
test('ordinary API tokens read the same personal snapshot as JWTs', async () => {
  const memos = await json('memo?rowStatus=NORMAL', { token: apiToken });
  assert.equal(memos.length, 65);
  assert.equal((await json('memo/1', { token: apiToken })).id, 1);
  assert.deepEqual(await json('tag', { token: apiToken }), ['test']);
});
test('bad credentials fail rather than presenting a partial public snapshot', async () => {
  assert.equal((await request('memo?rowStatus=NORMAL', { token: 'b'.repeat(64) })).status, 401);
});
test('anonymous visibility filters cannot expose private memos', async () => {
  const memos = await json('memo?visibility=PRIVATE', { token: null });
  assert.deepEqual(memos, []);
  const publicMemos = await json('memo?visibility=PUBLIC', { token: null });
  assert.ok(publicMemos.every(m => m.visibility === 'PUBLIC'));
});
test('explicit pages count memos before joining attachments and use stable ordering', async () => {
  const first = await json('memo?creatorId=1&limit=1&offset=0');
  const second = await json('memo?creatorId=1&limit=1&offset=1');
  assert.equal(first.length, 1);
  assert.equal(first[0].id, 65);
  assert.equal(first[0].resourceList.length, 25);
  assert.equal(second[0].id, 64);
  const all = [];
  for (let offset = 0; offset < 65; offset += 10) {
    all.push(...await json(`memo?creatorId=1&limit=10&offset=${offset}`));
  }
  assert.equal(new Set(all.map(m => m.id)).size, 65);
});
test('explore pages also count memos rather than attachment rows', async () => {
  await db.batch([
    db.prepare("INSERT INTO memos(id,creator_id,content,visibility,created_ts,display_ts) VALUES(200,1,'Explore with files','PUBLIC',3000,3000),(201,1,'Explore next','PUBLIC',2000,2000)"),
    ...Array.from({ length: 25 }, (_, i) => db.prepare('INSERT INTO memo_resources(memo_id,resource_id) VALUES(200,?)').bind(i + 1)),
  ]);
  const first = await json('memo/all?limit=1&offset=0');
  const next = await json('memo/all?limit=1&offset=1');
  assert.equal(first[0].id, 200);
  assert.equal(first[0].resourceList.length, 25);
  assert.equal(next[0].id, 201);
});
test('organizer returns a decodable memo so edits do not become pending conflicts', async () => {
  const pinned = await json('memo/1/organizer', { method: 'POST', body: { pinned: true } });
  assertMemo(pinned);
  assert.equal(pinned.pinned, true);
  const updated = await json('memo/1', { method: 'PATCH', body: { content: 'Edited', updatedTs: 1500 } });
  assertMemo(updated);
  assert.equal(updated.content, 'Edited');
  assert.equal(updated.updatedTs, 1500);
  await json('memo/1/organizer', { method: 'POST', body: { pinned: false } });
});
test('resourceIdList replaces attachments and accepts an empty list on its own', async () => {
  const modified = await json('memo/65', { method: 'PATCH', body: { content: 'Fewer attachments', resourceIdList: [2] } });
  assert.deepEqual(modified.resourceList.map(r => r.id), [2]);
  const cleared = await json('memo/65', { method: 'PATCH', body: { resourceIdList: [] } });
  assert.deepEqual(cleared.resourceList, []);
});
test('offline creation preserves createdTs and stable attachment metadata', async () => {
  const created = await json('memo', { method: 'POST', body: {
    content: 'Offline memo', visibility: 'PRIVATE', createdTs: 500, resourceIdList: [1, 1],
  } });
  assertMemo(created);
  assert.equal(created.createdTs, 500);
  assert.equal(created.displayTs, 500);
  assert.equal(created.resourceList.length, 1);
  assert.equal(created.resourceList[0].updatedTs, created.resourceList[0].createdTs);
});
test('resource list without a limit returns all resources for the account', async () => {
  assert.equal((await json('resource')).length, 30);
  assert.equal((await json('resource?limit=10&offset=10')).length, 10);
});

test('full snapshots retain metadata across D1 parameter batches', async () => {
  await db.batch([
    ...Array.from({ length: 100 }, (_, i) => db.prepare(`
      INSERT INTO memos(id,creator_id,content,visibility,created_ts,updated_ts,display_ts)
      VALUES(?,1,'Older memo','PRIVATE',1,1,1)
    `).bind(1000 + i)),
    db.prepare('INSERT INTO memo_tags(memo_id,tag_id) VALUES(1000,1)'),
    db.prepare("INSERT INTO memo_relations(memo_id,related_memo_id,type) VALUES(1000,1,'REFERENCE')"),
  ]);
  try {
    const memos = await json('memo?rowStatus=NORMAL');
    const count = await db.prepare("SELECT COUNT(*) AS count FROM memos WHERE creator_id=1 AND row_status='NORMAL'").first();
    assert.equal(memos.length, count.count);
    assert.deepEqual(memos.find(m => m.id === 1000).tagList, [{ id: 1, name: 'test' }]);
    assert.equal(memos.find(m => m.id === 1000).relationList[0].relatedMemoId, 1);
  } finally {
    await db.prepare('DELETE FROM memos WHERE id >= 1000').run();
  }
});

test('protected and archived memos remain isolated from anonymous visitors', async () => {
  await db.prepare("INSERT INTO memos(id,creator_id,content,visibility) VALUES(300,1,'Protected','PROTECTED')").run();
  try {
    assert.ok(!(await json('memo/all?limit=1000', { token: null })).some(m => m.id === 300));
    assert.ok((await json('memo/all?limit=1000')).some(m => m.id === 300));
    assert.equal((await request('memo/300', { token: null })).status, 401);
    assert.equal((await request('memo?rowStatus=ARCHIVED', { token: null })).status, 401);
    assert.equal((await json('memo/66')).rowStatus, 'ARCHIVED');
  } finally {
    await db.prepare('DELETE FROM memos WHERE id=300').run();
  }
});

test('invalid pagination and expired credentials cannot masquerade as successful syncs', async () => {
  for (const query of ['limit=-1', 'limit=1.5', 'offset=-2', 'limit=abc']) {
    assert.equal((await request(`memo?${query}`)).status, 400);
  }
  const expired = await generateJWT({ id: 1 }, secret, -100);
  assert.equal((await request('memo?rowStatus=NORMAL', { token: expired })).status, 401);
});

test('invalid attachments are rejected before a memo is inserted', async () => {
  const before = await db.prepare('SELECT COUNT(*) AS count FROM memos').first();
  const response = await request('memo', { method: 'POST', body: {
    content: 'Invalid attachment', resourceIdList: [999999],
  } });
  assert.equal(response.status, 400);
  const after = await db.prepare('SELECT COUNT(*) AS count FROM memos').first();
  assert.equal(after.count, before.count);
});
