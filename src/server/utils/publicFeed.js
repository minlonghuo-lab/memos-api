// Tell the public mirror to re-read anonymous data. Never send memo bodies,
// user credentials or private metadata to the mirror.
export async function notifyPublicFeed(env, fetcher = fetch) {
  if (!env.PUBLIC_FEED_SYNC_URL || !env.PUBLIC_FEED_SYNC_TOKEN) return;
  const url = new URL(env.PUBLIC_FEED_SYNC_URL);
  if (url.protocol !== 'https:') throw new Error('Public feed requires HTTPS');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetcher(url, {
        method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${env.PUBLIC_FEED_SYNC_TOKEN}`, 'Content-Type': 'application/json' },
        body: '{}', signal: AbortSignal.timeout(7000),
      });
      if (response.ok) return;
    } catch { /* A failed mirror must not fail a memo write. */ }
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 1000));
  }
  console.error('[public-feed] sync notification failed; scheduled reconciliation will retry');
}

export function affectsPublicFeed(path, method, status) {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method) && status >= 200 && status < 300
    && /^\/api\/v1\/(memo(?:\/|$)|resource(?:\/|$)|tag(?:\/|$)|settings(?:\/|$)|system\/setting(?:\/|$)|telegram(?:\/|$))/.test(path);
}
