// Phase 2 クライアントテスト（spec §10-2）。
// 使い方: リポジトリ直下で `python -m http.server 3120 --bind 127.0.0.1` を起動し、
// http://127.0.0.1:3120/index.html をブラウザで開いて、DevTools のコンソールか javascript_tool にこのファイル全体を貼る。
// window.fetch を差し替えるので本番へは一切通信しない。結果は PASS/FAIL の配列で返る。
(async () => {
const R = [];
const ok = (name, cond, extra) => R.push((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const realFetch = window.fetch;
const log = [];
const srv = { version: 5, data: {}, audit: [], mode: 'ok' }; // mode: ok | redis | offline | fail500
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });
window.fetch = async (url, opt = {}) => {
  url = String(url); const m = opt.method || 'GET';
  if (!url.startsWith('/api/')) { log.push({ url, m, external: true }); return realFetch(url, opt); }
  log.push({ url, m, body: opt.body });
  if (srv.mode === 'offline') return J({ error: 'offline' }, 503);
  if (srv.mode === 'redis') return J({ error: 'redis_unavailable', redis_ok: false, message: 'DOWN' }, 503);
  if (srv.mode === 'fail500') return J({}, 500);
  if (url.startsWith('/api/data')) {
    if (m === 'GET') return url.includes('v=1') ? J({ version: srv.version, redis_ok: true }) : J({ data: srv.data, version: srv.version, redis_ok: true });
    const b = JSON.parse(opt.body); srv.version++; srv.data = b.data; return J({ ok: true, version: srv.version, redis_ok: true });
  }
  if (url.startsWith('/api/audit')) {
    if (m === 'GET') { const u = new URL(url, location.origin); const off = +(u.searchParams.get('offset') || 0), lim = +u.searchParams.get('limit'); return J({ entries: srv.audit.slice(off, off + lim), redis_ok: true }); }
    const e = JSON.parse(opt.body).entries; srv.audit = [...e, ...srv.audit]; return J({ ok: true, count: e.length }); // 新しい塊が先頭に積まれる
  }
  return J({}, 404);
};
const toasts = []; const origToast = window.showToast; window.showToast = m => toasts.push(m);
const origApply = window.applyData; let applyCalls = 0; window.applyData = function (...a) { applyCalls++; return origApply.apply(this, a); };
const origDl = window.dlBlob; let lastBlob = null; window.dlBlob = (b, n) => { lastBlob = { b, n }; };
const posts = (p) => log.filter(l => l.m === 'POST' && l.url.startsWith(p));
const reset = () => {
  sessionStorage.setItem('circle_token', 'tok'); clearTimeout(persistTimer); persistTimer = null;
  syncDirty = false; syncOffline = false; isSyncing = false; persistPending = false; lastServerVersion = 5;
  srv.version = 5; srv.data = {}; srv.audit = []; srv.mode = 'ok';
  auditLog = []; auditOutbox = []; auditArchiveCache = []; auditArchiveLoaded = false; sizeWarned = false;
  log.length = 0; toasts.length = 0; applyCalls = 0; lastBlob = null;
  document.getElementById('redisWarnBanner').style.display = 'none';
};
const hide = v => Object.defineProperty(document, 'hidden', { value: v, configurable: true });

// ---- 1. pollOnce
// ブラウザのペインが非表示だと document.hidden が true になるので、明示的に「表示中」にして始める
hide(false);
reset();
await pollOnce();
ok('1a 版が同じなら ?v=1 の1回だけ', log.length === 1 && log[0].url === '/api/data?v=1' && log[0].m === 'GET', log.map(l => l.m + ' ' + l.url));
reset(); srv.version = 6; srv.data = { counts: { 1: 3 }, bankBalance: 777, transactions: [], auditLog: [] };
await pollOnce();
ok('1b 版が違えば全データを取得して適用', log.length === 2 && log[1].url === '/api/data' && applyCalls === 1 && lastServerVersion === 6 && bankBalance === 777, { log: log.map(l => l.url), applyCalls, lastServerVersion, bankBalance });
ok('1b2 同期トーストが出る', toasts.includes('🔄 データを同期しました'), toasts);
reset(); hide(true); srv.version = 9; await pollOnce(); hide(false);
ok('1c document.hidden の時は何もしない', log.length === 0 && applyCalls === 0, log.length);
reset(); persistTimer = setTimeout(() => {}, 5000); await pollOnce(); clearTimeout(persistTimer); persistTimer = null;
ok('1d まとめ待ちの保存がある間は何もしない', log.length === 0);
reset(); sessionStorage.removeItem('circle_token'); await pollOnce();
ok('1e トークンが無ければ何もしない', log.length === 0);
// 多重起動
{
  const created = [], cleared = []; const si = window.setInterval, ci = window.clearInterval;
  window.setInterval = (f, t) => { const id = si(() => {}, 1e9); created.push([id, t]); return id; };
  window.clearInterval = id => { cleared.push(id); ci(id); };
  startPolling(); startPolling(); startPolling();
  window.setInterval = si; window.clearInterval = ci;
  const active = created.filter(([id]) => !cleared.includes(id));
  ok('1f startPolling を3回呼んでも有効なタイマーは1つ・30秒', active.length === 1 && active[0][1] === 30000, { created: created.length, cleared: cleared.length, interval: active[0] && active[0][1] });
  clearInterval(pollTimer);
}
// 取得中に編集が始まったら適用しない
reset(); srv.version = 6; srv.data = { counts: {}, bankBalance: 1, transactions: [] };
{ const p = pollOnce(); schedulePersist(); await p; clearTimeout(persistTimer); persistTimer = null;
  ok('1g 取得中に編集が始まったら適用しない', applyCalls === 0 && lastServerVersion === 5, { applyCalls, lastServerVersion }); }

// ---- 2. dirty の時は取り込まず再送
reset(); syncDirty = true; srv.version = 6; srv.data = { counts: {}, bankBalance: 12345, transactions: [] }; bankBalance = 50;
await pollOnce(); await sleep(150);
ok('2 dirty: POST が出て applyData は呼ばれない・成功後に dirty 解除', posts('/api/data').length === 1 && applyCalls === 0 && bankBalance === 50 && syncDirty === false, { posts: posts('/api/data').length, applyCalls, bankBalance, syncDirty });

// ---- 3. setCount 連打
reset(); for (let i = 1; i <= 20; i++) setCount(1, i);
ok('3a 連打中は送信されない', posts('/api/data').length === 0);
await sleep(900);
ok('3b 20回呼んでも POST は1回・最終値が入る', posts('/api/data').length === 1 && JSON.parse(posts('/api/data')[0].body).data.counts[1] === 20, posts('/api/data').length);
reset(); bankBalance = 0; document.getElementById('bankBalanceInput').value = '500'; onBankBalanceChange(); onBankBalanceChange(); await sleep(900);
ok('3c onBankBalanceChange もまとめて1回', posts('/api/data').length === 1);
reset(); setCount(5, 2); flushPendingPersist(); await sleep(100);
ok('3d flushPendingPersist ですぐ送る', posts('/api/data').length === 1 && persistTimer === null);

// ---- 4. 失敗が続いてもトーストは1回・印の表示
reset(); srv.mode = 'redis'; document.getElementById('syncBanner').classList.add('active');
await persist(); await persist(); await persist(); syncDirty && await pollOnce(); await pollOnce(); await sleep(50);
const failToasts = toasts.filter(t => t.startsWith('⚠'));
ok('4a サーバー失敗が続いても失敗トーストは1回', failToasts.length === 1, toasts);
ok('4b dirty で「未送信」表示・syncDot が offline', syncDirty && document.getElementById('syncPending').style.display !== 'none' && document.getElementById('syncDot').classList.contains('offline'));
srv.mode = 'ok'; await pollOnce(); await sleep(100);
ok('4c 復旧後に再送されて dirty 解除・表示が消える', !syncDirty && document.getElementById('syncPending').style.display === 'none' && !document.getElementById('syncDot').classList.contains('offline'), { syncDirty });
reset(); srv.mode = 'redis'; await persist(); srv.mode = 'ok'; await persist(); srv.mode = 'redis'; await persist();
ok('4d 成功を挟めばまた1回出る（計2回）', toasts.filter(t => t.startsWith('⚠')).length === 2, toasts);

// ---- 5. 操作ログ 305 件
reset(); sessionStorage.removeItem('circle_token');
for (let i = 0; i < 305; i++) addAudit('t' + i, 'd' + i);
ok('5a auditLog は300件・箱は5件', auditLog.length === 300 && auditOutbox.length === 5, { log: auditLog.length, box: auditOutbox.length });
ok('5b 箱は新しい順で、溢れたのは最も古い5件', auditOutbox.map(a => a.action).join() === 't4,t3,t2,t1,t0', auditOutbox.map(a => a.action));
ok('5c 箱は localStorage に保存', JSON.parse(localStorage.getItem('circle_audit_outbox')).length === 5);
sessionStorage.setItem('circle_token', 'tok'); log.length = 0;
await flushAuditOutbox();
const ap = posts('/api/audit');
ok('5d flush の POST は1回・古い塊(新しい順)で送られ、成功後に箱が空', ap.length === 1 && JSON.parse(ap[0].body).entries.map(a => a.action).join() === 't4,t3,t2,t1,t0' && auditOutbox.length === 0 && localStorage.getItem('circle_audit_outbox') === '[]', { posts: ap.length, box: auditOutbox.length });
// 2500 件: 1000 / 1000 / 500 で最も古い分から
reset(); auditOutbox = Array.from({ length: 2500 }, (_, i) => ({ ts: new Date(Date.UTC(2026, 0, 1) + (2499 - i) * 1000).toISOString(), action: 'a' + (2499 - i), detail: '' })); // 先頭が最新(a2499)
await flushAuditOutbox();
const sizes = posts('/api/audit').map(l => JSON.parse(l.body).entries.length);
const firstChunk = JSON.parse(posts('/api/audit')[0].body).entries;
ok('5e 2500件は 1000/1000/500 で送られる', sizes.join() === '1000,1000,500' && auditOutbox.length === 0, sizes);
ok('5f 最初の塊が最も古い1000件（a0..a999）', firstChunk[firstChunk.length - 1].action === 'a0' && firstChunk[0].action === 'a999');
ok('5g 保管庫の先頭が最新（順序が保たれる）', srv.audit[0].action === 'a2499' && srv.audit[2499].action === 'a0' && srv.audit.length === 2500);
// 失敗時は箱を残す・多重実行しない
reset(); auditOutbox = [{ ts: '2026-01-01T00:00:00.000Z', action: 'x', detail: '' }]; srv.mode = 'fail500'; await flushAuditOutbox();
ok('5h flush 失敗時は箱がそのまま残る', auditOutbox.length === 1);
srv.mode = 'ok'; log.length = 0; await Promise.all([flushAuditOutbox(), flushAuditOutbox(), flushAuditOutbox()]);
ok('5i 同時に3回呼んでも POST は1回（多重実行防止）', posts('/api/audit').length === 1 && auditOutbox.length === 0, posts('/api/audit').length);

// ---- 6. exportAudit / buildFullBackup が保管分を統合（重複なし）
const E = (n, extra = {}) => ({ ts: new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString(), action: 'e' + n, detail: 'd' + n, device: 'x', user: 'admin', ...extra });
reset();
srv.audit = [E(9), E(8), E(7), E(6), E(5), E(4)];          // サーバー保管分（新しい順）
auditLog = [E(11), E(10), E(9), E(8)];                    // 端末（9,8 は保管分と重複）
auditOutbox = [E(10), E(7)];                              // 箱（10 は端末と重複・7 は保管分と重複）
await exportAudit();
const csv = (await lastBlob.b.text()).replace(/^﻿/, '').trim().split('\n');
ok('6a CSV は重複なし 8 件 + ヘッダー', csv.length === 1 + 8 && lastBlob.n === 'audit_log.csv', csv.length - 1);
ok('6b CSV は新しい順', csv[1].includes('e11') && csv[8].includes('e4'), [csv[1], csv[8]]);
const bk = await buildFullBackup();
const keys = bk.auditArchive.map(a => `${a.ts}|${a.action}|${a.detail}`);
ok('6c バックアップの auditArchive は箱(10,7)+保管分(9..4)で重複なし 7 件', bk.auditArchive.length === 7 && new Set(keys).size === 7 && bk._auditArchiveComplete === true && bk.auditLog.length === 4, { archive: bk.auditArchive.map(a => a.action), complete: bk._auditArchiveComplete });
// 全ページ取得（2300件）
reset(); srv.audit = Array.from({ length: 2300 }, (_, i) => E(2299 - i)); auditLog = [];
const bk2 = await buildFullBackup();
ok('6d 保管分を全ページ取得（2300件・3回の GET）', bk2.auditArchive.length === 2300 && log.filter(l => l.url.startsWith('/api/audit')).length === 3, { n: bk2.auditArchive.length, gets: log.length });
// 取得失敗時
reset(); srv.mode = 'fail500'; auditLog = [E(3)]; auditOutbox = [E(2)];
const bk3 = await buildFullBackup(); await exportAudit();
const csv3 = (await lastBlob.b.text()).replace(/^﻿/, '').trim().split('\n');
ok('6e 取得失敗: auditArchive は箱のみ・complete=false', bk3.auditArchive.length === 1 && bk3._auditArchiveComplete === false);
ok('6f 取得失敗: CSV は手元の分のみ + 専用トースト', csv3.length === 3 && toasts.includes('⚠ サーバー保管分は取得できなかったため、端末にある分のみ出力しました'), toasts);
// 復元: auditLog と auditArchive の両方を統合
reset(); srv.mode = 'ok';
const before = auditLog.length;
await restoreBackup({ auditLog: [E(3), E(2)], auditArchive: [E(2), E(1), E(0)], transactions: [] }, false); // Phase 3 で restoreBackup は async
ok('6g restoreBackup は auditLog と auditArchive の両方を統合（重複なし）', auditLog.length === 4 && auditLog.map(a => a.action).join() === 'e3,e2,e1,e0', auditLog.map(a => a.action));
reset(); await restoreBackup({ auditLog: Array.from({ length: 400 }, (_, i) => E(399 - i)), transactions: [] }, false);
// Phase 3: restoreBackup が async になり await で待つ間に箱の送信（flushAuditOutbox）が終わるので、「箱 + 送信済み」の合計で確認する
await sleep(150);
ok('6h 復元で300件超は箱へ移る（箱 + 保管庫で100件）', auditLog.length === 300 && auditOutbox.length + srv.audit.length === 100, { log: auditLog.length, box: auditOutbox.length, stored: srv.audit.length });
// 表示
reset(); srv.audit = Array.from({ length: 700 }, (_, i) => E(699 - i)); auditLog = [E(1000)];
renderAuditLog(); const n1 = document.querySelectorAll('#auditLogList .audit-item').length;
await loadAuditArchive(); const n2 = document.querySelectorAll('#auditLogList .audit-item').length;
ok('6i 表示: 過去ログ読込前は端末の1件、読込後は 501 件(=1+500)', n1 === 1 && n2 === 501, { n1, n2, getUrl: log.find(l => l.url.startsWith('/api/audit')).url });

// ---- 7. 503 offline / redis_unavailable
reset(); srv.mode = 'offline';
const errs = []; for (const f of [apiLoad, apiVersion, () => apiSave({})]) { try { await f(); } catch (e) { errs.push(e.message); } }
ok('7a offline: 警告バナーを出さず Error("offline")', document.getElementById('redisWarnBanner').style.display === 'none' && errs.join() === 'offline,offline,offline', errs);
await persist();
ok('7b offline の保存失敗トースト文言', toasts.includes('⚠ オフラインのため、この端末にのみ保存しました') && document.getElementById('redisWarnBanner').style.display === 'none', toasts);
reset(); srv.mode = 'redis';
const errs2 = []; for (const f of [apiLoad, apiVersion, () => apiSave({})]) { try { await f(); } catch (e) { errs2.push(e.message); } }
ok('7c redis_unavailable: 警告バナーを出す', document.getElementById('redisWarnBanner').style.display === 'flex' && errs2.join() === 'redis_unavailable,redis_unavailable,redis_unavailable' && document.getElementById('redisWarnDetail').textContent === 'DOWN', errs2);
// 413
reset(); window.fetch = (f => async (u, o = {}) => (String(u) === '/api/data' && o.method === 'POST') ? J({ error: 'payload_too_large', bytes: 950000, message: '保存データが大きすぎます（約928KB）。' }, 413) : f(u, o))(window.fetch);
await persist();
ok('7d 413: payload_too_large の detail をトーストに表示', toasts.includes('⚠ 保存データが大きすぎます（約928KB）。') && syncDirty, toasts);

// ---- 8. ライブラリ
const res = performance.getEntriesByType('resource').map(e => e.name);
ok('8a /vendor/ の2ファイルが読み込まれる', res.some(u => u.endsWith('/vendor/chart.umd.min.js')) && res.some(u => u.endsWith('/vendor/xlsx.full.min.js')));
ok('8b typeof Chart==="function" && typeof XLSX==="object"', typeof Chart === 'function' && typeof XLSX === 'object', XLSX.version);
ok('8c jsdelivr / sheetjs CDN への通信なし', !res.some(u => /jsdelivr|cdn\.sheetjs|unpkg|cdnjs/.test(u)), res.filter(u => !u.startsWith(location.origin)));

// ---- 9. Excel 往復（exportExcel の手順そのもの）
reset(); transactions = [migrateTx({ id: 'id-1', date: '2026-10-01', type: 'income', summary: '部費「あ」', payee: '山田', amount: 1500, status: 'done', category: '部費', account: '現金' }), migrateTx({ id: 'id-2', date: '2026-10-02', type: 'payment', summary: 'ポスター, 印刷', payee: '', amount: 320, status: 'pending', category: '印刷費', account: '通帳' })];
let wbCaptured = null; const origWF = XLSX.writeFile; XLSX.writeFile = (wb, name) => { wbCaptured = { wb, name }; };
exportExcel(); XLSX.writeFile = origWF;
const bin = XLSX.write(wbCaptured.wb, { type: 'binary', bookType: 'xlsx' });
const wb2 = XLSX.read(bin, { type: 'binary' });
const rows = XLSX.utils.sheet_to_json(wb2.Sheets[wb2.SheetNames[0]], { header: 1 });
const expected = [['日付', '種別', '摘要', '支払先', '金額', '状態', 'カテゴリ', '口座', 'ID'], ...transactions.map(txToRow)];
const norm = a => a.map(r => Array.from({ length: 9 }, (_, i) => r[i] === undefined || r[i] === '' ? '' : String(r[i])));
ok('9a Excel 書き出し→読み戻しで行が一致', JSON.stringify(norm(rows)) === JSON.stringify(norm(expected)) && wb2.SheetNames.join() === '取引,カテゴリ,予算' && wbCaptured.name === 'circle_data.xlsx', { rows: rows.length, sheets: wb2.SheetNames });

delete document.hidden; window.fetch = realFetch; window.showToast = origToast; window.applyData = origApply; window.dlBlob = origDl;
sessionStorage.removeItem('circle_token'); localStorage.removeItem('circle_audit_outbox'); localStorage.removeItem('circle_data');
const externalCalls = log.filter(l => l.external);
R.push('externalFetchCalls=' + externalCalls.length);
return R.join('\n') + `\n\nPASS=${R.filter(x => x.startsWith('PASS')).length} FAIL=${R.filter(x => x.startsWith('FAIL')).length}`;
})()
