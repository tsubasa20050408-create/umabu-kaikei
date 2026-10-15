// Phase 3 クライアントテスト（spec §8）。領収書写真を IndexedDB + /api/receipt へ移した変更の検証。
// 使い方: リポジトリ直下で `python -m http.server 3120 --bind 127.0.0.1` を起動し、http://127.0.0.1:3120/index.html をブラウザで開いて、
// DevTools のコンソールか javascript_tool にこのファイル全体を貼る（結果は PASS/FAIL の文字列。window.__phase3Result にも入る）。
// window.fetch を /api/data・/api/audit・/api/receipt の偽サーバーに差し替えるので、本番にも Upstash にも一切通信しない。
(async () => {
const R = []; window.__phase3Partial = R;
const ok = (name, cond, extra) => R.push((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) return false; await sleep(25); } return true; };
Object.defineProperty(document, 'hidden', { value: false, configurable: true });
const realFetch = window.fetch, realToast = window.showToast, realConfirm = window.confirm, realDl = window.dlBlob, realAuthFail = window.handleAuthFailure;
const realDbP = rcDbP;
const log = [], toasts = [];
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });
const srv = { version: 5, data: {}, mode: 'ok', rcMode: 'ok', failAfter: null, okCount: 0, badIds: new Set(), fullOverride: {}, thumbOverride: {}, delay: {}, inflight: 0, maxInflight: 0, receipts: new Map() };
const ID_RE = /^r[0-9a-f]{32}$/;
window.fetch = async (url, opt = {}) => {
  url = String(url); const m = opt.method || 'GET';
  if (!url.startsWith('/api/')) { log.push({ url, m, external: true }); return realFetch(url, opt); }
  const entry = { url, m, body: opt.body }; log.push(entry);
  if (url.startsWith('/api/audit')) return J(m === 'GET' ? { entries: [], redis_ok: true } : { ok: true, count: 0 });
  if (url.startsWith('/api/data')) {
    if (srv.mode === 'offline') return J({ error: 'offline' }, 503);
    if (m === 'GET') return url.includes('v=1') ? J({ version: srv.version, redis_ok: true }) : J({ data: srv.data, version: srv.version, redis_ok: true });
    const b = JSON.parse(opt.body);
    if (b.expectedVersion !== srv.version) return J({ error: 'version_conflict', currentVersion: srv.version, currentData: srv.data }, 409);
    srv.version++; srv.data = b.data; return J({ ok: true, version: srv.version, redis_ok: true });
  }
  if (url.startsWith('/api/receipt')) {
    if (srv.rcMode === 'offline') return J({ error: 'offline' }, 503);
    if (srv.rcMode === 'redis') return J({ error: 'redis_unavailable', redis_ok: false }, 503);
    if (srv.rcMode === '401') return J({ error: 'unauthorized' }, 401);
    if (m === 'POST') {
      if (srv.failAfter !== null && srv.okCount >= srv.failAfter) return J({ error: 'offline' }, 503);
      srv.inflight++; srv.maxInflight = Math.max(srv.maxInflight, srv.inflight);
      try {
        await sleep(5);
        const b = JSON.parse(opt.body);
        if (!ID_RE.test(b.id)) return J({ error: 'invalid_id' }, 400);
        if (srv.badIds.has(b.id)) return J({ error: 'invalid_image' }, 400);
        if ('r' + (await sha256(b.data)).slice(0, 32) !== b.id) return J({ error: 'id_mismatch' }, 400);
        if (!srv.receipts.has(b.id)) srv.receipts.set(b.id, { data: b.data, thumb: b.thumb });
        srv.okCount++;
        return J({ ok: true, id: b.id });
      } finally { srv.inflight--; }
    }
    const u = new URL(url, location.origin);
    if (u.searchParams.has('thumbs')) {
      const out = {}; for (const id of u.searchParams.get('thumbs').split(',')) out[id] = id in srv.thumbOverride ? srv.thumbOverride[id] : (srv.receipts.get(id)?.thumb ?? null);
      return J({ thumbs: out });
    }
    const id = u.searchParams.get('id');
    if (srv.delay[id]) await sleep(srv.delay[id]);
    if (id in srv.fullOverride) return J({ id, data: srv.fullOverride[id] });
    return srv.receipts.has(id) ? J({ id, data: srv.receipts.get(id).data }) : J({ error: 'not_found' }, 404);
  }
  return J({}, 404);
};
window.showToast = m => toasts.push(m);
window.confirm = () => true;
let lastBlob = null; window.dlBlob = (b, n) => { lastBlob = { b, n }; };
let authFails = 0; window.handleAuthFailure = () => { authFails++; };
const posts = p => log.filter(l => l.m === 'POST' && l.url.startsWith(p));
const getsThumbs = () => log.filter(l => l.m === 'GET' && l.url.startsWith('/api/receipt?thumbs='));
const getsFull = () => log.filter(l => l.m === 'GET' && l.url.startsWith('/api/receipt?id='));

// ---- 道具
const idbClear = async () => { const db = await rcDb(); if (db) await rcTx(db, 'readwrite', s => s.clear()); rcMem.clear(); };
const idbAll = () => rcAll();
const settle = async () => { await until(() => !receiptUploading && !legacyMigrating && !isSyncing && !persistTimer, 30000); await sleep(80); await until(() => !receiptUploading && !legacyMigrating && !isSyncing, 30000); };
const LS_KEYS = ['circle_receipts', 'circle_unsynced', 'circle_server_version', 'circle_data', 'circle_audit_outbox'];
const reset = async () => {
  await settle();
  rcDbP = realDbP;
  sessionStorage.setItem('circle_token', 'tok'); clearTimeout(persistTimer); persistTimer = null;
  syncDirty = false; syncOffline = false; isSyncing = false; persistPending = false; lastServerVersion = 5;
  Object.assign(srv, { version: 5, data: {}, mode: 'ok', rcMode: 'ok', failAfter: null, okCount: 0, badIds: new Set(), fullOverride: {}, thumbOverride: {}, delay: {}, inflight: 0, maxInflight: 0 });
  srv.receipts.clear();
  await idbClear(); thumbCache.clear(); thumbMiss.clear(); thumbBusy.clear(); legacyIdMap.clear(); legacyBadWarned = false; rcMemWarned = false;
  rcGen++; rcScanGen = -1; receiptPendingN = 0; receiptRerun = false; authFails = 0;
  transactions = []; auditLog = []; auditOutbox = []; modalReceiptIds = []; quickReceiptTxId = null;
  LS_KEYS.forEach(k => localStorage.removeItem(k));
  log.length = 0; toasts.length = 0; lastBlob = null;
  document.getElementById('receiptDialog').classList.remove('open'); document.getElementById('modalOverlay').classList.remove('open');
  updateSyncIndicator();
};
// ノイズ入りの画像（blk 画素ごとの乱数ブロック。blk が小さいほど圧縮後に大きくなる）
const mkCanvasBlob = (w, h, seed, { blk = 3, q = 0.8, type = 'image/jpeg' } = {}) => new Promise(res => {
  const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d');
  let s = (seed * 2654435761) >>> 0;
  for (let y = 0; y < h; y += blk) for (let xx = 0; xx < w; xx += blk) { s = (s * 1664525 + 1013904223) >>> 0; x.fillStyle = `rgb(${s >>> 24},${(s >>> 16) & 255},${(s >>> 8) & 255})`; x.fillRect(xx, y, blk, blk); }
  c.toBlob(b => res(b), type, q);
});
const mkFile = async (w, h, seed, o) => new File([await mkCanvasBlob(w, h, seed, o)], 'p' + seed + '.jpg', { type: 'image/jpeg' });
const blobToDataUrl = b => new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); });
const mkTx = (id, extra = {}) => migrateTx({ id, type: 'income', summary: 'S' + id, payee: '', amount: 100, status: 'done', date: '2026-10-' + String(1 + (parseInt(id.replace(/\D/g, '')) || 0) % 28).padStart(2, '0'), account: '現金', category: '', applied: true, cashBreakdown: null, createdAt: '2026-10-01T00:00:00Z', ...extra });
const serverData = (txs, extra = {}) => ({ counts: { 1000: 1 }, bankBalance: 100, transactions: txs, categories: [...DEFAULT_CATS], budgets: {}, collections: [], auditLog: [], savedAt: '2026-10-01T00:00:00Z', ...extra });
const attach = async (txId, files) => { quickReceiptTxId = txId; await handleQuickReceipt({ target: { files, value: '' } }); };
const imgDim = async (dataUrl) => { const b = await createImageBitmap(dataUrlToBlob(dataUrl)); const r = [b.width, b.height]; b.close(); return r; };
const dataPosts = () => posts('/api/data').map(l => JSON.parse(l.body));
const hasImg = v => JSON.stringify(v).includes('data:image');
let seed = 100;

// ================= 1. 40枚を付けても localStorage に画像が書かれない・送信データは id だけ
await reset();
transactions = Array.from({ length: 8 }, (_, i) => mkTx('t' + i));
for (const t of transactions) { const fs = []; for (let k = 0; k < 5; k++) fs.push(await mkFile(600, 450, seed++)); await attach(t.id, fs); }
await settle();
const allIds = transactions.flatMap(t => t.receiptIds);
ok('1a 40枚が8件の取引に付いた（receiptIds 合計40・重複なし）', allIds.length === 40 && new Set(allIds).size === 40 && allIds.every(isReceiptId), allIds.length);
ok('1b circle_receipts は書かれていない', localStorage.getItem('circle_receipts') === null);
let lsHasImg = false; for (let i = 0; i < localStorage.length; i++) { if ((localStorage.getItem(localStorage.key(i)) || '').includes('data:image')) lsHasImg = true; }
ok('1c localStorage のどのキーにも data:image が無い（circle_data は id のみ）', !lsHasImg && JSON.parse(localStorage.getItem('circle_data')).transactions.every(t => t.receiptIds.length === 5), { circle_data_len: (localStorage.getItem('circle_data') || '').length });
ok('1d /api/data の POST に data URL が無く receiptIds だけ', dataPosts().length >= 1 && dataPosts().every(b => !hasImg(b)) && dataPosts().at(-1).data.transactions.every(t => t.receiptIds.length === 5 && !('receipts' in t)), { posts: dataPosts().length });
ok('1e メモリ上の取引に receipts / receipt が無い', transactions.every(t => !('receipts' in t) && !('receipt' in t)));
const circleDataBytes = (localStorage.getItem('circle_data') || '').length;
ok('1f circle_data は 40枚付けても小さい（20KB 未満）', circleDataBytes < 20000, circleDataBytes);

// ================= 2. 40枚すべてが /api/receipt に POST され、id がハッシュと一致・送信後 uploaded:true
const rp = posts('/api/receipt');
ok('2a POST /api/receipt は40回（二重送信なし）・サーバーに40件', rp.length === 40 && srv.receipts.size === 40, { posts: rp.length, stored: srv.receipts.size });
let hashOk = true, thumbOk = true; for (const [id, v] of srv.receipts) { if ('r' + (await sha256(v.data)).slice(0, 32) !== id) hashOk = false; if (!isImageDataUrl(v.thumb) || v.thumb.length > 60000) thumbOk = false; }
ok('2b サーバーの全 id が原寸 data URL の SHA-256 先頭32桁と一致', hashOk);
ok('2c サムネイルは画像形式で 60000 文字以下', thumbOk);
const recs = await idbAll();
ok('2d IndexedDB に40件・すべて uploaded:true・full を端末キャッシュとして保持', recs.length === 40 && recs.every(r => r.uploaded === true && isImageDataUrl(r.full) && isImageDataUrl(r.thumb)), { n: recs.length });
ok('2e 1枚ずつ送る（サーバー側の同時処理は常に1）', srv.maxInflight === 1, srv.maxInflight);
ok('2f 送信待ち表示は消えている', receiptPendingN === 0 && document.getElementById('syncReceiptPending').style.display === 'none');
const sizes = recs.map(r => r.full.length);
ok('2g 原寸は 100KB 以上の実画像を含み、すべて 900000 文字以下', Math.max(...sizes) >= 100000 && Math.max(...sizes) <= 900000, { max: Math.max(...sizes), min: Math.min(...sizes) });

// ================= 3. 別の端末: IDB が空・thumbCache 無しで applyData → thumbs API → サムネイル、プレビューで原寸
const serverSnapshot = JSON.parse(JSON.stringify(srv.data));
await idbClear(); thumbCache.clear(); thumbMiss.clear(); log.length = 0; rcGen++; rcScanGen = -1;
applyData(JSON.parse(JSON.stringify(serverSnapshot)));
const okThumbs = await until(() => thumbCache.size >= 8);
await sleep(80);
ok('3a 一覧用のサムネイルを /api/receipt?thumbs= で取得（8件の先頭写真を1リクエストで）', okThumbs && getsThumbs().length === 1 && getsThumbs()[0].url.split('=')[1].split(',').length === 8, { reqs: getsThumbs().map(l => l.url.length) });
const imgs = [...document.querySelectorAll('#txList .tx-item img')];
ok('3b 一覧に8枚のサムネイル <img>（data:image）が出て、描き直しは1回で止まる（thumbs の再取得なし）', imgs.length === 8 && imgs.every(i => i.src.startsWith('data:image/')) && getsThumbs().length === 1, { imgs: imgs.length, reqs: getsThumbs().length });
ok('3c サムネイルは IndexedDB にも（uploaded:true・thumb のみ）入った', (await idbAll()).filter(r => r.thumb && !r.full && r.uploaded === true).length === 8);
ok('3d 原寸は取得していない（プレビューを開くまで）', getsFull().length === 0);
const t0 = transactions[0];
showReceipt(t0.id, 0);
const msgEl = document.getElementById('receiptPreviewMsg'), imgEl = document.getElementById('receiptPreviewImg');
ok('3e 開いた直後は「読み込み中…」で画像は出ない', msgEl.textContent === '読み込み中…' && msgEl.style.display !== 'none' && imgEl.style.display === 'none');
await until(() => imgEl.style.display === 'block');
ok('3f 原寸を GET ?id= で取得して表示（内容がサーバーの原寸と一致）', getsFull().length === 1 && imgEl.src === srv.receipts.get(t0.receiptIds[0]).data && msgEl.style.display === 'none', { gets: getsFull().length });
ok('3g 取得した原寸は IndexedDB に保存される（2回目はサーバーに行かない）', (await rcGet(t0.receiptIds[0])).full === imgEl.src);
showReceipt(t0.id, 0); await sleep(100);
ok('3h 同じ写真をもう一度開いても GET は増えない', getsFull().length === 1);
// 素早くめくった時に古い結果で上書きしない
log.length = 0;
srv.delay[t0.receiptIds[2]] = 400;
showReceipt(t0.id, 2); receiptNav(1);                                  // index2（遅い）→ index3（速い）
await sleep(900);
ok('3i 素早くめくっても、表示は最後に選んだ写真（遅れて届いた古い結果で上書きされない）', imgEl.src === srv.receipts.get(t0.receiptIds[3]).data && document.getElementById('receiptPreviewCounter').textContent === '4 / 5', document.getElementById('receiptPreviewCounter').textContent);
document.getElementById('receiptDialog').classList.remove('open');
// サーバーにも無い id: 60秒は再取得しない・📷 の枠
log.length = 0;
const ghost = 'r' + 'e'.repeat(32);
transactions.push(mkTx('ghost1', { receiptIds: [ghost] })); renderTxList(); await sleep(150); renderTxList(); await sleep(100);
const ghostReqs = getsThumbs().filter(l => l.url.includes(ghost)).length;
ok('3j サーバーに無い id は1回だけ問い合わせ、thumbMiss に記録（60秒は再取得しない）', ghostReqs === 1 && thumbMiss.has(ghost), { ghostReqs });
ok('3k サムネイルが無い取引は同じ大きさの灰色の枠に📷（クリックでプレビュー）', /📷/.test(document.getElementById('txList').innerHTML) && document.querySelector('#txList div[onclick^="showReceipt"][title="領収書"]') !== null);
thumbMiss.set(ghost, Date.now() - 61000); log.length = 0; renderTxList(); await sleep(150);
ok('3l 60秒を過ぎれば再取得する', getsThumbs().filter(l => l.url.includes(ghost)).length === 1);
// 未読の写真をプレビューするとサーバーにも無い→案内
showReceipt('ghost1', 0); await until(() => msgEl.textContent.includes('まだクラウドにありません'));
ok('3m サーバーにも端末にも無い写真は「まだクラウドにありません（撮影した端末からの送信待ちです）」', msgEl.textContent === 'この写真はまだクラウドにありません（撮影した端末からの送信待ちです）' && imgEl.style.display === 'none');
document.getElementById('receiptDialog').classList.remove('open');

// ================= 4. オフライン→送信待ち表示→復帰して pollOnce で送信
await reset();
srv.rcMode = 'offline'; srv.mode = 'offline';
transactions = [mkTx('o1')]; renderTxList();
await attach('o1', [await mkFile(500, 400, seed++), await mkFile(500, 400, seed++), await mkFile(500, 400, seed++)]);
await settle();
ok('4a オフライン: 3枚とも端末に保存済み（uploaded:false）でサーバーには0件', (await idbAll()).filter(r => !r.uploaded).length === 3 && srv.receipts.size === 0);
ok('4b 送信待ち「📤 写真3枚 送信待ち」が表示され、同期ドットも offline', receiptPendingN === 3 && document.getElementById('syncReceiptPending').style.display !== 'none' && document.getElementById('syncReceiptPending').textContent === '📤 写真3枚 送信待ち' && document.getElementById('syncDot').classList.contains('offline'), document.getElementById('syncReceiptPending').textContent);
ok('4c 写真の送信失敗ではトーストを出さない（オフライン警告のみ）', !toasts.some(t => t.includes('写真1枚をクラウドに送れませんでした')), toasts);
srv.rcMode = 'ok'; srv.mode = 'ok';
await pollOnce(); await settle();
ok('4d 復帰して pollOnce → 3枚送信・表示が消える・ドットも戻る', srv.receipts.size === 3 && receiptPendingN === 0 && document.getElementById('syncReceiptPending').style.display === 'none' && !document.getElementById('syncDot').classList.contains('offline') && !syncDirty, { stored: srv.receipts.size, pend: receiptPendingN, dirty: syncDirty });
// online イベントでも送る
await reset(); srv.rcMode = 'offline';
transactions = [mkTx('o2')]; await attach('o2', [await mkFile(400, 300, seed++)]); await settle();
ok('4e オフラインで1枚: 送信待ち1枚', receiptPendingN === 1);
srv.rcMode = 'ok'; window.dispatchEvent(new Event('online')); await settle();
ok('4f window の online イベントで送信される', srv.receipts.size === 1 && receiptPendingN === 0);
// 未送信の写真だけがあるとき（データは送信済み）ドットが offline・Redis 停止中は再試行
await reset(); srv.rcMode = 'redis';
transactions = [mkTx('o3')]; await attach('o3', [await mkFile(400, 300, seed++)]); await settle();
ok('4g Redis 停止（503 redis_unavailable）でも写真は送信待ちのまま・トーストなし', receiptPendingN === 1 && !toasts.some(t => t.includes('送れませんでした')));
srv.rcMode = 'ok'; await pollOnce(); await settle();
ok('4h 復旧後に送信', srv.receipts.size === 1 && receiptPendingN === 0);

// ================= 5. 取り消した編集画面の写真は送られない
await reset();
openModal(); await handleReceipt({ target: { files: [await mkFile(400, 300, seed++), await mkFile(400, 300, seed++)], value: '' } });
ok('5a 編集画面に2枚添付（サムネイルは thumbCache から表示）', modalReceiptIds.length === 2 && document.querySelectorAll('#receiptThumbs img').length === 2 && document.getElementById('receiptFilename').textContent === '2枚添付');
const cancelled = [...modalReceiptIds];
closeModal();
await uploadPendingReceipts(); await settle();
ok('5b キャンセルした2枚は送られない（端末には uploaded:false で残る）', posts('/api/receipt').length === 0 && srv.receipts.size === 0 && (await idbAll()).length === 2 && receiptPendingN === 0);
openModal(); await handleReceipt({ target: { files: [await mkFile(400, 300, seed++)], value: '' } });
document.getElementById('formSummary').value = '備品'; document.getElementById('formAmount').value = '500';
const keepId = modalReceiptIds[0]; saveTx(); await settle();
ok('5c 保存した取引の写真1枚だけ送られる', posts('/api/receipt').length === 1 && srv.receipts.has(keepId) && !cancelled.some(id => srv.receipts.has(id)) && transactions[0].receiptIds.join() === keepId);
// 処理中に画面を閉じたら、その画面へは足さない
openModal(); const pending = handleReceipt({ target: { files: [await mkFile(400, 300, seed++)], value: '' } }); closeModal(); await pending;
ok('5d 処理中に閉じた画面へ写真を足さない', modalReceiptIds.length === 0);

// ================= 6. 編集で写真を全部消して保存すると0枚になる（§0-6）
await reset();
transactions = [mkTx('e1')]; await attach('e1', [await mkFile(400, 300, seed++), await mkFile(400, 300, seed++)]); await settle();
ok('6a 前提: 取引に2枚', transactions[0].receiptIds.length === 2);
editTx('e1');
ok('6b 編集画面に2枚', modalReceiptIds.length === 2);
removeReceiptAt(0); removeReceiptAt(0);
ok('6c 全部消した', modalReceiptIds.length === 0 && document.getElementById('receiptThumbs').innerHTML === '');
saveTx(); await settle();
ok('6d 保存すると0枚（元に戻らない）', transactions[0].receiptIds.length === 0 && dataPosts().at(-1).data.transactions[0].receiptIds.length === 0, transactions[0].receiptIds);
applyData(JSON.parse(JSON.stringify(srv.data)));
ok('6e サーバーのデータを読み直しても0枚・一覧に写真ボタン無し', transactions[0].receiptIds.length === 0 && !document.getElementById('txList').innerHTML.includes('📥 保存'));
// 1枚だけ消す・追加する
await reset();
transactions = [mkTx('e2')]; await attach('e2', [await mkFile(400, 300, seed++), await mkFile(400, 300, seed++)]); await settle();
const keep2 = transactions[0].receiptIds[1];
editTx('e2'); removeReceiptAt(0); saveTx(); await settle();
ok('6f 1枚だけ消すと残りの1枚になる', transactions[0].receiptIds.join() === keep2);
// 旧形式の画像を持つ取引を編集しても _legacyReceipts は失わない
await reset();
const lg = await blobToDataUrl(await mkCanvasBlob(200, 150, seed++));
transactions = [mkTx('e3', { receipt: lg })];
ok('6g migrateTx: 旧 receipt は _legacyReceipts に移り receipt/receipts は消える', transactions[0]._legacyReceipts?.[0] === lg && !('receipt' in transactions[0]) && !('receipts' in transactions[0]));
srv.rcMode = 'offline'; editTx('e3'); document.getElementById('formSummary').value = 'Se3改'; saveTx(); await settle();
ok('6h 編集しても _legacyReceipts を引き継ぐ（送信データにも残る）', transactions[0]._legacyReceipts?.[0] === lg && dataPosts().at(-1).data.transactions[0].receipts?.[0] === lg, dataPosts().length);

// ================= 7. 旧形式（umabu）: inline receipt 5件
await reset();
const orig = []; for (let i = 0; i < 5; i++) orig.push(await blobToDataUrl(await mkCanvasBlob(300, 200, seed++)));
srv.data = serverData([0, 1, 2, 3, 4, 5, 6].map(i => ({ id: 'u' + i, type: 'payment', summary: '取引' + i, payee: '', amount: 100 * (i + 1), status: 'done', date: '2026-06-0' + (i + 1), account: '通帳', category: '', applied: true, cashBreakdown: null, createdAt: '2026-06-01T00:00:00Z', ...(i < 5 ? { receipt: orig[i] } : {}) })));
srv.version = 104; srv.rcMode = 'offline';
await loadData(); await settle();
const recs7 = await idbAll();
ok('7a 読み込んだだけで5枚が IndexedDB に入る（原本のまま・uploaded:false）', recs7.length === 5 && recs7.every(r => !r.uploaded) && orig.every(o => recs7.some(r => r.full === o)), recs7.length);
ok('7b 5件の取引に receiptIds が付き、_legacyReceipts を保持', transactions.filter(t => t.receiptIds.length === 1).length === 5 && transactions.filter(t => t._legacyReceipts?.length === 1).length === 5 && transactions.every(t => !('receipt' in t) && !('receipts' in t)));
const p7 = dataPosts();
ok('7c 送信が終わるまでの保存では、送信データに旧 receipts が残る（全 POST で5枚とも）', p7.length >= 1 && p7.every(b => b.data.transactions.filter(t => t.receipts?.length === 1 && orig.includes(t.receipts[0])).length === 5 && b.data.transactions.filter(t => t.receiptIds?.length === 1).length === 5), { posts: p7.length });
bankBalance = 320000; await persist(); await settle();
ok('7d 送信が503で失敗し続ける間は、保存しても旧 receipts は消えない', dataPosts().at(-1).data.transactions.filter(t => t.receipts?.length === 1).length === 5 && transactions.filter(t => t._legacyReceipts).length === 5 && receiptPendingN === 5, { pend: receiptPendingN });
ok('7e この間 localStorage には circle_receipts を作らない', localStorage.getItem('circle_receipts') === null);
srv.rcMode = 'ok'; log.length = 0;
await pollOnce(); await settle();
ok('7f 送信が終わると5枚ともサーバーにあり、原本のまま（再エンコードなし）', srv.receipts.size === 5 && orig.every(o => [...srv.receipts.values()].some(v => v.data === o)), srv.receipts.size);
const last7 = dataPosts().at(-1);
ok('7g 送信後の保存で旧 receipts が消え、receiptIds だけになる', last7 && !hasImg(last7) && last7.data.transactions.filter(t => t.receiptIds?.length === 1).length === 5 && last7.data.transactions.every(t => !('receipts' in t) && !('receipt' in t)) && transactions.every(t => !t._legacyReceipts), { posts: dataPosts().length });
ok('7h サーバーのデータからも画像が外れた（クラウドの旧データ）', !hasImg(srv.data));
// 別の端末が読み込んでも画像が見える
await idbClear(); thumbCache.clear(); applyData(JSON.parse(JSON.stringify(srv.data))); await until(() => thumbCache.size >= 5);
ok('7i 別の端末でも5枚のサムネイルが見える', thumbCache.size === 5 && document.querySelectorAll('#txList .tx-item img').length === 5);
// 他の端末がまだ旧データを持っていても冪等（同じ id になる）
await reset(); srv.rcMode = 'ok';
srv.data = serverData([{ id: 'x1', type: 'payment', summary: 'x', amount: 1, status: 'done', date: '2026-06-01', account: '通帳', receipt: orig[0], receiptIds: [] }]);
await loadData(); await settle();
const idsA = transactions[0].receiptIds.slice(); await migrateLegacyReceipts(); await settle();
ok('7j 旧データの取り込みを何度走らせても id は増えない（冪等）', idsA.length === 1 && transactions[0].receiptIds.join() === idsA.join() && srv.receipts.size === 1 && (await idbAll()).length === 1);
// 1.9MB 超の旧画像は縮小して取り込む（id は縮小後のハッシュ）
await reset();
const big = await blobToDataUrl(await mkCanvasBlob(1800, 1400, seed++, { blk: 1, q: 0.98 }));
const bigId = await importDataUrl(big);
ok('7k 1.9MB 超の旧画像は縮小して取り込み、id は縮小後の画像のハッシュ（原本の id と別）', big.length > 1900000 && isReceiptId(bigId) && (await rcGet(bigId)).full.length <= 900000 && bigId !== await receiptIdOf(big) && await legacyIdOf(big) === bigId, { bigLen: big.length, bigId });
ok('7l デコードできない旧画像は null（取り込まない）', await importDataUrl('data:image/jpeg;base64,AAAA') === null && await importDataUrl('data:text/html;base64,AAAA') === null);
// デコードできない旧画像は取引に残したまま（クラウドの旧データを外さない）
await reset();
const junk = 'data:image/jpeg;base64,' + 'A'.repeat(1000);
srv.data = serverData([{ id: 'j1', type: 'payment', summary: 'j', amount: 1, status: 'done', date: '2026-06-01', account: '通帳', receipt: junk }, { id: 'j2', type: 'payment', summary: 'k', amount: 2, status: 'done', date: '2026-06-02', account: '通帳', receipt: orig[1] }]);
await loadData(); await settle();
ok('7m 読めない旧画像は _legacyReceipts に残り（送信データにも残る）、読めるものだけ移行・送信される', transactions.find(t => t.id === 'j1')._legacyReceipts?.[0] === junk && dataPosts().at(-1).data.transactions.find(t => t.id === 'j1').receipts?.[0] === junk && !transactions.find(t => t.id === 'j2')._legacyReceipts && srv.receipts.size === 1 && toasts.some(t => t.includes('読めない旧データの写真が1枚')), { toasts });

// ================= 8. 旧 circle_receipts（localStorage）の移行
await reset();
const lsImgs = []; for (let i = 0; i < 4; i++) lsImgs.push(await blobToDataUrl(await mkCanvasBlob(300, 200, seed++)));
localStorage.setItem('circle_receipts', JSON.stringify({ c1: [lsImgs[0], lsImgs[1]], c2: [lsImgs[2]], ghost: [lsImgs[3]], c1bad: ['javascript:alert(1)'] }));
srv.data = serverData([mkTx('c1'), mkTx('c2')].map(t => ({ ...t })));
srv.rcMode = 'offline';
await loadData(); await settle();
ok('8a 読み込み: 4枚が IndexedDB に入り、存在する取引だけに receiptIds が付く（ghost は参照されない）', (await idbAll()).length === 4 && transactions.find(t => t.id === 'c1').receiptIds.length === 2 && transactions.find(t => t.id === 'c2').receiptIds.length === 1, (await idbAll()).length);
ok('8b 送信が終わっていないので circle_receipts は残る', localStorage.getItem('circle_receipts') !== null && receiptPendingN === 3);
ok('8c circle_receipts にあった画像は送信データに載らない（id のみ）', dataPosts().every(b => !hasImg(b)));
const idsBefore = transactions.flatMap(t => t.receiptIds).join();
srv.rcMode = 'ok'; await uploadPendingReceipts(); await settle();
ok('8d 送信完了かつ未送信の変更なし → circle_receipts が初めて消える', localStorage.getItem('circle_receipts') === null && srv.receipts.size === 3, { stored: srv.receipts.size, ls: localStorage.getItem('circle_receipts') });
ok('8e 参照されない ghost の画像は IndexedDB に残るが送られない', (await idbAll()).length === 4 && !srv.receipts.has(await receiptIdOf(lsImgs[3])));
await migrateLegacyReceipts(); await settle();
ok('8f もう一度移行を走らせても id は増えない（冪等）', transactions.flatMap(t => t.receiptIds).join() === idsBefore && (await idbAll()).length === 4);
// 途中で送信失敗 → 残る
await reset();
localStorage.setItem('circle_receipts', JSON.stringify({ c1: [lsImgs[0], lsImgs[1]], c2: [lsImgs[2]] }));
srv.data = serverData([mkTx('c1'), mkTx('c2')].map(t => ({ ...t }))); srv.rcMode = 'ok'; srv.failAfter = 1;
await loadData(); await settle();
ok('8g 3枚のうち1枚送ったところで失敗 → circle_receipts は残る', srv.receipts.size === 1 && localStorage.getItem('circle_receipts') !== null && receiptPendingN === 2, { stored: srv.receipts.size, pend: receiptPendingN });
srv.failAfter = null; await uploadPendingReceipts(); await settle();
ok('8h 次の機会に残りを送れば消える', srv.receipts.size === 3 && localStorage.getItem('circle_receipts') === null);
// 画像は全部送れたが、未送信の変更がある間は消さない
await reset();
localStorage.setItem('circle_receipts', JSON.stringify({ c1: [lsImgs[0]] }));
srv.data = serverData([mkTx('c1')].map(t => ({ ...t }))); srv.rcMode = 'offline';
await loadData(); await settle();
srv.mode = 'offline'; bankBalance = 7; await persist();
ok('8i 前提: データは未送信（syncDirty）', syncDirty === true);
srv.rcMode = 'ok'; await uploadPendingReceipts(); await settle();
ok('8j 画像は全部送信済みでも、未送信の変更がある間は circle_receipts を残す', srv.receipts.size === 1 && localStorage.getItem('circle_receipts') !== null);
srv.mode = 'ok'; await pollOnce(); await settle();
ok('8k データが送れたら消える', localStorage.getItem('circle_receipts') === null && !syncDirty, { dirty: syncDirty });
// 壊れた circle_receipts は触らない
await reset(); localStorage.setItem('circle_receipts', '{not json'); await finishLegacyMigration(); await migrateLegacyReceipts();
ok('8l 壊れた circle_receipts は消さない・例外にもならない', localStorage.getItem('circle_receipts') === '{not json');
await reset(); localStorage.setItem('circle_receipts', '{}'); applyData(serverData([])); await settle();
ok('8m Phase 2 が作った空の {} は、整理されて消える', localStorage.getItem('circle_receipts') === null);

// ================= 9. バックアップ・復元
await reset();
transactions = [mkTx('b1'), mkTx('b2'), mkTx('b3')];
await attach('b1', [await mkFile(400, 300, seed++), await mkFile(400, 300, seed++)]); await attach('b2', [await mkFile(400, 300, seed++)]); await attach('b3', [await mkFile(400, 300, seed++)]); await settle();
const bk = await buildFullBackup();
const allB = transactions.flatMap(t => t.receiptIds);
ok('9a buildFullBackup: 全4枚が receiptFiles に入る（原寸・id 一致）・_backupVersion:3・旧 receipts キー無し', Object.keys(bk.receiptFiles).length === 4 && allB.every(id => isImageDataUrl(bk.receiptFiles[id])) && bk._backupVersion === 3 && !('receipts' in bk) && bk._receiptsMissing === 0 && bk.transactions.every(t => t.receiptIds.length >= 1 && !('receipts' in t)), Object.keys(bk));
const bkNo = await buildFullBackup({ includeReceipts: false });
ok('9b includeReceipts:false は receiptFiles を付けない', !('receiptFiles' in bkNo) && bkNo._backupVersion === 3 && bkNo.transactions.length === 3);
// 原寸が取れない画像（端末にも無くサーバーにも無い）
const lostId = allB[0]; { const db = await rcDb(); await rcTx(db, 'readwrite', s => s.delete(lostId)); } srv.receipts.delete(lostId);
const bkMiss = await buildFullBackup();
ok('9c 取れない画像は _receiptsMissing に数える（receiptFiles は3枚）', bkMiss._receiptsMissing === 1 && Object.keys(bkMiss.receiptFiles).length === 3 && !(lostId in bkMiss.receiptFiles), bkMiss._receiptsMissing);
toasts.length = 0; await exportJSON(); await sleep(100);
ok('9d JSON エクスポートに警告トースト「⚠ 写真1枚は取得できず、バックアップに含まれていません」', toasts.includes('⚠ 写真1枚は取得できず、バックアップに含まれていません') && lastBlob?.n === 'circle_backup.json', toasts);
const expJson = JSON.parse(await lastBlob.b.text());
ok('9e JSON エクスポートは常に写真を含める', Object.keys(expJson.receiptFiles).length === 3 && expJson._backupVersion === 3);
// 進捗トースト（10枚以上）
await reset(); transactions = [mkTx('p1')]; await attach('p1', await Promise.all(Array.from({ length: 10 }, () => mkFile(200, 150, seed++)))); await settle(); toasts.length = 0;
await buildFullBackup();
ok('9f 10枚以上なら集める間に進捗トースト', toasts.some(t => t === '📦 写真を集めています 10/10'), toasts.slice(0, 3));
// 暗号化バックアップのチェックボックス
exportEncrypted();
ok('9g 暗号化バックアップのモーダルに「写真を含める」チェックボックス（既定オン・エクスポート時だけ表示）', document.getElementById('backupIncludeReceipts').checked === true && document.getElementById('backupExportSection').style.display !== 'none' && document.getElementById('backupExportSection').textContent.includes('領収書の写真を含める'));
{ const f = new File([new Uint8Array(40)], 'x.enc'); importEncrypted({ target: { files: [f], value: '' } }); }
ok('9h 復元モードでは非表示', document.getElementById('backupExportSection').style.display === 'none'); closeBackupModal(); backupEncFile = null;
// 暗号化バックアップの往復（写真を含める/含めない）
await reset(); transactions = [mkTx('q1')]; await attach('q1', [await mkFile(300, 200, seed++), await mkFile(300, 200, seed++)]); await settle();
const encRound = async (include) => {
  exportEncrypted(); document.getElementById('backupPass').value = 'pass1234'; document.getElementById('backupIncludeReceipts').checked = include; lastBlob = null;
  await doBackupAction(); await until(() => lastBlob); const blob = lastBlob.b;
  backupEncFile = blob; document.getElementById('backupPass').value = 'pass1234'; setRestoreMode('replace');
  await idbClear(); thumbCache.clear(); srv.receipts.clear(); transactions = []; log.length = 0;
  await doBackupAction(); await settle(); backupEncFile = null; setRestoreMode('merge');
};
await encRound(true);
ok('9i 暗号化バックアップ（写真あり）→ 置換復元: 取引・写真が戻り、IndexedDB に入って送信キューに乗り、サーバーへ送られる', transactions.length === 1 && transactions[0].receiptIds.length === 2 && (await idbAll()).length === 2 && srv.receipts.size === 2 && receiptPendingN === 0, { tx: transactions.length, idb: (await idbAll()).length, srv: srv.receipts.size });
await reset(); transactions = [mkTx('q2')]; await attach('q2', [await mkFile(300, 200, seed++)]); await settle();
await encRound(false);
ok('9j 暗号化バックアップ（写真なし）→ 復元: 取引は戻るが画像は端末に入らない（receiptIds だけ）', transactions.length === 1 && transactions[0].receiptIds.length === 1 && (await idbAll()).length === 0 && srv.receipts.size === 0, { idb: (await idbAll()).length });
// 復元（置換）: IDB に入り、送信キューに乗る
await reset();
transactions = [mkTx('r1'), mkTx('r2')]; await attach('r1', [await mkFile(300, 200, seed++), await mkFile(300, 200, seed++)]); await attach('r2', [await mkFile(300, 200, seed++)]); await settle();
const bkR = await buildFullBackup();
await idbClear(); thumbCache.clear(); srv.receipts.clear(); transactions = []; log.length = 0; rcGen++; rcScanGen = -1;
const rr = await restoreBackup(JSON.parse(JSON.stringify(bkR)), true);
ok('9k restoreBackup（置換）: added=2・receipts=3・rejected=0・IDB に3枚（uploaded:false）', rr.added === 2 && rr.receipts === 3 && rr.rejected === 0 && (await idbAll()).length === 3 && (await idbAll()).every(r => !r.uploaded && isImageDataUrl(r.thumb)), rr);
ok('9l 復元の最中（commit 前）には送信キューは動かない・取引の receiptIds は戻っている', srv.receipts.size === 0 && transactions.length === 2 && transactions.flatMap(t => t.receiptIds).length === 3);
commitRestore('バックアップ復元', 'replace', rr); await settle();
ok('9m commitRestore の最後に送信キュー: 3枚がサーバーへ・送信待ち0', srv.receipts.size === 3 && receiptPendingN === 0 && !hasImg(dataPosts().at(-1)), { stored: srv.receipts.size });
ok('9n 復元トーストに領収書の枚数', toasts.some(t => t.includes('領収書3件')), toasts);
// ハッシュ不一致・不正は rejected
await reset();
const gA = await blobToDataUrl(await mkCanvasBlob(200, 150, seed++)), gB = await blobToDataUrl(await mkCanvasBlob(200, 150, seed++));
const idA = await receiptIdOf(gA);
const tampered = { transactions: [{ id: 'k1', type: 'income', summary: 'k', amount: 1, status: 'done', date: '2026-10-01', account: '現金', receiptIds: [idA] }], receiptFiles: { [idA]: gA, ['r' + 'a'.repeat(32)]: gB, bad: gA, ['r' + 'b'.repeat(32)]: 'data:text/html;base64,AAAA', ['r' + 'c'.repeat(32)]: 'data:image/jpeg;base64,AAAA' } };
const rt = await restoreBackup(tampered, false);
ok('9o ハッシュ不一致・id 形式不正・画像でない・デコード不可は rejected（正しい1枚だけ取り込む）', rt.receipts === 1 && rt.rejected === 4 && (await idbAll()).length === 1 && (await idbAll())[0].id === idA, rt);
// 旧形式 receipts
await reset();
const o1 = await blobToDataUrl(await mkCanvasBlob(200, 150, seed++)), o2 = await blobToDataUrl(await mkCanvasBlob(200, 150, seed++)), o3 = await blobToDataUrl(await mkCanvasBlob(200, 150, seed++));
const oldBk = { transactions: [{ id: 'old1', type: 'income', summary: '旧', amount: 5, status: 'done', date: '2026-09-01', account: '現金' }], receipts: { old1: [o1, o2, 'javascript:x'], nothere: [o3] }, _backupVersion: 2 };
const ro = await restoreBackup(oldBk, false); commitRestore('インポート', 'x', ro); await settle();
ok('9p 旧形式 receipts のバックアップも復元できる（その取引があれば取り込み・receiptIds に追加・送信）', ro.receipts === 2 && ro.rejected === 1 && transactions[0].receiptIds.length === 2 && srv.receipts.size === 2 && !srv.receipts.has(await receiptIdOf(o3)), ro);
// マージ: 重複で飛ばした取引の receiptIds を既存へ足す
await reset();
transactions = [mkTx('m1', { date: '2026-10-05', summary: '同じ', amount: 123 })];
const addId = 'r' + '1'.repeat(32);
const rm = await restoreBackup({ transactions: [{ id: 'other-device-id', type: 'income', summary: '同じ', amount: 123, date: '2026-10-05', status: 'done', account: '現金', receiptIds: [addId, 'oops'] }] }, false);
ok('9q マージで重複スキップした取引の receiptIds は既存の同じ取引へ重複なく足す（不正 id は除外）', rm.added === 0 && transactions.length === 1 && transactions[0].receiptIds.join() === addId, transactions[0].receiptIds);
const rm2 = await restoreBackup({ transactions: [{ id: 'z', type: 'income', summary: '同じ', amount: 123, date: '2026-10-05', receiptIds: [addId] }] }, false);
ok('9r もう一度マージしても増えない', transactions[0].receiptIds.length === 1 && rm2.added === 0);
// importFile の JSON 分岐（async 化）
await reset();
const jsonBk = { transactions: [{ id: 'jf1', type: 'income', summary: 'JF', amount: 9, status: 'done', date: '2026-10-09', account: '現金', receiptIds: [idA] }], receiptFiles: { [idA]: gA } };
importFile({ target: { files: [new File([JSON.stringify(jsonBk)], 'b.json', { type: 'application/json' })], value: '' } });
await until(() => transactions.length === 1 && srv.receipts.size === 1);
ok('9s importFile(JSON): async 復元で写真も取り込み・送信される', transactions[0].receiptIds.join() === idA && srv.receipts.has(idA));

// ================= 10. 2MB 近い原寸でもプレビューできる／ハッシュ不一致は表示しない
await reset();
const bigFull = 'data:image/jpeg;base64,' + 'A'.repeat(1950000), bigFullId = await receiptIdOf(bigFull);
transactions = [mkTx('v1', { receiptIds: [bigFullId] })]; srv.fullOverride[bigFullId] = bigFull; thumbCache.set(bigFullId, 'data:image/jpeg;base64,/9j/AAAA');
showReceipt('v1', 0); await until(() => imgEl.style.display === 'block');
ok('10a 2MB 近い原寸でもプレビューできる（形式・ハッシュ照合を通る）', imgEl.src === bigFull && (await rcGet(bigFullId)).full === bigFull, imgEl.src.length);
document.getElementById('receiptDialog').classList.remove('open');
await idbClear();
const evil = 'data:image/jpeg;base64,' + 'B'.repeat(5000);
srv.fullOverride[bigFullId] = evil; imgEl.src = ''; imgEl.style.display = 'none';
showReceipt('v1', 0); await until(() => msgEl.textContent.includes('まだクラウドにありません'));
ok('10b ハッシュ不一致の原寸は表示せず、端末にも保存しない', imgEl.style.display === 'none' && imgEl.getAttribute('src') !== evil && (await rcGet(bigFullId)) === null, { src: imgEl.getAttribute('src')?.slice(0, 30) });
srv.fullOverride[bigFullId] = 'data:image/svg+xml;base64,PHN2Zy8+';
const g1 = await getFullReceipt(bigFullId);
ok('10c 画像形式でない（svg）原寸は null', g1 === null);
srv.fullOverride[bigFullId] = { x: 1 }; ok('10d 文字列でない応答も null', await getFullReceipt(bigFullId) === null);
ok('10e id 形式が不正なら問い合わせず null', await getFullReceipt('../etc') === null && !log.some(l => l.url.includes('etc')));
document.getElementById('receiptDialog').classList.remove('open');
// 保存ボタンは getFullReceipt 経由
await reset();
transactions = [mkTx('d1')]; await attach('d1', [await mkFile(300, 200, seed++)]); await settle();
const clicks = []; const origCreate = document.createElement.bind(document);
document.createElement = function (tag, ...a) { const el = origCreate(tag, ...a); if (String(tag).toLowerCase() === 'a') el.click = () => clicks.push({ href: el.href, dl: el.download }); return el; };
await downloadReceiptById('d1', 0); document.createElement = origCreate;
ok('10f 保存ボタン: getFullReceipt 経由で原寸をダウンロード（ファイル名 receipt_日付.jpg）', clicks.length === 1 && clicks[0].href === (await rcGet(transactions[0].receiptIds[0])).full && /^receipt_2026-10-\d\d\.jpg$/.test(clicks[0].dl), clicks.map(c => c.dl));
toasts.length = 0; transactions[0].receiptIds = ['r' + '9'.repeat(32)];
await downloadReceiptById('d1', 0);
ok('10g 取れない写真の保存は案内トースト', toasts.some(t => t.includes('まだクラウドにありません')));

// ================= 11. isImageDataUrl を通らないサムネイルは <img> に入らない
await reset();
const badId = ['r' + '2'.repeat(32), 'r' + '3'.repeat(32), 'r' + '4'.repeat(32)];
transactions = badId.map((id, i) => mkTx('x' + i, { receiptIds: [id] }));
srv.thumbOverride[badId[0]] = 'data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+';
srv.thumbOverride[badId[1]] = '"><img src=x onerror=alert(1)>';
srv.thumbOverride[badId[2]] = 'javascript:alert(1)';
renderTxList(); await sleep(300);
const html = document.getElementById('txList').innerHTML;
ok('11a 不正なサムネイルは thumbCache にも IndexedDB にも入らない', badId.every(id => !thumbCache.has(id)) && (await idbAll()).length === 0);
ok('11b 一覧の HTML に <img> も不正な文字列も入らない（📷 の枠になる）', !document.querySelector('#txList img') && !html.includes('onerror') && !html.includes('javascript:') && !html.includes('svg+xml') && (html.match(/📷/g) || []).length >= 3);
// IDB 側に不正なサムネイルが入っていても使わない
await rcPut({ id: badId[0], thumb: 'javascript:alert(1)', uploaded: true }); thumbMiss.clear(); thumbCache.clear(); renderTxList(); await sleep(200);
ok('11c IndexedDB の不正なサムネイルも <img> に入れない', !document.querySelector('#txList img') && !thumbCache.has(badId[0]));
// 取引の receiptIds に不正な id が混ざっていても除外
applyData(serverData([{ id: 'inj', type: 'income', summary: 'i', amount: 1, status: 'done', date: '2026-10-01', account: '現金', receiptIds: ['"><script>alert(1)</script>', 'r' + '5'.repeat(32), 'r' + '5'.repeat(32), 5, null] }]));
ok('11d migrateTx: 不正な receiptIds は除外・重複除去', transactions[0].receiptIds.join() === 'r' + '5'.repeat(32), transactions[0].receiptIds);

// ================= 12. その他: 逐次処理・縮小・IndexedDB 不可・送信エラー・401・移行の保存
// 12a 逐次処理（同時にデコードしない）と進捗トースト
await reset();
const origCIB = window.createImageBitmap; let cur = 0, maxCur = 0;
window.createImageBitmap = async (...a) => { cur++; maxCur = Math.max(maxCur, cur); await sleep(15); try { return await origCIB(...a); } finally { cur--; } };
toasts.length = 0;
const ids12 = await addReceiptImages(await Promise.all(Array.from({ length: 6 }, () => mkFile(300, 200, seed++))));
window.createImageBitmap = origCIB;
ok('12a 複数枚は1枚ずつ順番に処理する（同時デコード数は常に1）', maxCur === 1 && ids12.length === 6, maxCur);
ok('12b 2枚以上なら進捗トースト「📷 写真を処理中 3/6」', toasts.includes('📷 写真を処理中 3/6') && toasts.includes('📷 写真を処理中 6/6'), toasts);
toasts.length = 0; const idsBad = await addReceiptImages([new File(['not an image'], 'a.jpg', { type: 'image/jpeg' }), await mkFile(200, 150, seed++)]);
ok('12c 読めない画像は飛ばして件数をトースト・戻り値は読めた分の id', idsBad.length === 1 && toasts.includes('⚠ 読み込めない画像が1枚ありました'), toasts);
// 12d 縮小: 長辺1600・サムネイル長辺240・JPEG
const pi = await processImage(await mkFile(3200, 2400, seed++, { blk: 24 }));
const [fw, fh] = await imgDim(pi.full), [tw, th2] = await imgDim(pi.thumb);
ok('12d 原寸は長辺1600px・JPEG（900000 文字以下）・サムネイルは長辺240px・id は原寸のハッシュ', Math.max(fw, fh) === 1600 && pi.full.startsWith('data:image/jpeg;base64,') && pi.full.length <= 900000 && Math.max(tw, th2) === 240 && pi.id === await receiptIdOf(pi.full), { fw, fh, tw, th2, len: pi.full.length });
const piBig = await processImage(await mkFile(2400, 1800, seed++, { blk: 1, q: 0.98 }));
const [bw, bh] = await imgDim(piBig.full);
ok('12e ノイズだらけで 900000 を超える画像は q0.55 → それでも超えたら長辺1200px に縮める（2MB 未満）', piBig.full.length < 2000000 && (piBig.full.length <= 900000 || Math.max(bw, bh) === 1200) && Math.max(bw, bh) <= 1600, { len: piBig.full.length, bw, bh });
// 12f 小さい画像は拡大しない
const piS = await processImage(await mkFile(300, 200, seed++)); const [sw, sh] = await imgDim(piS.full);
ok('12f 小さい画像は拡大しない', sw === 300 && sh === 200, [sw, sh]);
// 12g IndexedDB が使えない環境ではメモリ退避＋トースト1回
await reset(); rcDbP = Promise.resolve(null);
transactions = [mkTx('m9')]; toasts.length = 0;
await attach('m9', [await mkFile(300, 200, seed++), await mkFile(300, 200, seed++)]); await settle();
const warn = toasts.filter(t => t === '⚠ この端末では写真を一時保存できません。送信が終わるまでアプリを閉じないでください');
ok('12g IndexedDB 不可: メモリに退避して送信でき、警告トーストは1回だけ', warn.length === 1 && rcMem.size === 2 && srv.receipts.size === 2 && receiptPendingN === 0, { warn: warn.length, mem: rcMem.size });
const [fm] = await Promise.all([getFullReceipt(transactions[0].receiptIds[0])]);
ok('12h メモリ退避中でも原寸・サムネイルを取り出せる', isImageDataUrl(fm) && isImageDataUrl(thumbCache.get(transactions[0].receiptIds[0])));
rcDbP = realDbP; rcMem.clear();
// 12i 400 → failed を記録して以後送らない・トースト1回
await reset(); transactions = [mkTx('f1')];
const fs12 = [await mkFile(300, 200, seed++), await mkFile(300, 200, seed++), await mkFile(300, 200, seed++)];
log.length = 0; toasts.length = 0;
const idsF = await addReceiptImages(fs12); srv.badIds.add(idsF[1]);
transactions[0].receiptIds = idsF; await uploadPendingReceipts(); await settle();
const rf = await rcGet(idsF[1]);
ok('12i 400 の1枚は failed を記録して送らず、残りは送れる', rf.failed === 'invalid_image' && !rf.uploaded && srv.receipts.size === 2 && !srv.receipts.has(idsF[1]), { failed: rf.failed, stored: srv.receipts.size });
ok('12j トースト「⚠ 写真1枚をクラウドに送れませんでした（この端末には残っています）」は1回', toasts.filter(t => t === '⚠ 写真1枚をクラウドに送れませんでした（この端末には残っています）').length === 1, toasts);
log.length = 0; toasts.length = 0; await uploadPendingReceipts(); await settle();
ok('12k 失敗した1枚は再送しない・トーストも出ない・送信待ちにも数えない', posts('/api/receipt').length === 0 && toasts.length === 0 && receiptPendingN === 0);
// 12l 401 → handleAuthFailure・中断
await reset(); srv.rcMode = '401'; transactions = [mkTx('a1')];
await attach('a1', [await mkFile(300, 200, seed++), await mkFile(300, 200, seed++)]); await settle();
// （本物の handleAuthFailure はトークンを消すので以後は送らない。ここでは差し替えているため、再送の契機ごとに「1回送って中断」になる）
ok('12l 401 は handleAuthFailure を呼んで中断（1回の送信ごとに POST は1回だけ・送信待ちのまま）', authFails >= 1 && posts('/api/receipt').length === authFails && receiptPendingN === 2, { authFails, posts: posts('/api/receipt').length });
// 12m トークンが無ければ何もしない
await reset(); sessionStorage.removeItem('circle_token'); transactions = [mkTx('n1')];
await attach('n1', [await mkFile(300, 200, seed++)]); await settle();
ok('12m トークンが無ければ送信しない（送信待ち表示は出る）', posts('/api/receipt').length === 0 && receiptPendingN === 1 && document.getElementById('syncReceiptPending').style.display !== 'none');
sessionStorage.setItem('circle_token', 'tok');
// 12n 多重起動防止
await reset(); transactions = [mkTx('mu')];
await attach('mu', [await mkFile(300, 200, seed++), await mkFile(300, 200, seed++), await mkFile(300, 200, seed++)]); await settle();
await reset(); srv.receipts.clear(); transactions = [mkTx('mu2')];
{ const fl = [await mkFile(300, 200, seed++), await mkFile(300, 200, seed++), await mkFile(300, 200, seed++)];
  srv.rcMode = 'offline'; await attach('mu2', fl); await settle(); srv.rcMode = 'ok'; log.length = 0;
  await Promise.all([uploadPendingReceipts(), uploadPendingReceipts(), uploadPendingReceipts()]); await settle(); }
ok('12n 同時に3回呼んでも各画像は1回だけ送られる（多重起動防止）', posts('/api/receipt').length === 3 && srv.maxInflight === 1, { posts: posts('/api/receipt').length });
// 12o 送信中に追加した写真も取りこぼさない
await reset(); transactions = [mkTx('rr')];
srv.rcMode = 'offline'; await attach('rr', [await mkFile(300, 200, seed++)]); await settle(); srv.rcMode = 'ok';
const up = uploadPendingReceipts(); await sleep(2);
await attach('rr', [await mkFile(300, 200, seed++)]); await up; await settle();
ok('12o 送信中に足した写真も同じ流れで送られる', srv.receipts.size === 2 && receiptPendingN === 0, { stored: srv.receipts.size });
// 12p saveLocal: 第1引数は mark。rememberServer は未送信の印を付けない・schedulePersist は付ける
await reset(); rememberServer(9);
ok('12p rememberServer は未送信の印を付けない（saveLocal(false)）', localStorage.getItem('circle_unsynced') === null && localStorage.getItem('circle_server_version') === '9');
setCount(1, 1); clearTimeout(persistTimer); persistTimer = null;
ok('12q schedulePersist（saveLocal()）は未送信の印を付ける', localStorage.getItem('circle_unsynced') !== null);
ok('12r saveReceiptsLocally は廃止', typeof saveReceiptsLocally === 'undefined' && saveLocal.length === 0);
// 12s IDB: 一度 uploaded になったものを false に戻さない
await reset(); const mid = 'r' + '7'.repeat(32);
await rcPut({ id: mid, full: 'data:image/jpeg;base64,AAAA', thumb: 'data:image/jpeg;base64,AAAA', uploaded: true }); await rcPut({ id: mid, uploaded: false, full: 'data:image/jpeg;base64,BBBB' });
const mr = await rcGet(mid);
ok('12s rcPut は既存レコードとマージし、uploaded:true を false に戻さない', mr.uploaded === true && mr.full === 'data:image/jpeg;base64,BBBB' && mr.thumb === 'data:image/jpeg;base64,AAAA');
// 12t viewer: 写真ボタンは表示のみ
// Phase 4: 閲覧専用（viewer）の役割を撤去したので、「表示だけ」の確認から「常に編集・追加ボタンが出る」確認に変更
await reset(); transactions = [mkTx('w1', { receiptIds: [mid] })]; renderTxList();
ok('12t 取引一覧は常に編集・写真追加ボタンを出す（閲覧専用の表示は無い）', document.getElementById('txList').innerHTML.includes('➕ 追加') && document.getElementById('txList').innerHTML.includes('編集</button>') && !document.getElementById('txList').innerHTML.includes('📷 表示'));
// 12u 取引削除では画像を消さない
await reset(); transactions = [mkTx('dl')]; await attach('dl', [await mkFile(300, 200, seed++)]); await settle();
const dlId = transactions[0].receiptIds[0]; deleteTx('dl'); await settle();
ok('12u 取引を削除しても端末・サーバーの画像は消えない', (await rcGet(dlId)) !== null && srv.receipts.has(dlId) && transactions.length === 0);
// 12v 起動時（loadData 完了後）に送信待ちを送る
await reset(); srv.rcMode = 'offline'; transactions = [mkTx('st')]; await attach('st', [await mkFile(300, 200, seed++)]); await settle();
srv.data = serverData(JSON.parse(JSON.stringify(transactions))); srv.rcMode = 'ok'; srv.mode = 'ok'; srv.version = 5;
await loadData(); await settle();
ok('12v 起動時の loadData 完了後に未送信の写真が送られる', srv.receipts.size === 1 && receiptPendingN === 0);
// 12w persist 成功時にも送る
await reset(); srv.rcMode = 'offline'; transactions = [mkTx('ps')]; await attach('ps', [await mkFile(300, 200, seed++)]); await settle();
srv.rcMode = 'ok'; bankBalance = 3; await persist(); await settle();
ok('12w persist() 成功時に未送信の写真が送られる', srv.receipts.size === 1);
// 12x 復元中は pollOnce が割り込まない
await reset(); restoring = true; log.length = 0; srv.version = 99; await pollOnce(); restoring = false;
ok('12x 復元の最中は pollOnce が何もしない', log.length === 0);

// 12y 最初に画像を保存した時に navigator.storage.persist() をベストエフォートで1回呼ぶ
await reset(); rcPersistAsked = false; let persistCalls = 0; const origPersist = navigator.storage.persist;
navigator.storage.persist = () => { persistCalls++; return Promise.reject(new Error('denied')); };
await addReceiptImages([await mkFile(200, 150, seed++), await mkFile(200, 150, seed++)]);
navigator.storage.persist = origPersist; delete navigator.storage.persist;
ok('12y 画像を保存した最初の1回だけ storage.persist() を呼ぶ（拒否されても例外にならない）', persistCalls === 1, persistCalls);

// ---- 後片付け
await reset();
document.getElementById('modalOverlay').classList.remove('open');
window.fetch = realFetch; window.showToast = realToast; window.confirm = realConfirm; window.dlBlob = realDl; window.handleAuthFailure = realAuthFail; delete document.hidden;
sessionStorage.removeItem('circle_token'); LS_KEYS.forEach(k => localStorage.removeItem(k));
R.push('externalFetchCalls=' + log.filter(l => l.external).length);
const out = R.join('\n') + `\n\nPASS=${R.filter(x => x.startsWith('PASS')).length} FAIL=${R.filter(x => x.startsWith('FAIL')).length}`;
window.__phase3Result = out;
return out;
})()
