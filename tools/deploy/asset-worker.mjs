// Read-only public delivery for this game's private R2 bucket.
// Filenames contain content hashes; releases never overwrite or delete objects.
export function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  const first = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const last = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 0 || first >= size || last < first || (!match[1] && Number(match[2]) <= 0)) return null;
  return { offset: first, length: last - first + 1 };
}
const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': 'Range, If-Range, If-None-Match, If-Modified-Since',
  'access-control-expose-headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Encoding, ETag',
  'access-control-max-age': '86400',
  'cross-origin-resource-policy': 'cross-origin'
};
const problem = (status, extra = {}) => new Response(null, { status, headers: { ...cors, 'cache-control': 'no-store', ...extra } });
const fresh = (req, etag) => String(req.headers.get('if-none-match') || '').split(',').some((value) => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag);
export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (!['GET', 'HEAD'].includes(request.method)) return problem(405, { allow: 'GET, HEAD, OPTIONS' });
    if (url.pathname === '/healthz') return Response.json({ ok: true, service: 'sanfrancisco-assets' }, { headers: { ...cors, 'cache-control': 'no-store' } });
    const key = url.pathname.slice(1);
    if (!/^objects\/[a-f0-9]{64}\/[a-zA-Z0-9_.%~-]+$/.test(key)) return problem(404);
    // Cache API operates once a custom domain is attached. Browser immutable
    // caching works on workers.dev too; that hostname has no edge Cache API.
    const cache = globalThis.caches?.default;
    const cacheKey = new Request(`${url.origin}/${key}`, { method: 'GET' });
    const rangeHeader = request.headers.get('range');
    if (cache && request.method === 'GET' && !rangeHeader && !request.headers.has('if-none-match')) {
      const cached = await cache.match(cacheKey);
      if (cached) return cached;
    }
    try {
      let object, range;
      if (rangeHeader) {
        const head = await env.ASSETS.head(key);
        if (!head) return problem(404);
        if (fresh(request, head.httpEtag)) return new Response(null, { status: 304, headers: { ...cors, etag: head.httpEtag, 'cache-control': 'public, max-age=31536000, immutable' } });
        const ifRange = request.headers.get('if-range');
        const rangeAllowed = !ifRange || ifRange === head.httpEtag || (Number.isFinite(Date.parse(ifRange)) && Math.floor(head.uploaded.getTime() / 1000) <= Date.parse(ifRange) / 1000);
        if (rangeAllowed) {
          range = parseRange(rangeHeader, head.size);
          if (!range || head.httpMetadata?.contentEncoding) return problem(416, { 'content-range': `bytes */${head.size}` });
        }
        object = request.method === 'HEAD' ? head : await env.ASSETS.get(key, range ? { range } : undefined);
      } else object = request.method === 'HEAD' ? await env.ASSETS.head(key) : await env.ASSETS.get(key);
      if (!object) return problem(404);
      const headers = new Headers(cors);
      object.writeHttpMetadata(headers);
      headers.set('cache-control', 'public, max-age=31536000, immutable');
      headers.set('etag', object.httpEtag);
      headers.set('accept-ranges', 'bytes');
      headers.set('last-modified', object.uploaded.toUTCString());
      headers.set('x-content-type-options', 'nosniff');
      if (fresh(request, object.httpEtag)) {
        if (object.body) await object.body.cancel();
        return new Response(null, { status: 304, headers });
      }
      headers.set('content-length', String(range ? range.length : object.size));
      if (range) headers.set('content-range', `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`);
      const response = new Response(request.method === 'HEAD' ? null : object.body, { status: range ? 206 : 200, headers, encodeBody: 'manual' });
      if (cache && request.method === 'GET' && !range) context.waitUntil(cache.put(cacheKey, response.clone()).catch(() => {}));
      return response;
    } catch {
      return problem(503);
    }
  }
};
