import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuditHandler } from '../api/_audit-handler.js';

// 本物の Redis と同じく、LPUSH は引数を順に先頭へ積む（最後の引数が先頭になる）
function fakeRedis() {
  const lists = {};
  const r = {
    lists,
    async lrange(k, s, e) { return (lists[k] || []).slice(s, e + 1); },
    multi() {
      const ops = [];
      const tx = {
        lpush(k, ...v) { ops.push(() => { lists[k] = lists[k] || []; for (const x of v) lists[k].unshift(x); }); return tx; },
        ltrim(k, s, e) { ops.push(() => { lists[k] = (lists[k] || []).slice(s, e + 1); }); return tx; },
        async exec() { ops.forEach((f) => f()); return ops.map(() => 'OK'); },
      };
      return tx;
    },
  };
  return r;
}
function mkRes() {
  const res = { statusCode: 200, headers: {}, body: undefined };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.end = () => res;
  return res;
}
const verifyToken = (t) => t === 'good';
const run = async (redis, req, headers = { authorization: 'Bearer good' }) => {
  const h = createAuditHandler({ getRedis: () => redis, verifyToken });
  const res = mkRes();
  await h({ headers, url: '/api/audit', ...req }, res);
  return res;
};
const E = (n) => ({ ts: String(n).padStart(6, '0'), action: 'a', detail: 'd' + n });

test('古い塊、新しい塊の順に送ると lrange は新しい順になる', async () => {
  const r = fakeRedis();
  // 各塊は新しい順（クライアントの送り方）
  await run(r, { method: 'POST', body: { entries: [E(3), E(2), E(1)] } });
  await run(r, { method: 'POST', body: { entries: [E(6), E(5), E(4)] } });
  const res = await run(r, { method: 'GET', query: { limit: '100' } });
  assert.deepEqual(res.body.entries.map((e) => e.ts), ['000006', '000005', '000004', '000003', '000002', '000001']);
  assert.equal(res.body.redis_ok, true);
});

test('POST 応答は件数', async () => {
  const res = await run(fakeRedis(), { method: 'POST', body: { entries: [E(1), E(2)] } });
  assert.deepEqual(res.body, { ok: true, count: 2 });
});

test('5000件で切り詰め（古いものから落ちる）', async () => {
  const r = fakeRedis();
  for (let i = 0; i < 6; i++) {
    const chunk = []; for (let j = 0; j < 1000; j++) chunk.push(E(i * 1000 + 999 - j)); // 新しい順
    await run(r, { method: 'POST', body: { entries: chunk } });
  }
  assert.equal(r.lists['circle:audit'].length, 5000);
  assert.equal(r.lists['circle:audit'][0].ts, '005999');
  assert.equal(r.lists['circle:audit'][4999].ts, '001000');
});

test('GET: offset と limit（1〜1000に丸める）', async () => {
  const r = fakeRedis();
  await run(r, { method: 'POST', body: { entries: [E(5), E(4), E(3), E(2), E(1)] } });
  const a = await run(r, { method: 'GET', query: { offset: '1', limit: '2' } });
  assert.deepEqual(a.body.entries.map((e) => e.ts), ['000004', '000003']);
  const b = await run(r, { method: 'GET', query: { limit: '0' } });
  assert.equal(b.body.entries.length, 1);
  const c = await run(r, { method: 'GET', url: '/api/audit?offset=3&limit=99999' });
  assert.equal(c.body.entries.length, 2);
});

test('GET: 文字列で返った要素は JSON.parse される', async () => {
  const r = fakeRedis();
  r.lists['circle:audit'] = [JSON.stringify(E(1))];
  const res = await run(r, { method: 'GET' });
  assert.deepEqual(res.body.entries[0], E(1));
});

test('不正な entries は 400 invalid_entries', async () => {
  const many = Array.from({ length: 1001 }, (_, i) => E(i));
  const bad = [undefined, [], 'x', {}, many, [{ ts: '1' }], [{ action: 'a' }], [{ ts: 1, action: 'a' }], [null], ['s'], [E(1), 5]];
  for (const entries of bad) {
    const r = fakeRedis();
    const res = await run(r, { method: 'POST', body: { entries } });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'invalid_entries');
    assert.equal(r.lists['circle:audit'], undefined);
  }
  assert.equal((await run(fakeRedis(), { method: 'POST' })).statusCode, 400);
});

test('1000件ちょうどは受け付ける', async () => {
  const many = Array.from({ length: 1000 }, (_, i) => E(i));
  assert.equal((await run(fakeRedis(), { method: 'POST', body: { entries: many } })).statusCode, 200);
});

test('401', async () => {
  for (const headers of [{}, { authorization: 'Bearer bad' }]) {
    const res = await run(fakeRedis(), { method: 'GET' }, headers);
    assert.equal(res.statusCode, 401);
  }
});

test('503: getRedis が null', async () => {
  const res = await run(null, { method: 'GET' });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'redis_unavailable');
});

test('503: Redis 例外で console.error', async () => {
  const r = fakeRedis();
  r.lrange = async () => { throw new Error('boom'); };
  const orig = console.error; let logged = 0; console.error = () => { logged++; };
  try {
    const res = await run(r, { method: 'GET' });
    assert.equal(res.statusCode, 503);
    assert.equal(logged, 1);
  } finally { console.error = orig; }
});

test('PUT は 405 と Allow', async () => {
  const res = await run(fakeRedis(), { method: 'PUT' });
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, 'GET, POST');
});
