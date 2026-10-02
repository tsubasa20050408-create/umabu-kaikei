// 領収書写真の保管庫。メインデータ（circle:data）に画像を入れると、保存や同期のたびに数MBを送ることになり、
// 端末の localStorage（約5MB）も数十枚で満杯になるため、1枚ずつ別キーに置く。
// 削除 API は意図的に作らない。会計の証跡なので、取引を消しても画像は残す（1枚約200KB・1000枚で約200MB、従量課金で月数円）。
// id は原寸 data URL の SHA-256 から作る内容アドレス。同じ写真は同じ id になるので、移行のやり直しや複数端末の同時アップロードが冪等になり、
// サーバーで照合するので既存の id を別の画像で上書きする（証跡の改ざん）こともできない。
// テストで偽の Redis を差し込めるよう、依存は引数で受け取る（import してよいのは node:crypto だけ）。
import { createHash } from 'node:crypto';

const FULL_PREFIX = 'circle:receipt:';
const THUMB_PREFIX = 'circle:receipt:thumb:';
const ID_RE = /^r[0-9a-f]{32}$/;
// クライアントの isImageDataUrl と同じ（svg 等のスクリプトを含み得る形式は拒否）
const IMG_RE = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const MAX_FULL = 2000000; // Vercel の本文上限 4.5MB に十分収まる
const MAX_THUMB = 60000;
const MAX_THUMBS = 50;

function unavailable(res, message) {
  return res.status(503).json({ error: 'redis_unavailable', redis_ok: false, message });
}

// @upstash/redis は値の JSON 解釈を試みる。画像は文字列のはずなので、それ以外は無いものとして扱う
const revive = (v) => (typeof v === 'string' ? v : null);
const idOf = (data) => 'r' + createHash('sha256').update(data, 'utf8').digest('hex').slice(0, 32);

export function createReceiptHandler({ getRedis, verifyToken }) {
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
        if (q.thumbs !== undefined) {
          // 形式の正しい id だけ・重複除去。一覧表示用に1コマンドでまとめて取る
          const ids = [...new Set(String(q.thumbs).split(',').filter((s) => ID_RE.test(s)))];
          if (ids.length > MAX_THUMBS) return res.status(400).json({ error: 'too_many' });
          const thumbs = {};
          if (ids.length) {
            const vals = await redis.mget(...ids.map((i) => THUMB_PREFIX + i));
            ids.forEach((id, n) => { thumbs[id] = revive(vals && vals[n]); });
          }
          return res.status(200).json({ thumbs });
        }
        const id = q.id;
        if (typeof id !== 'string' || !ID_RE.test(id)) return res.status(400).json({ error: 'invalid_id' });
        const data = revive(await redis.get(FULL_PREFIX + id));
        if (!data) return res.status(404).json({ error: 'not_found' });
        return res.status(200).json({ id, data });
      }

      if (req.method === 'POST') {
        const { id, data, thumb } = req.body || {};
        if (typeof id !== 'string' || !ID_RE.test(id)) return res.status(400).json({ error: 'invalid_id' });
        if (typeof data !== 'string' || !IMG_RE.test(data)) return res.status(400).json({ error: 'invalid_image' });
        if (data.length > MAX_FULL) return res.status(413).json({ error: 'image_too_large' });
        if (typeof thumb !== 'string' || !IMG_RE.test(thumb) || thumb.length > MAX_THUMB) return res.status(400).json({ error: 'invalid_thumb' });
        if (idOf(data) !== id) return res.status(400).json({ error: 'id_mismatch' });
        // 原寸は同じ内容なので上書きして構わない。サムネイルは最初の1回だけ（NX）
        const p = redis.pipeline();
        p.set(FULL_PREFIX + id, data);
        p.set(THUMB_PREFIX + id, thumb, { nx: true });
        await p.exec();
        return res.status(200).json({ ok: true, id });
      }
    } catch (e) {
      console.error('[api/receipt] Redis error:', e && e.message ? e.message : e);
      return unavailable(res, 'Upstash に接続できません。データベースが削除されたか、接続情報が正しくない可能性があります。');
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).end();
  };
}
