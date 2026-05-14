import crypto from 'crypto';

export const CORRECT_PIN = (process.env.CIRCLE_PIN || '0521').trim();
const SECRET = process.env.CIRCLE_SECRET || 'circle_kaikei_hmac_2024';
const TTL = 7 * 24 * 60 * 60 * 1000; // 7日

export function makeToken() {
  const exp = (Date.now() + TTL).toString();
  const sig = crypto.createHmac('sha256', SECRET).update(exp).digest('hex');
  return Buffer.from(exp + '.' + sig).toString('base64url');
}

export function verifyToken(token) {
  try {
    const decoded = Buffer.from(token, 'base64url').toString();
    const dot = decoded.lastIndexOf('.');
    const exp = decoded.slice(0, dot);
    const sig = decoded.slice(dot + 1);
    if (Date.now() > Number(exp)) return false;
    const expected = crypto.createHmac('sha256', SECRET).update(exp).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch { return false; }
}
