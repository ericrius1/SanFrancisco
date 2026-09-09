// Release-local routing only: no network access and no client manifest preload.
import { readFile } from 'node:fs/promises';

export function accepts(header, encoding) {
  const entries = String(header || '').toLowerCase().split(',').map((part) => {
    const [name, ...params] = part.trim().split(';');
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    const quality = q === undefined ? 1 : Number(q.slice(2));
    return [name, Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0];
  });
  const exact = entries.find(([name]) => name === encoding);
  if (exact) return exact[1] > 0;
  const wildcard = entries.find(([name]) => name === '*');
  return encoding === 'identity' ? (!wildcard || wildcard[1] > 0) : !!wildcard && wildcard[1] > 0;
}

export async function loadRemoteAssets(filename) {
  let manifest;
  try { manifest = JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { release: null, handle: () => false }; throw error; }
  const origin = new URL(manifest.origin);
  if (manifest.version !== 1 || origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('Invalid release asset manifest');
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.release) || !manifest.assets || typeof manifest.assets !== 'object') throw new Error('Invalid release asset manifest');
  const assets = new Map(Object.entries(manifest.assets));
  for (const [url, asset] of assets) {
    if (!url.startsWith('/') || url.includes('..') || !asset.identity) throw new Error(`Invalid remote asset: ${url}`);
    for (const [encoding, variant] of Object.entries(asset)) {
      if (!['identity', 'br', 'gzip'].includes(encoding) || !/^objects\/[a-f0-9]{64}\/[a-zA-Z0-9_.%~-]+$/.test(variant.key)) throw new Error(`Invalid remote asset variant: ${url}`);
    }
  }
  return {
    release: manifest.release,
    handle(req, res, urlPath) {
      const asset = assets.get(urlPath);
      if (!asset) return false;
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' }); res.end(); return true;
      }
      const header = req.headers['accept-encoding'];
      const encoding = !req.headers.range && asset.br && accepts(header, 'br') ? 'br'
        : !req.headers.range && asset.gzip && accepts(header, 'gzip') ? 'gzip' : 'identity';
      if (!accepts(header, encoding)) { res.writeHead(406, { vary: 'Accept-Encoding', 'cache-control': 'no-store' }); res.end(); return true; }
      // Never cache the unversioned redirect permanently. The destination IS immutable.
      // Range requests always select the original bytes, preserving audio seeking.
      res.writeHead(307, {
        location: new URL(asset[encoding].key, origin).href,
        'cache-control': 'no-cache', vary: 'Accept-Encoding, Range',
        'content-length': '0'
      });
      res.end();
      return true;
    }
  };
}
