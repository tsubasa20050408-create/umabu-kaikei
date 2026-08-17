// 設定ミスを切り分けるための診断用エンドポイント。
// _lib.js を import しない：環境変数の不備で _lib.js が起動できない状況でも
// 「何が足りないのか」を答えられる必要があるため。
// 値そのものは絶対に返さず、設定されているかどうかだけを返す。

const val = (n) => (process.env[n] || '').trim();
const has = (n) => Boolean(val(n));

async function pingRedis() {
  const url = val('KV_REST_API_URL') || val('UPSTASH_REDIS_REST_URL');
  const token = val('KV_REST_API_TOKEN') || val('UPSTASH_REDIS_REST_TOKEN');
  if (!url || !token) return { configured: false, reachable: false, detail: '未設定' };
  try {
    const r = await fetch(`${url.replace(/\/$/, '')}/ping`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return { configured: true, reachable: false, detail: `HTTP ${r.status}` };
    return { configured: true, reachable: true, detail: 'OK' };
  } catch (e) {
    return { configured: true, reachable: false, detail: '接続できません' };
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
    hint: fatal.length
      ? 'Vercel の Settings → Environment Variables で不足分を設定し、再デプロイしてください。アプリはこの状態では開けません。'
      : problems.length
        ? 'アプリは開けますが、データがこの端末にしか保存されません。Upstash の設定を確認してください。'
        : '設定はすべて揃っています。',
  });
}
