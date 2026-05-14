import { Redis } from '@upstash/redis';
import { verifyToken } from './_lib.js';

const DATA_KEY = 'circle:data';
const VERSION_KEY = 'circle:version';

function getRedis() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token || !verifyToken(token)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const redis = getRedis();

  if (req.method === 'GET') {
    if (!redis) return res.status(200).json({ data: {}, version: 0 });
    const [data, version] = await Promise.all([
      redis.get(DATA_KEY),
      redis.get(VERSION_KEY),
    ]);
    return res.status(200).json({ data: data || {}, version: Number(version) || 0 });
  }

  if (req.method === 'POST') {
    const { data, expectedVersion } = req.body || {};
    if (typeof data !== 'object' || data === null) {
      return res.status(400).json({ error: 'invalid_payload' });
    }
    if (!redis) return res.status(200).json({ ok: true, version: 0 });
    const currentVersion = Number(await redis.get(VERSION_KEY)) || 0;
    if (typeof expectedVersion === 'number' && expectedVersion !== currentVersion) {
      const currentData = await redis.get(DATA_KEY);
      return res.status(409).json({ error: 'version_conflict', currentVersion, currentData: currentData || {} });
    }
    const newVersion = currentVersion + 1;
    await Promise.all([redis.set(DATA_KEY, data), redis.set(VERSION_KEY, newVersion)]);
    return res.status(200).json({ ok: true, version: newVersion });
  }

  return res.status(405).end();
}
