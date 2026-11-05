import { errorResponse } from './auth';
import { readableResource } from './resourceAccess.js';

export function effectiveFileType(filename, type = '') {
  type = String(type || '').split(';')[0].trim().toLowerCase();
  if (/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type) && type !== 'application/octet-stream') return type;
  return ({ pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif',
    mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg' })[String(filename).split('.').at(-1).toLowerCase()] || 'application/octet-stream';
}
export function contentDisposition(filename, type = '') {
  const inline = /^(image\/(?:png|jpeg|gif|webp|avif|heic(?:-sequence)?|heif(?:-sequence)?)|video\/[a-z0-9.+-]+|audio\/[a-z0-9.+-]+|application\/pdf)$/i.test(type);
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${inline ? 'inline' : 'attachment'}; filename="download"; filename*=UTF-8''${encoded}`;
}

export function byteRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || !size) return false;
  let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  let end = match[1] && match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return false;
  return { offset: start, length: Math.min(end, size - 1) - start + 1 };
}

// An opaque, versioned key has no client query/credentials and is not a public
// file URL. Metadata is checked on every request, after current D1 permissions.
async function originalCacheKey(c, resource, metadata, type) {
  const version = JSON.stringify([resource.id, resource.filepath, resource.filename,
    type, metadata.httpEtag, metadata.version, metadata.size]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(version));
  const hash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  return new Request(`${new URL(c.req.url).origin}/__resource-original-cache/v1/${hash}`);
}

function etagMatches(header, etag) {
  return header?.split(',').some(tag => tag.trim() === '*' ||
    tag.trim().replace(/^W\//, '') === etag);
}

// Canonical and legacy URLs use exactly the same authorization and range handling.
export async function serveResourceFile(c, lookup) {
  try {
    const { resource, isPublic, error } = await readableResource(c, lookup);
    if (error) return error;
    c.set('publicResourceFile', isPublic);
    const type = effectiveFileType(resource.filename, resource.type);
    const objectKey = resource.filepath;
    if (objectKey.startsWith('http')) {
      const url = new URL(objectKey);
      if (!['http:', 'https:'].includes(url.protocol)) return errorResponse('Invalid resource URL', 400);
      // Never copy the incoming query or credentials to an external destination.
      return Response.redirect(url.href, 302);
    }

    const bucket = c.env.BUCKET;
    const rangeHeader = c.req.header('Range');
    const cacheable = isPublic && c.req.method === 'GET' && !rangeHeader;
    let metadata, cache, cacheKey;
    let range = null;
    if (cacheable || rangeHeader || c.req.method === 'HEAD' || c.req.header('If-None-Match')) {
      metadata = await bucket.head(objectKey);
      if (!metadata) return errorResponse('File not found in storage', 404);
      if (etagMatches(c.req.header('If-None-Match'), metadata.httpEtag)) {
        return new Response(null, { status: 304, headers: { ETag: metadata.httpEtag } });
      }
      // Range only applies to GET, never to HEAD.
      if (c.req.method === 'HEAD') return new Response(null, { headers: {
        'Content-Type': type, 'Content-Length': String(metadata.size),
        'Accept-Ranges': 'bytes', 'Content-Disposition': contentDisposition(resource.filename, type),
        'X-Content-Type-Options': 'nosniff', ETag: metadata.httpEtag,
      } });
      range = byteRange(c.req.header('If-Range') && c.req.header('If-Range') !== metadata.httpEtag ? null : rangeHeader, metadata.size);
      if (range === false) return new Response(null, { status: 416,
        headers: { 'Content-Range': `bytes */${metadata.size}`, 'Accept-Ranges': 'bytes' } });
    }
    if (cacheable && typeof caches !== 'undefined') {
      try {
        cache = caches.default;
        cacheKey = await originalCacheKey(c, resource, metadata, type);
        const hit = await cache.match(cacheKey);
        if (hit?.status === 200 && !hit.headers.has('Set-Cookie')) return hit;
      } catch {
        // Cache unavailability must not turn an authorized R2 read into an error.
        cache = null;
      }
    }
    const object = await bucket.get(objectKey, range ? { range } : undefined);
    if (!object) return errorResponse('File not found in storage', 404);
    const response = new Response(object.body, {
      status: range ? 206 : 200,
      headers: {
        'Content-Type': type,
        'Content-Length': String(range?.length ?? object.size),
        'Content-Disposition': contentDisposition(resource.filename, type),
        'Accept-Ranges': 'bytes',
        ...(range ? { 'Content-Range': `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}` } : {}),
        ETag: object.httpEtag,
        'X-Content-Type-Options': 'nosniff',
      },
    });
    // Cache only a complete anonymous public original. If R2 changed between
    // HEAD and GET, do not poison the old content-version key with new bytes.
    if (cache && cacheKey && response.status === 200 && !response.headers.has('Set-Cookie') &&
        object.httpEtag === metadata.httpEtag && object.version === metadata.version) {
      const stored = response.clone();
      stored.headers.set('Cache-Control', 'public, max-age=300, no-transform');
      c.executionCtx.waitUntil(Promise.resolve().then(() => cache.put(cacheKey, stored)).catch(() => {}));
    }
    return response;
  } catch (error) {
    console.error('Error proxying resource:', error);
    return errorResponse('Failed to access resource', 500);
  }
}
