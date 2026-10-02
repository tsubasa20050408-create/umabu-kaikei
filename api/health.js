// 設定ミスを切り分けるための診断用エンドポイント。
// _lib.js を import しない：環境変数の不備で _lib.js が起動できない状況でも
// 「何が足りないのか」を答えられる必要があるため（_redis-env.js は import を持たないので安全）。
// 値そのものは絶対に返さず、設定されているかどうかと、読んでいる変数の「名前」だけを返す。
import { redisEnv } from './_redis-env.js';

const val = (n) => (process.env[n] || '').trim();
const has = (n) => Boolean(val(n));

async function pingRedis() {
  const cfg = redisEnv();
  if (!cfg) return { configured: false, reachable: false, detail: '未設定', source: null };
  try {
    const r = await fetch(`${cfg.url.replace(/\/$/, '')}/ping`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
    });
    if (!r.ok) return { configured: true, reachable: false, detail: `HTTP ${r.status}`, source: cfg.source };
    return { configured: true, reachable: true, detail: 'OK', source: cfg.source };
  } catch (e) {
    return { configured: true, reachable: false, detail: '接続できません', source: cfg.source };
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const pin = val('CIRCLE_PIN');
  const redis = await pingRedis();

  const checks = {
    CIRCLE_PIN: has('CIRCLE_PIN'),
    // 4桁でないとロック画面から入力できず、正しいPINでもログインできない
    CIRCLE_PIN_format: /^\d{4}$/.test(pin),
    CIRCLE_SECRET: has('CIRCLE_SECRET'),
    redis_configured: redis.configured,
    redis_reachable: redis.reachable,
  };

  const problems = Object.keys(checks).filter((k) => !checks[k]);
  const fatal = problems.filter((k) => k.startsWith('CIRCLE_'));

  res.status(fatal.length ? 503 : 200).json({
    ok: problems.length === 0,
    checks,
    problems,
    redis: redis.detail,
    // アプリが実際に使っている接続情報の変数名（値は出さない）
    redis_source: redis.source,
    // どの仕組みで接続情報が入っているかの判別用（名前のみ）。
    // Vercel の Storage 連携は KV_URL 等もまとめて注入するので、手で設定した場合と見分けがつく。
    storage_env: ['CIRCLE_REDIS_REST_URL', 'CIRCLE_REDIS_REST_TOKEN',
      'KV_URL', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'KV_REST_API_READ_ONLY_TOKEN',
      'REDIS_URL', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']
      .filter(has),
    hint: fatal.length
      ? 'Vercel の Settings → Environment Variables で不足分を設定し、再デプロイしてください。アプリはこの状態では開けません。'
      : problems.length
        ? 'アプリは開けますが、データがこの端末にしか保存されません。Upstash の設定を確認してください。'
        : '設定はすべて揃っています。',
  });
}
