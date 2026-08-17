import { CORRECT_PIN, getRedis, makeToken, safeEqual } from './_lib.js';

const WINDOW_SEC = 600; // 10分
const MAX_ATTEMPTS = 10;

// 4桁PINは1万通りしかないため総当たりが現実的に成立してしまう。
// Redis が無い環境では制限をかけられないが、ログイン自体は通す（fail open）。
async function hitRateLimit(redis, ip) {
  if (!redis) return { limited: false, key: null };
  const key = `ratelimit:auth:${ip}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, WINDOW_SEC);
  return { limited: count > MAX_ATTEMPTS, key };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }

  const { pin } = req.body || {};
  if (!pin || typeof pin !== 'string') return res.status(400).json({ error: 'pin_required' });

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const redis = getRedis();

  let limit;
  try {
    limit = await hitRateLimit(redis, ip);
  } catch {
    limit = { limited: false, key: null }; // Redis 障害でログインを止めない
  }
  if (limit.limited) {
    res.setHeader('Retry-After', String(WINDOW_SEC));
    return res.status(429).json({ error: 'too_many_attempts', retryAfter: WINDOW_SEC });
  }

  if (!safeEqual(pin.trim(), CORRECT_PIN)) return res.status(401).json({ error: 'invalid_pin' });

  // 正しく入力した人が直後に締め出されないようカウンタを消す
  if (redis && limit.key) {
    try { await redis.del(limit.key); } catch { /* 失敗しても認証は成立させる */ }
  }

  return res.status(200).json({ token: makeToken(), expiresIn: 604800 });
}
