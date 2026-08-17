import crypto from 'crypto';
import { Redis } from '@upstash/redis';

// 既定値をソースに置くと、ソースを読めた人が誰でもログイン・トークン偽造できてしまう。
// 未設定ならデプロイ直後に気付けるよう即座に失敗させる。
function required(name) {
  const v = (process.env[name] || '').trim();
  if (!v) {
    throw new Error(
      `環境変数 ${name} が未設定です。Vercel の Settings → Environment Variables で設定してから再デプロイしてください。`
    );
  }
  return v;
}

export const CORRECT_PIN = required('CIRCLE_PIN');
const SECRET = required('CIRCLE_SECRET');
const TTL = 7 * 24 * 60 * 60 * 1000; // 7日

// 未設定でも接続情報が壊れていても null を返す。
// ここで throw すると呼び出し側が 500 になり、利用者は原因を知る手掛かりを失う。
export function getRedis() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    return new Redis({ url, token });
  } catch {
    return null;
  }
}

// 一致判定に要する時間から正解を推測されないよう、常に同じ長さのハッシュ同士で比較する
export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

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
