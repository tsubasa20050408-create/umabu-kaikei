import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReceiptHandler } from '../api/_receipt-handler.js';

// @upstash/redis と同じく set の nx、mget、pipeline を持つ偽物
function fakeRedis(init = {}) {
  const store = { ...init };
  const r = {
    store, pipelines: 0, mgets: 0,
    async get(k) { return k in store ? store[k] : null; },
    async set(k, v, o) { if (o && o.nx && k in store) return null; store[k] = v; return 'OK'; },
    async mget(...ks) { r.mgets++; return ks.map((k) => (k in store ? store[k] : null)); },
    pipeline() {
      r.pipelines++;
      const ops = [];
      const p = { set(k, v, o) { ops.push(() => r.set(k, v, o)); return p; }, async exec() { return Promise.all(ops.map((f) => f())); } };
      return p;
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
  const h = createReceiptHandler({ getRedis: () => redis, verifyToken });
  const res = mkRes();
  await h({ headers, url: '/api/receipt', ...req }, res);
  return res;
};
const idOf = (d) => 'r' + createHash('sha256').update(d, 'utf8').digest('hex').slice(0, 32);
const img = (s) => 'data:image/jpeg;base64,' + Buffer.from(s).toString('base64');
const FULL = img('full-image-bytes-1'), THUMB = img('thumb-1');
const post = (redis, over = {}) => run(redis, { method: 'POST', body: { id: idOf(FULL), data: FULL, thumb: THUMB, ...over } });
const FK = (id) => 'circle:receipt:' + id, TK = (id) => 'circle:receipt:thumb:' + id;

test('401: トークン無し / 不正', async () => {
  for (const headers of [{}, { authorization: 'Bearer bad' }]) {
    const res = await run(fakeRedis(), { method: 'GET', query: {} }, headers);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error, 'unauthorized');
    assert.equal(res.headers['Cache-Control'], 'no-store');
  }
});

test('503: getRedis が null', async () => {
  const res = await run(null, { method: 'GET', query: {} });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'redis_unavailable');
});

test('POST 正常: 原寸とサムネイルの2キーを pipeline 1往復で保存', async () => {
  const r = fakeRedis();
  const res = await post(r);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, id: idOf(FULL) });
  assert.equal(r.store[FK(idOf(FULL))], FULL);
  assert.equal(r.store[TK(idOf(FULL))], THUMB);
  assert.equal(r.pipelines, 1);
});

test('POST: 同じ内容の再送は 200、サムネイルは最初の1回だけ（NX）', async () => {
  const r = fakeRedis();
  await post(r);
  const res = await post(r, { thumb: img('another-thumb') });
  assert.equal(res.statusCode, 200);
  assert.equal(r.store[TK(idOf(FULL))], THUMB);
  assert.equal(r.store[FK(idOf(FULL))], FULL);
});

test('POST 400: id 不正', async () => {
  for (const id of [undefined, 5, 'x', 'R' + '0'.repeat(32), 'r' + '0'.repeat(31), 'r' + 'g'.repeat(32), 'r' + '0'.repeat(33)]) {
    const r = fakeRedis();
    const res = await post(r, { id });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'invalid_id');
    assert.deepEqual(r.store, {});
  }
  assert.equal((await run(fakeRedis(), { method: 'POST' })).body.error, 'invalid_id');
});

test('POST 400: data 形式不正（svg・非 base64・文字列以外）', async () => {
  for (const data of [undefined, 1, 'data:image/svg+xml;base64,AAAA', 'data:text/html;base64,AAAA', 'data:image/png;base64,<script>', 'http://x/a.png']) {
    const r = fakeRedis();
    const res = await post(r, { data });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'invalid_image');
    assert.deepEqual(r.store, {});
  }
});

test('POST 413: 原寸が 2000000 文字超（ちょうどは通る）', async () => {
  const head = 'data:image/jpeg;base64,';
  const big = head + 'A'.repeat(2000001 - head.length);
  const r = fakeRedis();
  const res = await post(r, { id: idOf(big), data: big });
  assert.equal(res.statusCode, 413);
  assert.equal(res.body.error, 'image_too_large');
  assert.deepEqual(r.store, {});
  const edge = head + 'A'.repeat(2000000 - head.length);
  assert.equal((await post(fakeRedis(), { id: idOf(edge), data: edge })).statusCode, 200);
});

test('POST 400: thumb 不正・60000 文字超（ちょうどは通る）', async () => {
  const head = 'data:image/jpeg;base64,';
  for (const thumb of [undefined, 'x', 'data:image/svg+xml;base64,AAAA', head + 'A'.repeat(60001 - head.length)]) {
    const r = fakeRedis();
    const res = await post(r, { thumb });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'invalid_thumb');
    assert.deepEqual(r.store, {});
  }
  const ok = head + 'A'.repeat(60000 - head.length);
  assert.equal((await post(fakeRedis(), { thumb: ok })).statusCode, 200);
});

test('POST 400: id_mismatch（別画像での上書き＝改ざんを防ぐ）', async () => {
  const r = fakeRedis();
  await post(r);
  const evil = img('evil');
  const res = await post(r, { id: idOf(FULL), data: evil });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'id_mismatch');
  assert.equal(r.store[FK(idOf(FULL))], FULL);
});

test('GET ?id= 有: 原寸を返す / 無: 404 / 不正: 400', async () => {
  const r = fakeRedis();
  await post(r);
  const ok = await run(r, { method: 'GET', query: { id: idOf(FULL) } });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.body, { id: idOf(FULL), data: FULL });
  const none = await run(r, { method: 'GET', query: { id: 'r' + 'a'.repeat(32) } });
  assert.equal(none.statusCode, 404);
  assert.equal(none.body.error, 'not_found');
  for (const id of [undefined, 'zzz', 'r' + 'A'.repeat(32)]) {
    const bad = await run(r, { method: 'GET', query: { id } });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.body.error, 'invalid_id');
  }
});

test('GET: req.query が無ければ req.url から読む', async () => {
  const r = fakeRedis();
  await post(r);
  const res = await run(r, { method: 'GET', url: '/api/receipt?id=' + idOf(FULL) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data, FULL);
  const t = await run(r, { method: 'GET', url: '/api/receipt?thumbs=' + idOf(FULL) });
  assert.equal(t.body.thumbs[idOf(FULL)], THUMB);
});

test('GET ?thumbs=: 欠けは null・重複除去・不正 id 無視・mget 1コマンド', async () => {
  const r = fakeRedis();
  await post(r);
  const miss = 'r' + 'b'.repeat(32), a = idOf(FULL);
  const res = await run(r, { method: 'GET', query: { thumbs: [a, miss, a, 'bad', '', 'r' + 'B'.repeat(32)].join(',') } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.thumbs, { [a]: THUMB, [miss]: null });
  assert.equal(r.mgets, 1);
  const none = await run(r, { method: 'GET', query: { thumbs: 'bad' } });
  assert.deepEqual(none.body, { thumbs: {} });
  assert.equal(r.mgets, 1);
});

test('GET ?thumbs=: 文字列以外の値は null 扱い', async () => {
  const id = 'r' + 'c'.repeat(32);
  const r = fakeRedis({ [TK(id)]: { x: 1 } });
  const res = await run(r, { method: 'GET', query: { thumbs: id } });
  assert.equal(res.body.thumbs[id], null);
});

test('GET ?thumbs=: 50件ちょうどは通り、51件は 400 too_many', async () => {
  const ids = Array.from({ length: 51 }, (_, i) => 'r' + i.toString(16).padStart(32, '0'));
  const ok = await run(fakeRedis(), { method: 'GET', query: { thumbs: ids.slice(0, 50).join(',') } });
  assert.equal(ok.statusCode, 200);
  assert.equal(Object.keys(ok.body.thumbs).length, 50);
  const ng = await run(fakeRedis(), { method: 'GET', query: { thumbs: ids.join(',') } });
  assert.equal(ng.statusCode, 400);
  assert.equal(ng.body.error, 'too_many');
});

test('503: Redis 例外で console.error', async () => {
  const orig = console.error; let logged = 0; console.error = () => { logged++; };
  try {
    for (const [method, k] of [['GET', 'get'], ['GET', 'mget'], ['POST', 'pipeline']]) {
      const r = fakeRedis();
      r[k] = () => { throw new Error('boom'); };
      const req = method === 'POST' ? { method, body: { id: idOf(FULL), data: FULL, thumb: THUMB } }
        : { method, query: k === 'get' ? { id: idOf(FULL) } : { thumbs: idOf(FULL) } };
      const res = await run(r, req);
      assert.equal(res.statusCode, 503);
      assert.equal(res.body.error, 'redis_unavailable');
    }
    assert.equal(logged, 3);
  } finally { console.error = orig; }
});

test('PUT は 405 と Allow', async () => {
  const res = await run(fakeRedis(), { method: 'PUT' });
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, 'GET, POST');
});
