export function effectiveFileType(filename, type = '') {
  type = String(type || '').split(';')[0].trim().toLowerCase();
  if (/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type) && type !== 'application/octet-stream') return type;
  return ({ pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
    mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg' })[String(filename).split('.').at(-1).toLowerCase()] || 'application/octet-stream';
}
export function contentDisposition(filename, type = '') {
  const inline = /^(image\/(?:png|jpeg|gif|webp|avif|heic|heif)|video\/[a-z0-9.+-]+|audio\/[a-z0-9.+-]+|application\/pdf)$/i.test(type);
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
