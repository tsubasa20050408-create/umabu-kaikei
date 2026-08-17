import { getRedis, verifyToken } from './_lib.js';

const DATA_KEY = 'circle:data';
const VERSION_KEY = 'circle:version';

// 保存先に届いていないのに成功を返すと、利用者は保存できたと誤解して原本を失う。
// 未設定も接続不能もまとめて「保存先が使えない」と分かる形に正規化する。
function unavailable(res, message) {
  return res.status(503).json({ error: 'redis_unavailable', redis_ok: false, message });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token || !verifyToken(token)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const redis = getRedis();
  if (!redis) {
    return unavailable(res, 'Upstash の接続情報（KV_REST_API_URL / KV_REST_API_TOKEN）が設定されていません。');
  }

  try {
    if (req.method === 'GET') {
      const [data, version] = await Promise.all([
        redis.get(DATA_KEY),
        redis.get(VERSION_KEY),
      ]);
      return res.status(200).json({ data: data || {}, version: Number(version) || 0, redis_ok: true });
    }

    if (req.method === 'POST') {
      const { data, expectedVersion } = req.body || {};
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        return res.status(400).json({ error: 'invalid_payload' });
      }
      const currentVersion = Number(await redis.get(VERSION_KEY)) || 0;
      if (typeof expectedVersion === 'number' && expectedVersion !== currentVersion) {
        const currentData = await redis.get(DATA_KEY);
        return res.status(409).json({ error: 'version_conflict', currentVersion, currentData: currentData || {} });
      }
      const newVersion = currentVersion + 1;
      await Promise.all([redis.set(DATA_KEY, data), redis.set(VERSION_KEY, newVersion)]);
      return res.status(200).json({ ok: true, version: newVersion, redis_ok: true });
    }
  } catch {
    return unavailable(res, 'Upstash に接続できません。データベースが削除されたか、接続情報が正しくない可能性があります。');
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).end();
}
