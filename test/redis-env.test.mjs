import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redisEnv, REDIS_ENV_PAIRS } from '../api/_redis-env.js';

test('何も無ければ null', () => assert.equal(redisEnv({}), null));

test('優先順位: CIRCLE_ > UPSTASH_ > KV_', () => {
  const env = {
    KV_REST_API_URL: 'kv-url', KV_REST_API_TOKEN: 'kv-tok',
    UPSTASH_REDIS_REST_URL: 'up-url', UPSTASH_REDIS_REST_TOKEN: 'up-tok',
    CIRCLE_REDIS_REST_URL: 'c-url', CIRCLE_REDIS_REST_TOKEN: 'c-tok',
  };
  assert.equal(redisEnv(env).url, 'c-url');
  delete env.CIRCLE_REDIS_REST_URL;
  assert.equal(redisEnv(env).url, 'up-url');
  delete env.UPSTASH_REDIS_REST_TOKEN;
  assert.equal(redisEnv(env).url, 'kv-url');
  assert.equal(redisEnv(env).token, 'kv-tok');
});

test('組の完全性: URL だけ / トークンだけの組は採用しない（別の組を混ぜない）', () => {
  assert.equal(redisEnv({ CIRCLE_REDIS_REST_URL: 'u' }), null);
  assert.equal(redisEnv({ UPSTASH_REDIS_REST_TOKEN: 't' }), null);
  const r = redisEnv({ CIRCLE_REDIS_REST_URL: 'c-url', UPSTASH_REDIS_REST_URL: 'u-url', UPSTASH_REDIS_REST_TOKEN: 'u-tok' });
  assert.deepEqual([r.url, r.token], ['u-url', 'u-tok']);
});

test('空白と引用符を除去する', () => {
  const r = redisEnv({ UPSTASH_REDIS_REST_URL: '  "https://x.upstash.io"  ', UPSTASH_REDIS_REST_TOKEN: " 'abc' " });
  assert.equal(r.url, 'https://x.upstash.io');
  assert.equal(r.token, 'abc');
});

test('空白だけの値は未設定扱い', () => {
  assert.equal(redisEnv({ UPSTASH_REDIS_REST_URL: '   ', UPSTASH_REDIS_REST_TOKEN: 't' }), null);
});

test('source は変数名のみで値を含まない', () => {
  const r = redisEnv({ KV_REST_API_URL: 'secret-url', KV_REST_API_TOKEN: 'secret-token' });
  assert.equal(r.source, 'KV_REST_API_URL / KV_REST_API_TOKEN');
  assert.ok(!r.source.includes('secret'));
});

test('探索する組は3つ', () => assert.equal(REDIS_ENV_PAIRS.length, 3));
