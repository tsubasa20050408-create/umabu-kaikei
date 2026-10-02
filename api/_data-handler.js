// テストで偽の Redis を差し込めるよう、依存は import せず引数で受け取る（このファイルは何も import しない）。
const DATA_KEY = 'circle:data';
const VERSION_KEY = 'circle:version';
// 実際に効く上限は Vercel の関数が受け取れる本文の 4.5MB（Upstash 側は1リクエスト 10MB まで）。
// それを超えると Vercel が原因の分からないエラーを返すので、手前で理由付きの 413 を返す。
const MAX_BYTES = 4000000;

// 版の確認と書き込みを別々に行うと、同時保存で他端末の更新が消える。Lua で1往復・アトミックにする。
const CAS_SCRIPT = `
local cur = tonumber(redis.call('GET', KEYS[2]) or '0') or 0
if cur ~= tonumber(ARGV[2]) then return {0, cur} end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], cur + 1)
return {1, cur + 1}
`;

// 保存先に届いていないのに成功を返すと、利用者は保存できたと誤解して原本を失う。
// 未設定も接続不能もまとめて「保存先が使えない」と分かる形に正規化する。
function unavailable(res, message) {
  return res.status(503).json({ error: 'redis_unavailable', redis_ok: false, message });
}

// 2重にエンコードされて保存されていても壊れないよう、文字列ならオブジェクトへ戻す
function revive(v) {
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return v; } }
  return v;
}

export function createDataHandler({ getRedis, verifyToken }) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');

    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token || !verifyToken(token)) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const redis = getRedis();
    if (!redis) {
      return unavailable(res, 'Upstash の接続情報が設定されていないか、正しくありません。/api/health で確認できます。');
    }

    try {
      if (req.method === 'GET') {
        // 定期確認では版番号だけを返し、全データの転送と Redis コマンドを節約する
        let v = req.query?.v;
        if (v === undefined) { try { v = new URL(req.url || '/', 'http://x').searchParams.get('v'); } catch { v = null; } }
        if (v) {
          const version = await redis.get(VERSION_KEY);
          return res.status(200).json({ version: Number(version) || 0, redis_ok: true });
        }
        const [data, version] = await Promise.all([
          redis.get(DATA_KEY),
          redis.get(VERSION_KEY),
        ]);
        return res.status(200).json({ data: revive(data) || {}, version: Number(version) || 0, redis_ok: true });
      }

      if (req.method === 'POST') {
        const { data, expectedVersion } = req.body || {};
        if (typeof data !== 'object' || data === null || Array.isArray(data)) {
          return res.status(400).json({ error: 'invalid_payload' });
        }
        // 省略を許すと楽観ロックを回避して他端末の更新を上書きできてしまう
        if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
          return res.status(400).json({ error: 'expected_version_required' });
        }
        const json = JSON.stringify(data);
        const bytes = Buffer.byteLength(json);
        if (bytes > MAX_BYTES) {
          return res.status(413).json({
            error: 'payload_too_large', bytes,
            message: `保存データが大きすぎます（約${Math.round(bytes / 1024)}KB）。操作ログや領収書以外のデータを整理してください。`,
          });
        }
        const r = await redis.eval(CAS_SCRIPT, [DATA_KEY, VERSION_KEY], [json, String(expectedVersion)]);
        const [ok, version] = Array.isArray(r) ? r.map(Number) : [0, 0];
        if (ok !== 1) {
          const currentData = revive(await redis.get(DATA_KEY));
          return res.status(409).json({ error: 'version_conflict', currentVersion: version, currentData: currentData || {} });
        }
        return res.status(200).json({ ok: true, version, redis_ok: true });
      }
    } catch (e) {
      // 利用者には原因の要約だけ返し、詳細は Vercel の Logs で追えるように残す
      console.error('[api/data] Redis error:', e && e.message ? e.message : e);
      return unavailable(res, 'Upstash に接続できません。データベースが削除されたか、接続情報が正しくない可能性があります。');
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).end();
  };
}
