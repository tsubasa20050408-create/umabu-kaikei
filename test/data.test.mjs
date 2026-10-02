import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDataHandler } from '../api/_data-handler.js';

// eval は api/_data-handler.js の Lua（CAS）と同じ意味を JS で再現する
function fakeRedis(init = {}) {
  const store = { ...init };
  const r = {
    store, calls: 0,
    async get(k) { r.calls++; return k in store ? store[k] : null; },
    async set(k, v) { r.calls++; store[k] = v; return 'OK'; },
    async eval(script, keys, args) {
      r.calls++;
      const cur = Number(store[keys[1]] ?? 0) || 0;
      if (cur !== Number(args[1])) return [0, cur];
      store[keys[0]] = JSON.parse(args[0]); // @upstash/redis は get で JSON を自動復元する
      store[keys[1]] = cur + 1;
      return [1, cur + 1];
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
const OK = 'good';
const verifyToken = (t) => t === OK;
const run = async (redis, req) => {
  const h = createDataHandler({ getRedis: () => redis, verifyToken });
  const res = mkRes();
  await h({ headers: { authorization: 'Bearer ' + OK }, url: '/api/data', ...req }, res);
  return res;
};

test('401: トークン無し / 不正', async () => {
  const h = createDataHandler({ getRedis: () => fakeRedis(), verifyToken });
  for (const headers of [{}, { authorization: 'Bearer bad' }, { authorization: 'good' }]) {
    const res = mkRes();
    await h({ method: 'GET', headers, url: '/api/data' }, res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error, 'unauthorized');
  }
});

test('503: getRedis が null', async () => {
  const res = await run(null, { method: 'GET' });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'redis_unavailable');
  assert.equal(res.body.redis_ok, false);
});

test('GET 通常: data と version を返す', async () => {
  const r = fakeRedis({ 'circle:data': { a: 1 }, 'circle:version': 7 });
  const res = await run(r, { method: 'GET' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { data: { a: 1 }, version: 7, redis_ok: true });
});

test('GET 通常: 未保存なら空データ・版0', async () => {
  const res = await run(fakeRedis(), { method: 'GET' });
  assert.deepEqual(res.body, { data: {}, version: 0, redis_ok: true });
});

test('GET ?v=1（req.query）: 版のみ・Redis コマンド1回', async () => {
  const r = fakeRedis({ 'circle:data': { a: 1 }, 'circle:version': 7 });
  const res = await run(r, { method: 'GET', query: { v: '1' } });
  assert.deepEqual(res.body, { version: 7, redis_ok: true });
  assert.equal(r.calls, 1);
});

test('GET ?v=1（req.url のみ）: 版のみ・Redis コマンド1回', async () => {
  const r = fakeRedis({ 'circle:version': 3 });
  const res = await run(r, { method: 'GET', url: '/api/data?v=1' });
  assert.deepEqual(res.body, { version: 3, redis_ok: true });
  assert.equal(r.calls, 1);
});

test('GET: 文字列で保存されたデータを復元できる', async () => {
  const r = fakeRedis({ 'circle:data': JSON.stringify({ a: 1 }), 'circle:version': 2 });
  const res = await run(r, { method: 'GET' });
  assert.deepEqual(res.body.data, { a: 1 });
});

test('POST: expectedVersion が無い / 文字列 / 負 / 小数 は 400', async () => {
  for (const ev of [undefined, '0', -1, 1.5, null]) {
    const r = fakeRedis();
    const res = await run(r, { method: 'POST', body: { data: { a: 1 }, expectedVersion: ev } });
    assert.equal(res.statusCode, 400, String(ev));
    assert.equal(res.body.error, 'expected_version_required');
    assert.equal(r.calls, 0);
  }
});

test('POST: data が配列 / 非オブジェクト / 無し は 400 invalid_payload', async () => {
  for (const data of [[], 'x', null, undefined, 5]) {
    const res = await run(fakeRedis(), { method: 'POST', body: { data, expectedVersion: 0 } });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'invalid_payload');
  }
  const res = await run(fakeRedis(), { method: 'POST' });
  assert.equal(res.body.error, 'invalid_payload');
});

test('POST: 正常保存で版が+1され、データが入る', async () => {
  const r = fakeRedis({ 'circle:version': 4 });
  const res = await run(r, { method: 'POST', body: { data: { x: 'あ' }, expectedVersion: 4 } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, version: 5, redis_ok: true });
  assert.deepEqual(r.store['circle:data'], { x: 'あ' });
  assert.equal(r.store['circle:version'], 5);
  assert.equal(r.calls, 1); // 往復は eval の1回だけ
});

test('POST: 初回保存（版0）', async () => {
  const r = fakeRedis();
  const res = await run(r, { method: 'POST', body: { data: {}, expectedVersion: 0 } });
  assert.equal(res.body.version, 1);
});

test('POST: 古い版は 409 と currentData、データは変わらない', async () => {
  const r = fakeRedis({ 'circle:data': { old: true }, 'circle:version': 9 });
  const res = await run(r, { method: 'POST', body: { data: { n: 1 }, expectedVersion: 8 } });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'version_conflict');
  assert.equal(res.body.currentVersion, 9);
  assert.deepEqual(res.body.currentData, { old: true });
  assert.deepEqual(r.store['circle:data'], { old: true });
  assert.equal(r.store['circle:version'], 9);
});

test('POST: 同時保存は片方だけが成功する', async () => {
  const r = fakeRedis({ 'circle:version': 1 });
  const [a, b] = await Promise.all([
    run(r, { method: 'POST', body: { data: { who: 'a' }, expectedVersion: 1 } }),
    run(r, { method: 'POST', body: { data: { who: 'b' }, expectedVersion: 1 } }),
  ]);
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409]);
});

test('POST: 900KB 超は 413', async () => {
  const r = fakeRedis();
  const big = { s: 'x'.repeat(900001) };
  const res = await run(r, { method: 'POST', body: { data: big, expectedVersion: 0 } });
  assert.equal(res.statusCode, 413);
  assert.equal(res.body.error, 'payload_too_large');
  assert.ok(res.body.bytes > 900000);
  assert.match(res.body.message, /保存データが大きすぎます（約\d+KB）/);
  assert.equal(r.calls, 0);
});

test('POST: 日本語はバイト数で数える（文字数では収まる量でも超える）', async () => {
  const res = await run(fakeRedis(), { method: 'POST', body: { data: { s: 'あ'.repeat(300000) }, expectedVersion: 0 } });
  assert.equal(res.statusCode, 413);
});

test('Redis が例外を投げたら 503 と console.error', async () => {
  const r = fakeRedis();
  r.get = async () => { throw new Error('boom'); };
  r.eval = async () => { throw new Error('boom'); };
  const orig = console.error; let logged = 0; console.error = () => { logged++; };
  try {
    const g = await run(r, { method: 'GET' });
    const p = await run(r, { method: 'POST', body: { data: {}, expectedVersion: 0 } });
    assert.equal(g.statusCode, 503); assert.equal(p.statusCode, 503);
    assert.equal(g.body.error, 'redis_unavailable');
    assert.equal(logged, 2);
  } finally { console.error = orig; }
});

test('PUT は 405 と Allow ヘッダー', async () => {
  const res = await run(fakeRedis(), { method: 'PUT' });
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, 'GET, POST');
});

test('Cache-Control: no-store', async () => {
  const res = await run(fakeRedis(), { method: 'GET' });
  assert.equal(res.headers['Cache-Control'], 'no-store');
});
