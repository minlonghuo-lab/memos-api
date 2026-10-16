export function parsePagination(req, defaultLimit = 20) {
  const limitValue = req.query('limit');
  const offsetValue = req.query('offset');
  const limit = limitValue === undefined ? defaultLimit : Number(limitValue);
  const offset = offsetValue === undefined ? 0 : Number(offsetValue);
  if ((limitValue !== undefined && !/^\d+$/.test(limitValue)) ||
      (offsetValue !== undefined && !/^\d+$/.test(offsetValue)) ||
      !Number.isSafeInteger(limit) || limit < -1 ||
      !Number.isSafeInteger(offset) || offset < 0) {
    throw new Error('Invalid pagination');
  }
  return { limit, offset };
}
