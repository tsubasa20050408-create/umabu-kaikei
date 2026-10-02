import { test } from 'node:test';
import assert from 'node:assert/strict';

const SECRET_TOKEN = 'tok-SECRET-123';
const SECRET_URL = 'https://secret-host.upstash.io';
process.env.CIRCLE_PIN = '1234';
process.env.CIRCLE_SECRET = 'shh-secret-value';
process.env.UPSTASH_REDIS_REST_URL = SECRET_URL;
process.env.UPSTASH_REDIS_REST_TOKEN = SECRET_TOKEN;
for (const k of ['CIRCLE_REDIS_REST_URL', 'CIRCLE_REDIS_REST_TOKEN', 'KV_URL', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'KV_REST_API_READ_ONLY_TOKEN', 'REDIS_URL']) delete process.env[k];

let fetchCount = 0;
globalThis.fetch = async () => { fetchCount++; return { ok: true, status: 200 }; };

const { default: handler } = await import('../api/health.js');
function mkRes() {
  const res = { statusCode: 200, headers: {}, body: undefined };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

test('20回呼んでも Upstash への ping は1回、値は漏らさない', async () => {
  let last;
  for (let i = 0; i < 20; i++) {
    const res = mkRes(); await handler({}, res); last = res;
    const text = JSON.stringify(res.body);
    for (const s of [SECRET_TOKEN, SECRET_URL, '1234', 'shh-secret-value', 'secret-host']) {
      assert.ok(!text.includes(s), `漏えい: ${s}`);
    }
  }
  assert.equal(fetchCount, 1);
  assert.equal(last.statusCode, 200);
  assert.equal(last.body.ok, true);
  assert.equal(last.body.redis_source, 'UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN');
  assert.deepEqual(last.body.storage_env, ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']);
});
