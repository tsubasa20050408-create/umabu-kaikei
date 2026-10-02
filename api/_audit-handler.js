// 操作ログの保管庫。メインデータに全件を持つと 1MB 制限で保存が止まるため、古い分をここへ逃がす。
// テストで偽の Redis を差し込めるよう、依存は import せず引数で受け取る（このファイルは何も import しない）。
const AUDIT_KEY = 'circle:audit'; // リスト。先頭が新しい
const AUDIT_ARCHIVE_MAX = 5000;

function unavailable(res, message) {
  return res.status(503).json({ error: 'redis_unavailable', redis_ok: false, message });
}

const revive = (v) => { if (typeof v === 'string') { try { return JSON.parse(v); } catch { return v; } } return v; };
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : d; };

export function createAuditHandler({ getRedis, verifyToken }) {
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
        let q = req.query;
        if (!q) { try { q = Object.fromEntries(new URL(req.url || '/', 'http://x').searchParams); } catch { q = {}; } }
        const offset = Math.max(0, num(q.offset, 0));
        const limit = Math.min(1000, Math.max(1, num(q.limit, 500)));
        const raw = await redis.lrange(AUDIT_KEY, offset, offset + limit - 1);
        const entries = (raw || []).map(revive);
        return res.status(200).json({ entries, redis_ok: true });
      }

      if (req.method === 'POST') {
        const { entries } = req.body || {};
        const valid = Array.isArray(entries) && entries.length >= 1 && entries.length <= 1000
          && entries.every((e) => e && typeof e === 'object' && !Array.isArray(e) && typeof e.ts === 'string' && typeof e.action === 'string');
        if (!valid) return res.status(400).json({ error: 'invalid_entries' });
        // クライアントは新しい順で送る。LPUSH は後に積んだものが先頭に来るので、古い順に並べ替えてから積む
        const tx = redis.multi();
        tx.lpush(AUDIT_KEY, ...entries.slice().reverse());
        tx.ltrim(AUDIT_KEY, 0, AUDIT_ARCHIVE_MAX - 1);
        await tx.exec();
        return res.status(200).json({ ok: true, count: entries.length });
      }
    } catch (e) {
      console.error('[api/audit] Redis error:', e && e.message ? e.message : e);
      return unavailable(res, 'Upstash に接続できません。データベースが削除されたか、接続情報が正しくない可能性があります。');
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).end();
  };
}
