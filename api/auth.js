import { Redis } from '@upstash/redis';
import crypto from 'crypto';

const redis = Redis.fromEnv();
const TOKEN_TTL = 60 * 60 * 24 * 7; // 7日

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const { pin } = req.body || {};
  if (!pin || typeof pin !== 'string') {
    return res.status(400).json({ error: 'pin_required' });
  }

  const correctPin = (process.env.CIRCLE_PIN || '0521').trim();
  if (sha256(pin.trim()) !== sha256(correctPin)) {
    await redis.lpush('audit:auth_fail', JSON.stringify({
      at: new Date().toISOString(),
      ip: req.headers['x-forwarded-for'] || 'unknown'
    }));
    await redis.ltrim('audit:auth_fail', 0, 999);
    return res.status(401).json({ error: 'invalid_pin' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  await redis.set(`token:${token}`, '1', { ex: TOKEN_TTL });
  return res.status(200).json({ token, expiresIn: TOKEN_TTL });
}
