import { test } from 'node:test';
import assert from 'node:assert/strict';
import { affectsPublicFeed, notifyPublicFeed } from '../src/server/utils/publicFeed.js';
test('successful memo, resource, settings and Telegram writes invalidate the public mirror', () => {
  for (const path of ['/api/v1/memo', '/api/v1/memo/2', '/api/v1/memo/2/organizer', '/api/v1/resource/2', '/api/v1/settings', '/api/v1/telegram/webhook']) {
    assert.ok(affectsPublicFeed(path, 'POST', 200));
    assert.equal(affectsPublicFeed(path, 'GET', 200), false);
    assert.equal(affectsPublicFeed(path, 'POST', 401), false);
  }
});
test('mirror notification sends only a signal and its dedicated credential', async () => {
  const calls = [];
  await notifyPublicFeed({ PUBLIC_FEED_SYNC_URL: 'https://mirror.test/sync', PUBLIC_FEED_SYNC_TOKEN: 'test-only-token' }, async (url, options) => { calls.push(options); return { ok: true }; });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body, '{}');
  assert.equal(calls[0].headers.Authorization, 'Bearer test-only-token');
  assert.equal(calls[0].redirect, 'error');
});
