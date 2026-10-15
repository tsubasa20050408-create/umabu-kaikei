// Phase 4 クライアントテスト（spec「テスト」1〜10）。
// 使い方: リポジトリ直下で `python -m http.server <port> --bind 127.0.0.1` を起動し、http://127.0.0.1:<port>/index.html を開く。
// test/browser/README.md の手順で fetch して eval するか、開発者ツールのコンソールに貼る。結果は window.__phase4Result（途中経過は window.__phase4Partial）。
// window.fetch を /api/data・/api/audit・/api/receipt の偽サーバーに差し替えるので、本番にも Upstash にも一切通信しない。
(async () => {
const R = []; window.__phase4Partial = R;
const ok = (name, cond, extra) => R.push((cond ? 'PASS ' : 'FAIL ') + name + (cond && extra === undefined ? '' : (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) return false; await sleep(20); } return true; };
Object.defineProperty(document, 'hidden', { value: false, configurable: true });
const realFetch = window.fetch, realToast = window.showToast, realConfirm = window.confirm, realDl = window.dlBlob, realAuthFail = window.handleAuthFailure;
const log = [], toasts = [], confirms = [];
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });
const srv = { version: 5, data: {}, mode: 'ok' };
window.fetch = async (url, opt = {}) => {
  url = String(url); const m = opt.method || 'GET';
  if (!url.startsWith('/api/')) { log.push({ url, m, external: true }); return realFetch(url, opt); }
  log.push({ url, m, body: opt.body });
  if (url.startsWith('/api/audit')) return J(m === 'GET' ? { entries: [], redis_ok: true } : { ok: true, count: 0 });
  if (url.startsWith('/api/receipt')) return J({ error: 'not_found' }, 404);
  if (url.startsWith('/api/data')) {
    if (srv.mode === 'offline') return J({ error: 'offline' }, 503);
    if (m === 'GET') return url.includes('v=1') ? J({ version: srv.version, redis_ok: true }) : J({ data: srv.data, version: srv.version, redis_ok: true });
    const b = JSON.parse(opt.body);
    if (b.expectedVersion !== srv.version) return J({ error: 'version_conflict', currentVersion: srv.version, currentData: srv.data }, 409);
    srv.version++; srv.data = b.data; return J({ ok: true, version: srv.version, redis_ok: true });
  }
  return J({}, 404);
};
window.showToast = m => toasts.push(m);
let confirmQ = []; window.confirm = msg => { confirms.push(msg); return confirmQ.length ? confirmQ.shift() : true; };
let lastBlob = null; window.dlBlob = (b, n) => { lastBlob = { b, n }; };
window.handleAuthFailure = () => {};
const posts = () => log.filter(l => l.m === 'POST' && l.url.startsWith('/api/data')).map(l => JSON.parse(l.body));
const dataGets = () => log.filter(l => l.m === 'GET' && l.url.startsWith('/api/data'));
const dlg = () => document.getElementById('conflictDialog');
const dlgOpen = () => dlg().classList.contains('open');
const LS_KEYS = ['circle_data', 'circle_unsynced', 'circle_server_version', 'circle_server_base', 'circle_cash_history', 'circle_audit_outbox', 'circle_receipts'];
const settle = async () => { await until(() => !isSyncing && !persistTimer && !persistPending && !receiptUploading && !legacyMigrating, 8000); await sleep(60); await until(() => !isSyncing && !persistTimer && !persistPending, 8000); };
const reset = async () => {
  clearTimeout(persistTimer); persistTimer = null;
  if (conflictResolve) { const r = conflictResolve; conflictResolve = null; dlg().classList.remove('open'); r('server'); }
  await settle();
  sessionStorage.setItem('circle_token', 'tok');
  syncDirty = false; syncOffline = false; isSyncing = false; persistPending = false; lastServerVersion = 5; bankEditFrom = null;
  Object.assign(srv, { version: 5, data: {}, mode: 'ok' });
  LS_KEYS.forEach(k => localStorage.removeItem(k));
  ALL_DENOMS.forEach(d => counts[d.v] = 0); bankBalance = 0; transactions = []; categories = [...DEFAULT_CATS]; budgets = {}; collections = []; auditLog = []; auditOutbox = []; cashHistory = [];
  confirmQ = []; log.length = 0; toasts.length = 0; confirms.length = 0; lastBlob = null; editingId = null; collectEditIdx = null;
  dlg().classList.remove('open');
  ['modalOverlay', 'collectModal'].forEach(i => document.getElementById(i).classList.remove('open'));
  syncInputs(); renderTxList(); updateSyncIndicator();
};
const mkTx = (id, extra = {}) => migrateTx({ id, type: 'income', summary: 'S' + id, payee: '', amount: 100, status: 'done', date: '2026-10-01', account: '現金', category: '', applied: true, cashBreakdown: null, createdAt: '2026-10-01T00:00:00Z', ...extra });
const basePayload = (txs = [], extra = {}) => ({ counts: { 1000: 5 }, bankBalance: 100, transactions: txs, categories: [...DEFAULT_CATS], budgets: {}, collections: [], auditLog: [], cashHistory: [], savedAt: '2026-10-01T00:00:00Z', ...extra });
const clone = o => JSON.parse(JSON.stringify(o));
const ids = o => (o.transactions || o).map(t => t.id);
const auditCount = a => auditLog.filter(x => x.action === a).length;
// 「同期済みの端末」を作る: サーバーの内容 S0 を取り込み、基準も覚えた状態
const syncedDevice = (S0, v = 5) => { srv.version = v; srv.data = clone(S0); applyData(clone(S0)); rememberServer(v, clone(S0)); };
const setCounts = o => { ALL_DENOMS.forEach(d => counts[d.v] = o[d.v] || 0); syncInputs(); };
const clickDlg = cls => document.querySelector('#conflictDialog .' + cls).click();

// ================= 1. mergeThreeWay 単体
{
  const E = [];
  const M = (b, l, s) => mergeThreeWay(b, l, s);
  const kinds = r => r.notes.map(n => n.kind);
  // 1a 双方の追加（自分の追加は先頭、サーバー順は保つ）
  let r = M(basePayload([mkTx('a')]), basePayload([mkTx('l1'), mkTx('a')]), basePayload([mkTx('o1'), mkTx('a')]));
  ok('1a 双方の追加が残る（自分の追加が先頭・サーバー順は保つ）', JSON.stringify(ids(r.data)) === JSON.stringify(['l1', 'o1', 'a']), ids(r.data));
  // 1b 自分の削除（server 側で変更されていても消す）
  r = M(basePayload([mkTx('a'), mkTx('b')]), basePayload([mkTx('b')]), basePayload([mkTx('a', { amount: 999 }), mkTx('b')]));
  ok('1b 自分が削除した取引は、server 側で変更されていても消える＋notes', JSON.stringify(ids(r.data)) === '["b"]' && kinds(r).includes('deleted_local'), { ids: ids(r.data), notes: r.notes });
  // 1c 他の削除（local で変更していれば残す）
  r = M(basePayload([mkTx('a'), mkTx('b')]), basePayload([mkTx('a'), mkTx('b')]), basePayload([mkTx('b')]));
  ok('1c 他の端末が削除した取引は消える（自分が変更していなければ）', JSON.stringify(ids(r.data)) === '["b"]');
  r = M(basePayload([mkTx('a'), mkTx('b')]), basePayload([mkTx('a', { amount: 777 }), mkTx('b')]), basePayload([mkTx('b')]));
  ok('1c2 他の端末が削除しても、自分が変更していた取引は残る＋notes', ids(r.data).includes('a') && r.data.transactions.find(t => t.id === 'a').amount === 777 && kinds(r).includes('deleted_server_kept'), { ids: ids(r.data), notes: r.notes });
  // 1d 片側だけの変更
  r = M(basePayload([mkTx('a')]), basePayload([mkTx('a', { amount: 111 })]), basePayload([mkTx('a')]));
  ok('1d local だけ変更なら local', r.data.transactions[0].amount === 111 && !kinds(r).includes('both_changed'));
  r = M(basePayload([mkTx('a')]), basePayload([mkTx('a')]), basePayload([mkTx('a', { amount: 222 })]));
  ok('1d2 server だけ変更なら server', r.data.transactions[0].amount === 222 && !kinds(r).includes('both_changed'));
  // 1e 両側の変更 → local 採用 + notes
  r = M(basePayload([mkTx('a')]), basePayload([mkTx('a', { amount: 111 })]), basePayload([mkTx('a', { amount: 222 })]));
  ok('1e 両方変更なら local を採り both_changed を記録', r.data.transactions[0].amount === 111 && kinds(r).includes('both_changed') && r.notes.find(n => n.kind === 'both_changed').summary.includes('Sa'), r.notes);
  // 1f キー順違いは変更ではない（他の端末の変更を自分の古い値で潰さない）
  const ta = mkTx('a'); const reordered = {}; Object.keys(ta).reverse().forEach(k => reordered[k] = ta[k]);
  r = M(basePayload([ta]), basePayload([reordered]), basePayload([mkTx('a', { amount: 555 })]));
  ok('1f キー順だけ違う local は「変更なし」とみなし、server の変更が残る', r.data.transactions[0].amount === 555 && !kinds(r).includes('both_changed'), r.data.transactions[0].amount);
  const bKeys = { ...basePayload([ta]), counts: { 10000: 0, 1000: 5 } }, lKeys = { ...basePayload([ta]), counts: { 1000: 5, 10000: 0 } };
  ok('1f2 canon はキー順に依存しない', canon({ a: 1, b: { x: 1, y: [1, { q: 1, p: 2 }] } }) === canon({ b: { y: [1, { p: 2, q: 1 }], x: 1 }, a: 1 }) && canon(bKeys) === canon(lKeys));
  // 1g 現金・残高の差分合成
  const withCounts = (c, bank = 100) => basePayload([], { counts: c, bankBalance: bank });
  r = M(withCounts({ 1000: 5 }), withCounts({ 1000: 3 }), withCounts({ 1000: 6 }));
  ok('1g base1000円×5・local×3・server×6 → ×4', r.data.counts[1000] === 4 && !kinds(r).includes('clamped'), r.data.counts);
  r = M(withCounts({ 1000: 5 }), withCounts({ 1000: 0 }), withCounts({ 1000: 2 }));
  ok('1g2 0未満は0にクランプして notes', r.data.counts[1000] === 0 && kinds(r).includes('clamped'), { c: r.data.counts[1000], n: r.notes });
  r = M(withCounts({ 500: 1 }, 1000), withCounts({ 500: 1 }, 400), withCounts({ 500: 1 }, 900));
  ok('1g3 通帳残高も server+(local−base)', r.data.bankBalance === 300, r.data.bankBalance);
  r = M(withCounts({ 500: 1 }, 1000), withCounts({ 500: 1 }, 100), withCounts({ 500: 1 }, 200));
  ok('1g4 通帳残高の0未満はクランプ', r.data.bankBalance === 0 && kinds(r).includes('clamped'));
  r = M(withCounts({ 1000: 5 }), withCounts({ 1000: 5 }), withCounts({ 1000: 9 }));
  ok('1g5 local が変えていない金種は server のまま（9）', r.data.counts[1000] === 9);
  // 1h base null
  r = M(null, basePayload([mkTx('l1')], { counts: { 1000: 3 }, bankBalance: 50 }), basePayload([mkTx('o1')], { counts: { 1000: 6 }, bankBalance: 70 }));
  ok('1h base null: 現金・残高は local の値、notes に cash_unverified と no_base', r.data.counts[1000] === 3 && r.data.bankBalance === 50 && kinds(r).includes('cash_unverified') && kinds(r).includes('no_base'), r.notes);
  ok('1h2 base null: 削除は検出できず双方の取引が残る', new Set(ids(r.data)).size === 2 && ids(r.data).includes('l1') && ids(r.data).includes('o1'));
  r = M(null, basePayload([mkTx('a')]), basePayload([]));
  ok('1h3 base null: local にだけある取引は「自分が追加」とみなして残る', ids(r.data).join() === 'a');
  // 1i カテゴリ
  r = M(basePayload([], { categories: ['a', 'b', 'c'] }), basePayload([], { categories: ['a', 'c', 'mine'] }), basePayload([], { categories: ['a', 'b', 'c', 'other'] }));
  ok('1i カテゴリ: 自分の削除(b)・追加(mine)・他の追加(other)を反映、server順+自分の追加は末尾', JSON.stringify(r.data.categories) === JSON.stringify(['a', 'c', 'other', 'mine']), r.data.categories);
  r = M(basePayload([], { categories: ['a', 'b'] }), basePayload([], { categories: ['a', 'b'] }), basePayload([], { categories: ['a'] }));
  ok('1i2 カテゴリ: 他の端末の削除も反映', JSON.stringify(r.data.categories) === '["a"]');
  // 1j 予算
  r = M(basePayload([], { budgets: { x: 1, y: 2, z: 3 } }), basePayload([], { budgets: { x: 10, z: 3, n: 7 } }), basePayload([], { budgets: { x: 1, y: 22, z: 33, o: 5 } }));
  ok('1j 予算: local変更(x=10)・自分の削除(y)・server変更(z=33)・双方の追加(n,o)', r.data.budgets.x === 10 && !('y' in r.data.budgets) && r.data.budgets.z === 33 && r.data.budgets.n === 7 && r.data.budgets.o === 5, r.data.budgets);
  // 1k メンバー・プロジェクト
  const P = (id, extra = {}) => ({ id, name: 'P' + id, amount: 1000, deadline: '', memo: '', paid: [], createdAt: '2026-10-01T00:00:00Z', ...extra });
  const mem = list => ({ _type: 'members', list });
  r = M(basePayload([], { collections: [mem(['A', 'B']), P('p1', { paid: ['A'] })] }), basePayload([], { collections: [mem(['A', 'C']), P('p1', { paid: ['A', 'B'], name: 'local' })] }), basePayload([], { collections: [mem(['A', 'B', 'D']), P('p1', { paid: ['A', 'D'], amount: 2000 })] }));
  const mm = r.data.collections.find(c => c._type === 'members').list, pp = r.data.collections.find(c => !c._type);
  ok('1k メンバーは集合マージ（Bを自分が削除・Cを自分が追加・Dを他が追加）', JSON.stringify(mm) === JSON.stringify(['A', 'D', 'C']), mm);
  ok('1k2 両方で変わったプロジェクトは local の中身＋paid は和集合', pp.name === 'local' && pp.amount === 1000 && JSON.stringify([...pp.paid].sort()) === JSON.stringify(['A', 'B', 'D']) && kinds(r).includes('both_changed'), { pp, n: r.notes });
  r = M(basePayload([], { collections: [P('p1', { paid: ['A'] })] }), basePayload([], { collections: [P('p1', { paid: ['A', 'B'] })] }), basePayload([], { collections: [P('p1', { paid: ['A'], name: 'renamed' })] }));
  ok('1k3 paid だけ変えた local と名前だけ変えた server → both_changed（local採用・paidは和集合）', r.data.collections[0].paid.length === 2, r.data.collections[0]);
  r = M(basePayload([], { collections: [P('p1', { paid: ['A', 'B'] })] }), basePayload([], { collections: [P('p1', { paid: ['B', 'A'] })] }), basePayload([], { collections: [P('p1', { paid: ['A', 'B'], amount: 5 })] }));
  ok('1k4 paid の並び順だけの違いは変更ではない（server の変更が残る）', r.data.collections[0].amount === 5 && !kinds(r).includes('both_changed'));
  const legacyP = { name: 'old', amount: 500, paid: ['A'], createdAt: 'T0' };
  r = M(basePayload([], { collections: [legacyP] }), basePayload([], { collections: [{ ...legacyP, paid: ['A', 'B'] }] }), basePayload([], { collections: [legacyP, P('p2')] }));
  ok('1k5 id の無い古いプロジェクトは name|createdAt で突き合わせ（重複せず、server の新規も残る）', r.data.collections.filter(c => !c._type).length === 2 && r.data.collections.find(c => c.name === 'old').paid.length === 2, r.data.collections);
  r = M(basePayload([], { collections: [P('p1'), P('p2')] }), basePayload([], { collections: [P('p2')] }), basePayload([], { collections: [P('p1'), P('p2'), P('p3')] }));
  ok('1k6 プロジェクトも取引と同じ規則（自分の削除p1・他の追加p3）', r.data.collections.map(c => c.id).join() === 'p2,p3', r.data.collections.map(c => c.id));
  // 1l 操作ログ
  const au = (t, a) => ({ ts: t, action: a, detail: 'd' });
  r = M(basePayload(), basePayload([], { auditLog: [au('2026-10-03T00:00:00Z', 'x'), au('2026-10-01T00:00:00Z', 'dup')] }), basePayload([], { auditLog: [au('2026-10-02T00:00:00Z', 'y'), au('2026-10-01T00:00:00Z', 'dup')] }));
  ok('1l 操作ログ: 重複を除き新しい順', r.data.auditLog.map(a => a.action).join() === 'x,y,dup', r.data.auditLog.map(a => a.action));
  // 1m cashHistory
  const ch = (t, n = 0) => ({ time: t, total: n, counts: {} });
  r = M(basePayload(), basePayload([], { cashHistory: [ch('2026-10-03T00:00:00Z'), ch('2026-10-01T00:00:00Z')] }), basePayload([], { cashHistory: [ch('2026-10-02T00:00:00Z'), ch('2026-10-01T00:00:00Z')] }));
  ok('1m cashHistory: time をキーに和集合・新しい順', r.data.cashHistory.map(h => h.time.slice(8, 10)).join() === '03,02,01', r.data.cashHistory);
  const many = (pre, n) => Array.from({ length: n }, (_, i) => ch(`2026-${pre}-${String(i + 1).padStart(2, '0')}T00:00:00Z`));
  r = M(basePayload(), basePayload([], { cashHistory: many('08', 30) }), basePayload([], { cashHistory: many('09', 30) }));
  ok('1m2 cashHistory: 50件まで（新しい方を残す）', r.data.cashHistory.length === 50 && r.data.cashHistory[0].time.startsWith('2026-09') && r.data.cashHistory[49].time.startsWith('2026-08'), r.data.cashHistory.length);
  // 1n 副作用なし・未知キー・savedAt
  const b0 = basePayload([mkTx('a')]), l0 = { ...basePayload([mkTx('a'), mkTx('l')]), extraL: 1 }, s0 = { ...basePayload([mkTx('a'), mkTx('o')]), extraS: 2, unknown: 's' };
  const snap = canon([b0, l0, s0]);
  r = M(b0, { ...l0, unknown: 'l' }, s0);
  ok('1n 引数を変更しない（純粋）', canon([b0, l0, s0]) === snap);
  ok('1n2 未知のキーは server を基本に local で上書き、savedAt は現在時刻', r.data.extraS === 2 && r.data.extraL === 1 && r.data.unknown === 'l' && Math.abs(Date.now() - Date.parse(r.data.savedAt)) < 5000);
  r = M(basePayload([mkTx('a')]), basePayload([mkTx('a')]), {});
  ok('1n3 server が空でも例外にならない（server が削除した扱い）', Array.isArray(r.data.transactions));
}

// ================= 2. persist 409 → ダイアログ
{
  // 2a 「両方」: 両方の取引が残り、サーバーへ1回で保存される。現金は差分合成
  await reset();
  const S0 = basePayload([mkTx('s1')], { counts: { 1000: 5 } });
  syncedDevice(S0);
  srv.version = 6; srv.data = clone({ ...S0, transactions: [mkTx('o1'), mkTx('s1')], counts: { 1000: 6 } });
  transactions.unshift(mkTx('l1')); counts[1000] = 3; syncInputs();
  log.length = 0;
  const pr = persist();
  ok('2a 409 でダイアログが開く（confirm は使わない）', await until(dlgOpen) && confirms.length === 0 && isSyncing === true);
  ok('2a2 ダイアログの文言・3つのボタン', dlg().querySelector('h3').textContent === '⚠ 他の端末でも同時に変更されました' && dlg().querySelector('p').textContent.includes('この端末の変更と、他の端末の変更が重なりました。どうしますか？') && [...dlg().querySelectorAll('button')].map(b => b.textContent).join('|') === '両方の変更を残す（おすすめ）|他の端末の内容を使う（この端末の変更は捨てる）|この端末の内容で上書きする（他の端末の変更は消える）');
  dlg().click();
  ok('2a3 背景クリックでは閉じない', dlgOpen());
  clickDlg('btn-reload'); await pr; await settle();
  const pp = posts();
  ok('2a4 サーバーへの POST は2回（409 になった1回＋統合後の1回）', pp.length === 2 && pp[1].expectedVersion === 6, pp.map(p => p.expectedVersion));
  ok('2a5 統合後のサーバー内容に両方の取引が入る', ['l1', 'o1', 's1'].every(i => ids(srv.data).includes(i)) && srv.version === 7, ids(srv.data));
  ok('2a6 現金は 6+(3−5)=4 になり、画面・メモリも同じ', srv.data.counts[1000] === 4 && counts[1000] === 4 && document.getElementById('input_1000').value === '4', { s: srv.data.counts[1000], m: counts[1000] });
  ok('2a7 トースト「🔀 両方の変更をまとめて保存しました」・警告は出ない', toasts.includes('🔀 両方の変更をまとめて保存しました') && !toasts.some(t => t.includes('両方で変更されていました')));
  ok('2a8 操作ログ「競合を統合」が1件、保存済み（サーバーのログにも）', auditCount('競合を統合') === 1 && srv.data.auditLog.some(a => a.action === '競合を統合'));
  ok('2a9 ダイアログは閉じ、同期済みの状態（未送信なし・基準は新しい版）', !dlgOpen() && syncDirty === false && readUnsynced() === null && JSON.parse(localStorage.getItem('circle_server_base')).v === 7 && lastServerVersion === 7);
}
{
  // 2b 「他の端末の内容を使う」
  await reset();
  const S0 = basePayload([mkTx('s1')]);
  syncedDevice(S0);
  srv.version = 6; srv.data = clone({ ...S0, transactions: [mkTx('o1'), mkTx('s1')], bankBalance: 777 });
  transactions.unshift(mkTx('l1')); log.length = 0;
  const pr = persist(); await until(dlgOpen); clickDlg('btn-keep'); await pr; await settle();
  ok('2b 他の端末の内容: 自分の変更は捨てられ、サーバーの内容になる', JSON.stringify(ids(transactions)) === '["o1","s1"]' && bankBalance === 777, ids(transactions));
  ok('2b2 送信しない（POST は409の1回だけ）・版と基準はサーバーのもの', posts().length === 1 && lastServerVersion === 6 && JSON.parse(localStorage.getItem('circle_server_base')).v === 6 && toasts.includes('🔄 最新を読み込みました'));
  ok('2b3 この選択では操作ログを足さない', auditCount('競合を統合') === 0 && auditCount('競合を上書き') === 0);
}
{
  // 2c 「この端末の内容で上書き」: confirm キャンセルでダイアログに戻る
  await reset();
  const S0 = basePayload([mkTx('s1')]);
  syncedDevice(S0);
  srv.version = 6; srv.data = clone({ ...S0, transactions: [mkTx('o1'), mkTx('s1')] });
  transactions.unshift(mkTx('l1')); log.length = 0; confirmQ = [false];
  const pr = persist(); await until(dlgOpen); clickDlg('btn-force'); await sleep(60);
  ok('2c 念押しの confirm をキャンセルするとダイアログに戻る（まだ送信していない）', dlgOpen() && confirms.length === 1 && confirms[0] === '他の端末の変更が消えます。本当に上書きしますか？' && posts().length === 1 && isSyncing === true, { confirms, posts: posts().length });
  clickDlg('btn-force'); await pr; await settle();
  ok('2c2 OK なら上書き: サーバーには自分の内容だけ（o1 は消える）', JSON.stringify(ids(srv.data)) === '["l1","s1"]' && toasts.includes('💾 強制保存しました'), ids(srv.data));
  ok('2c3 操作ログ「競合を上書き」が1件', auditCount('競合を上書き') === 1 && srv.data.auditLog.some(a => a.action === '競合を上書き'));
}
{
  // 2d ダイアログ表示中は定期同期・他の保存が割り込まない
  await reset();
  const S0 = basePayload([mkTx('s1')]);
  syncedDevice(S0);
  srv.version = 6; srv.data = clone({ ...S0, transactions: [mkTx('o1'), mkTx('s1')] });
  transactions.unshift(mkTx('l1')); const pr = persist(); await until(dlgOpen);
  const keep = { v: srv.version, d: srv.data };
  srv.version = 9; srv.data = clone({ ...S0, transactions: [mkTx('zzz')], bankBalance: 4242 }); log.length = 0;
  await pollOnce();
  ok('2d ダイアログ中の pollOnce は何も取りに行かず、メモリも上書きしない', dataGets().length === 0 && ids(transactions).includes('l1') && bankBalance !== 4242, { gets: dataGets().length });
  srv.version = keep.v; srv.data = keep.d;
  persist(); await sleep(50);
  ok('2d2 ダイアログ中の persist は保留（POST しない・persistPending）', posts().length === 0 && persistPending === true);
  clickDlg('btn-reload'); await pr; await settle();
  ok('2d3 選択後は保留分も含めて保存が済み、最終的にサーバーに自分の取引が入る', ids(srv.data).includes('l1') && ids(srv.data).includes('o1') && !persistPending && !isSyncing, ids(srv.data));
}
{
  // 2e 基準が無い時の「両方」: 現金は local を採り、警告トーストが出る
  await reset();
  const S0 = basePayload([mkTx('s1')], { counts: { 1000: 5 } });
  syncedDevice(S0); localStorage.removeItem('circle_server_base');
  srv.version = 6; srv.data = clone({ ...S0, transactions: [mkTx('o1'), mkTx('s1')], counts: { 1000: 6 } });
  transactions.unshift(mkTx('l1')); counts[1000] = 3;
  const pr = persist(); await until(dlgOpen); clickDlg('btn-reload'); await pr; await settle();
  ok('2e 基準なし: 取引は両方残り、現金は local の値（3）', ['l1', 'o1', 's1'].every(i => ids(srv.data).includes(i)) && srv.data.counts[1000] === 3);
  ok('2e2 操作ログの詳細に「基準なし」', auditLog.find(a => a.action === '競合を統合')?.detail.includes('基準なし'), auditLog[0]);
  await sleep(2800);
  ok('2e3 少し後に「現金・残高・同じ取引が両方で変更…」の警告トースト', toasts.some(t => t.startsWith('⚠ 現金・残高・同じ取引が両方で変更されていました')), toasts);
}
{
  // 2f 統合後の保存が再び409 → conflict_again で未送信扱い（自動再試行に任せる）。再送で基準が合い、二重に足されない
  await reset();
  const S0 = basePayload([mkTx('s1')], { counts: { 1000: 5 } });
  syncedDevice(S0);
  srv.version = 6; srv.data = clone({ ...S0, transactions: [mkTx('o1'), mkTx('s1')], counts: { 1000: 6 } });
  transactions.unshift(mkTx('l1')); counts[1000] = 3;
  const origSave = apiSave; let n = 0; window.apiSave = async p => { n++; if (n === 2) srv.version++; return origSave(p); };
  const pr = persist(); await until(dlgOpen); clickDlg('btn-reload'); await pr; await settle(); window.apiSave = origSave;
  ok('2f 統合後の保存が競合したら未送信のまま（toast・印）', syncDirty === true && readUnsynced() !== null && toasts.some(t => t.includes('同時に更新されたため保存できませんでした')));
  ok('2f2 メモリは統合済みの状態（現金4）で、未送信の土台はサーバーの版6', counts[1000] === 4 && readUnsynced().base === 6 && lastServerVersion === 6, { c: counts[1000], u: readUnsynced(), v: lastServerVersion });
  // 他の端末の版は 7（上で srv.version++）。サーバーの現金は6のまま。再送すると再び409→ダイアログ→統合。基準(v6)は版が合うので使われる
  log.length = 0; const pr2 = persist(); await until(dlgOpen); clickDlg('btn-reload'); await pr2; await settle();
  ok('2f3 再送で再び統合しても現金は 6+(4−6)=4（二重に足されない）', counts[1000] === 4 && srv.data.counts[1000] === 4 && syncDirty === false, { c: counts[1000], s: srv.data.counts[1000] });
}

// ================= 3. loadData の未送信＋サーバー更新
{
  const setup = async () => {
    await reset();
    const S0 = basePayload([mkTx('s1')], { counts: { 1000: 5 } });
    syncedDevice(S0);                                   // base=5
    transactions.unshift(mkTx('l1')); counts[1000] = 3;  // 端末で編集して送信前に閉じた
    saveLocal(); clearTimeout(persistTimer); persistTimer = null;
    srv.version = 7; srv.data = clone({ ...S0, transactions: [mkTx('o1'), mkTx('s1')], counts: { 1000: 6 } });
    applyData({}); lastServerVersion = 0; log.length = 0; toasts.length = 0;  // 再起動（メモリは空）
  };
  await setup();
  const pr = loadData();
  ok('3a 未送信＋サーバー更新でダイアログが開く（confirm は使わない）', await until(dlgOpen) && confirms.length === 0);
  ok('3a2 ダイアログ中は isSyncing で保護され、pollOnce は何も取りに行かない', isSyncing === true && (await pollOnce(), true) && log.filter(l => l.url.startsWith('/api/data?v=1')).length === 0);
  const getsBefore = dataGets().length;
  clickDlg('btn-reload'); await pr; await settle();
  ok('3b 「両方」: 両方の取引が入り、現金は 6+(3−5)=4、サーバーへ1回で保存', ['l1', 'o1', 's1'].every(i => ids(srv.data).includes(i)) && srv.data.counts[1000] === 4 && posts().length === 1 && posts()[0].expectedVersion === 7, { ids: ids(srv.data), posts: posts().length });
  ok('3b2 メモリ・版・未送信の印', ids(transactions).length === 3 && lastServerVersion === 8 && readUnsynced() === null && syncDirty === false && toasts.includes('🔀 両方の変更をまとめて保存しました') && auditCount('競合を統合') === 1);
  await setup();
  const pr2 = loadData(); await until(dlgOpen); clickDlg('btn-keep'); await pr2; await settle();
  ok('3c 「他の端末」: サーバーの内容を使い、未送信の印は消え、送信しない', JSON.stringify(ids(transactions)) === '["o1","s1"]' && counts[1000] === 6 && readUnsynced() === null && posts().length === 0 && lastServerVersion === 7, { ids: ids(transactions), posts: posts().length });
  await setup();
  confirmQ = [false];
  const pr3 = loadData(); await until(dlgOpen); clickDlg('btn-force'); await sleep(60);
  ok('3d 「この端末」: confirm キャンセルでダイアログに戻る', dlgOpen() && confirms.length === 1 && posts().length === 0);
  clickDlg('btn-force'); await pr3; await settle();
  ok('3d2 OK なら上書き（サーバーは自分の内容・最新の版を前提に送る）', JSON.stringify(ids(srv.data)) === '["l1","s1"]' && posts().length === 1 && posts()[0].expectedVersion === 7 && auditCount('競合を上書き') === 1, { ids: ids(srv.data) });
  // 3e 誰も更新していなければダイアログなしでそのまま送る（既存挙動）
  await reset();
  const S0 = basePayload([mkTx('s1')]); syncedDevice(S0); transactions.unshift(mkTx('l1')); saveLocal(); applyData({}); lastServerVersion = 0; log.length = 0;
  await loadData(); await settle();
  ok('3e 誰も更新していなければダイアログなしでそのまま送る', !dlgOpen() && confirms.length === 0 && ids(srv.data).includes('l1') && auditCount('競合を上書き') === 0);
}

// ================= 4. 基準データ（base）
{
  await reset();
  const S0 = basePayload([mkTx('s1')]); delete S0.cashHistory; const rawTx = { id: 's1', type: 'income', summary: 'raw', amount: 5, status: 'done', date: '2026-10-01' };
  S0.transactions = [rawTx];
  srv.version = 5; srv.data = clone(S0); await loadData(); await settle();
  const b = JSON.parse(localStorage.getItem('circle_server_base'));
  ok('4a サーバーから取り込んだ元データそのものを {v,data} で保存する（applyData の補完前の内容）', b.v === 5 && canon(b.data) === canon(S0) && !('cashBreakdown' in b.data.transactions[0]), b);
  transactions.unshift(mkTx('n1')); await persist(); await settle();
  const b2 = JSON.parse(localStorage.getItem('circle_server_base'));
  ok('4b 保存成功時は送った payload を版6の基準にする', b2.v === 6 && canon(b2.data) === canon(srv.data), { v: b2.v });
  ok('4c 版が lastServerVersion と一致すれば使える', canon(readBase()) === canon(srv.data));
  lastServerVersion = 9; ok('4d 版が一致しなければ null', readBase() === null);
  localStorage.setItem('circle_unsynced', JSON.stringify({ base: 6 })); ok('4e 未送信の印の base と一致すれば使える', readBase() !== null);
  localStorage.setItem('circle_unsynced', JSON.stringify({ base: 3 })); ok('4e2 どちらとも一致しなければ null', readBase() === null);
  localStorage.removeItem('circle_unsynced'); lastServerVersion = 6;
  localStorage.setItem('circle_server_base', '{broken'); ok('4f 壊れていれば null', readBase() === null);
  localStorage.setItem('circle_server_base', JSON.stringify({ v: 6 })); ok('4f2 data が無ければ null', readBase() === null);
  localStorage.removeItem('circle_server_base'); ok('4g 無ければ null', readBase() === null);
  // 4h 容量不足で書けなくても保存は成功する
  const origSet = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (k === 'circle_server_base') throw new Error('quota'); return origSet.call(this, k, v); };
  let threw = false; try { writeBase(1, {}); } catch { threw = true; }
  transactions.unshift(mkTx('n2')); await persist(); await settle(); Storage.prototype.setItem = origSet;
  ok('4h base の書き込み失敗は握りつぶす（保存は成功）', !threw && ids(srv.data).includes('n2') && !syncDirty);
  // 4i 古い版の基準だと、統合で「基準なし」扱い（他の端末の変更を古い基準で潰さない）
  await reset();
  const S1 = basePayload([mkTx('s1')], { counts: { 1000: 5 } }); syncedDevice(S1); writeBase(2, { ...S1, counts: { 1000: 0 } });
  srv.version = 6; srv.data = clone({ ...S1, counts: { 1000: 6 } }); counts[1000] = 3;
  const pr = persist(); await until(dlgOpen); clickDlg('btn-reload'); await pr; await settle();
  ok('4i 版が合わない基準は使われない（現金は local=3、詳細に基準なし）', srv.data.counts[1000] === 3 && auditLog.find(a => a.action === '競合を統合').detail.includes('基準なし'), srv.data.counts[1000]);
}

// ================= 5. ユーザー管理の撤去
{
  const html = await (await realFetch('/index.html', { cache: 'no-store' })).text();
  ok('5a DOM に #userBtn / #userMgrModal が無い', !document.getElementById('userBtn') && !document.getElementById('userMgrModal') && !document.getElementById('newUserRole'));
  ok('5b userRole・applyRole 等の関数・変数が無い', typeof userRole === 'undefined' && typeof applyRole === 'undefined' && typeof openUserMgr === 'undefined' && typeof addUser === 'undefined' && typeof deleteUser === 'undefined' && typeof showConflict === 'undefined' && typeof resolveConflict === 'undefined' && typeof conflictServerVersion === 'undefined');
  ok('5c ソースに userRole|applyRole|viewer|userMgr|/api/users が0件', !/userRole|applyRole|viewer|userMgr|\/api\/users/.test(html), html.match(/userRole|applyRole|viewer|userMgr|\/api\/users/g));
  ok('5d ソースに閲覧のみ権限・canEdit が無く、circle_role は handleAuthFailure の掃除だけ', !/閲覧のみ権限|canEdit/.test(html) && (html.match(/circle_role/g) || []).length === 1);
  await reset(); transactions = [mkTx('e1')]; renderTxList();
  const h = document.getElementById('txList').innerHTML;
  ok('5e 取引一覧は常に編集・削除・写真ボタンを出す', h.includes('編集</button>') && h.includes('削除</button>') && h.includes('🖼 写真'));
  addAudit('x', 'y');
  ok('5f 新しい操作ログに user が付かない', !('user' in auditLog[0]));
}

// ================= 6. 集金プロジェクト
{
  await reset(); saveMembers(['太郎', '花子']); await settle();
  openCollectModal(); document.getElementById('cpName').value = '合宿'; document.getElementById('cpAmount').value = '3000'; document.getElementById('cpDeadline').value = '2026-12-01'; document.getElementById('cpMemo').value = 'メモ';
  saveCollectProject();
  const p0 = getProjects()[0];
  ok('6a 新規作成で id（UUID）と createdAt が付く', /^[0-9a-f-]{36}$/.test(p0.id) && !!p0.createdAt && Array.isArray(p0.paid) && auditCount('集金プロジェクト作成') === 1, p0);
  confirmQ = [false]; togglePaid(0, '太郎'); await settle();
  ok('6b 支払い済みにできる', getProjects()[0].paid.join() === '太郎');
  renderCollection();
  const editBtn = [...document.querySelectorAll('#projectList button')].find(b => b.textContent.includes('✏ 編集'));
  ok('6c 各カードに「✏ 編集」ボタンがある', !!editBtn);
  const origId = p0.id, origCreated = p0.createdAt;
  editBtn.click();
  ok('6d 編集ボタンでモーダルが開き、値が入っている', document.getElementById('collectModal').classList.contains('open') && document.getElementById('cpName').value === '合宿' && document.getElementById('cpAmount').value === '3000');
  document.getElementById('cpName').value = '合宿（改）'; document.getElementById('cpAmount').value = '3500'; saveCollectProject(); await settle();
  const p1 = getProjects()[0];
  ok('6e 編集しても id・createdAt・paid が保たれ、名前・金額は変わる', p1.id === origId && p1.createdAt === origCreated && p1.paid.join() === '太郎' && p1.name === '合宿（改）' && p1.amount === 3500 && collections.filter(c => !c._type).length === 1, p1);
  ok('6f 更新が操作ログに残る', auditCount('集金プロジェクト更新') === 1);
  // 古いプロジェクト（id 無し）は、編集して保存する時に id を振る。createdAt は変えない
  collections.push({ name: '旧', amount: 100, deadline: '', memo: '', paid: ['花子'], createdAt: '2025-01-01T00:00:00Z' }); renderCollection();
  openCollectModal(1); saveCollectProject(); await settle();
  const old = getProjects()[1];
  ok('6g 古いプロジェクトを編集保存すると id が付き、createdAt・paid は保たれる（読み込み時には付けない）', !!old.id && old.createdAt === '2025-01-01T00:00:00Z' && old.paid.join() === '花子', old);
  applyData({ collections: [{ name: '旧2', amount: 1, paid: [], createdAt: 'T' }] });
  ok('6h 読み込み（applyData）では id を付けない', !('id' in getProjects()[0]));
  await reset(); applyData({ collections: [{ _type: 'members', list: ['太郎'] }, { name: 'x', amount: 10, paid: ['太郎'], createdAt: 'T', id: 'pid' }] });
  confirmQ = [true]; togglePaid(0, '太郎'); await settle();
  ok('6i 支払い済みを外すと「集金取消し」が1件', auditCount('集金取消し') === 1 && getProjects()[0].paid.length === 0);
  togglePaid(0, '太郎'); await settle();
  ok('6j 取引として記録した後に「💡 現金タブの枚数も更新してください」・集金記録1件・枚数は変わらない', toasts.includes('💡 現金タブの枚数も更新してください') && auditCount('集金記録') === 1 && ALL_DENOMS.every(d => counts[d.v] === 0));
  deleteProject(0); await settle();
  ok('6k 削除が操作ログに残る', auditCount('集金プロジェクト削除') === 1 && getProjects().length === 0);
}

// ================= 7. CSV
{
  const P = parseCSV;
  ok('7a 引用符内のカンマ・改行・""', JSON.stringify(P('a,"b,c","d\ne","f""g"\n')) === JSON.stringify([['a', 'b,c', 'd\ne', 'f"g']]), P('a,"b,c","d\ne","f""g"\n'));
  ok('7b BOM・CRLF・末尾の空行', JSON.stringify(P('﻿x,y\r\n1,2\r\n\r\n\r\n')) === JSON.stringify([['x', 'y'], ['1', '2']]), P('﻿x,y\r\n1,2\r\n\r\n'));
  ok('7c 空欄・末尾の空セル・最後の改行なし', JSON.stringify(P('a,,c\n1,2,')) === JSON.stringify([['a', '', 'c'], ['1', '2', '']]));
  ok('7d 引用符内の CRLF は保たれる', P('"a\r\nb",c')[0][0] === 'a\r\nb');
  // 列順違い・カンマ入り金額・不正行
  const csv = '﻿金額,日付,摘要,種別,ID,状態,口座,カテゴリ,支払先\r\n"1,200",2026/4/5,"お茶, お菓子",支払い,id-1,済み,現金,食費,店A\r\n300,2026-04-06,会費,入金,,未処理,通帳,部費,\r\n0,2026-04-06,ゼロ円,入金,,済み,現金,,\r\n-5,2026-04-06,負,入金,,済み,現金,,\r\n1.5,2026-04-06,小数,入金,,済み,現金,,\r\n99999999999,2026-04-06,上限超え,入金,,済み,現金,,\r\nabc,2026-04-06,文字,入金,,済み,現金,,\r\n100,2026-02-30,存在しない日,入金,,済み,現金,,\r\n100,令和6年,日付不正,入金,,済み,現金,,\r\n\r\n';
  let { txs, bad } = rowsToTxs(parseCSV(csv));
  ok('7e 見出しの列名で対応付け（列順違い）・カンマ入り金額・YYYY/M/D の正規化', txs.length === 2 && txs[0].amount === 1200 && txs[0].date === '2026-04-05' && txs[0].summary === 'お茶, お菓子' && txs[0].type === 'payment' && txs[0].id === 'id-1' && txs[0].status === 'done' && txs[0].payee === '店A' && txs[0].category === '食費' && txs[0].account === '現金' && txs[1].type === 'income' && txs[1].status === 'pending' && txs[1].account === '通帳' && txs[1].id.length > 10, txs);
  ok('7f 金額0・負・小数・上限超え・文字・存在しない日付・不正日付は取り込まず7行と数える（空行は数えない）', bad === 7, bad);
  ({ txs, bad } = rowsToTxs(parseCSV('2026-05-01,入金,会費,,500,済み,部費,現金,idp\n2026-05-02,支払い,備品,店,,済み,備品,現金,')));
  ok('7g 見出しが無ければ今の列位置', txs.length === 1 && txs[0].id === 'idp' && txs[0].amount === 500 && bad === 1, { txs, bad });
  // Excel（数値の日付シリアル・数値の金額）
  ({ txs, bad } = rowsToTxs([['日付', '種別', '摘要', '支払先', '金額', '状態', 'カテゴリ', '口座', 'ID'], [45292, '入金', 'x', '', 1500, '済み', '', '現金', 'xid'], ['2026-1-2', '支払い', 'y', '', '2,500', '未処理', '', '', ''], [45292, '入金', 'bad', '', 0, '', '', '', ''], ['x', '入金', 'bad2', '', 5, '', '', '', ''], []]));
  ok('7h Excel: シリアル値の日付を日付に変換・同じ検証（不正2行）', txs.length === 2 && txs[0].date === '2024-01-01' && txs[0].amount === 1500 && txs[1].date === '2026-01-02' && txs[1].amount === 2500 && bad === 2, { txs, bad });
  ok('7i parseDate/parseAmount の境界', parseDate('2024-02-29') === '2024-02-29' && parseDate('2023-02-29') === null && parseDate('2026/12/1') === '2026-12-01' && parseAmount('9,999,999,999') === 9999999999 && parseAmount('10000000000') === null && parseAmount(' 12 ') === 12);
  // 重複判定（ID 優先）
  await reset(); transactions = [mkTx('dupA', { date: '2026-04-01', amount: 100, summary: '同じ' })];
  let n = mergeTransactions([{ id: 'dupA', date: '2026-09-09', type: 'income', amount: 7, summary: '別の中身', status: 'done' }]);
  ok('7j ID が一致すれば中身が違っても重複', n === 0 && transactions.length === 1);
  n = mergeTransactions([{ id: 'other', date: '2026-04-01', type: 'income', amount: 100, summary: '同じ', status: 'done' }]);
  ok('7k ID が一致しなければ従来の 日付|金額|摘要 で重複判定', n === 0 && transactions.length === 1);
  n = mergeTransactions([{ date: '2026-04-01', type: 'income', amount: 100, summary: '同じ', status: 'done' }, { id: 'newid', date: '2026-04-02', type: 'income', amount: 100, summary: '違う', status: 'done' }]);
  ok('7l ID が無ければ従来の判定、どちらでも一致しなければ追加', n === 1 && transactions.length === 2 && transactions[1].id === 'newid');
  n = mergeTransactions([{ id: 'x1', date: '2026-04-03', type: 'income', amount: 1, summary: 'a', status: 'done' }, { id: 'x1', date: '2026-04-04', type: 'income', amount: 2, summary: 'b', status: 'done' }]);
  ok('7m 同じファイル内の同じ ID も重複', n === 1);
  // 数式インジェクション対策の往復
  await reset();
  const nasty = ['=1+1', '+81 90', '-5円返金', '@SUM(A1)', '\tタブ始まり', '\r改行始まり', '普通', '引用符"と,カンマ', "'シングル", '=cmd|\' /C calc\'!A0'];
  transactions = nasty.map((s, i) => mkTx('f' + i, { summary: s, payee: s, category: i === 0 ? '=cat' : '' }));
  exportCSV(); const text = await lastBlob.b.text();
  ok('7n 書き出し: 危険な先頭文字のセルは ' + "'" + ' が付き、金額（数値）には付かない', text.includes("\"'=1+1\"") && text.includes("\"'+81 90\"") && text.includes("\"'-5円返金\"") && text.includes("\"'@SUM(A1)\"") && text.includes("\"'\tタブ始まり\"") && text.includes('"普通"') && text.includes('"100"') && !text.includes('"\'100"'), text.slice(0, 400));
  const back = rowsToTxs(parseCSV(text));
  ok('7o 書き出し→読み込みで元の値に戻る（摘要・支払先・カテゴリ・ID・金額・日付）', back.bad === 0 && back.txs.length === nasty.length && back.txs.every((t, i) => t.summary === nasty[i] && t.payee === nasty[i] && t.id === 'f' + i && t.amount === 100 && t.date === '2026-10-01') && back.txs[0].category === '=cat', back.txs.map(t => t.summary));
  // 取り込み全体（importFile）: 確認ダイアログに読み込めない行数・取り込み後の件数
  await reset(); confirmQ = [true];
  const file = new File(['日付,種別,摘要,支払先,金額,状態,カテゴリ,口座,ID\n2026-06-01,入金,A,,100,済み,,現金,\n2026-06-02,入金,B,,0,済み,,現金,\n2026-06-03,入金,C,,x,済み,,現金,\n'], 't.csv', { type: 'text/csv' });
  importFile({ target: { files: [file], value: '' } });
  await until(() => confirms.length > 0 && transactions.length > 0, 4000); await settle();
  ok('7p importFile: 確認に「読み込めない行が2行あります（取り込みません）」・取り込むのは1件', confirms[0].includes('1件の取引をインポートしますか？') && confirms[0].includes('読み込めない行が2行あります（取り込みません）') && transactions.length === 1 && auditCount('インポート') === 1, { confirms, n: transactions.length });
}

// ================= 8. 現金の保存履歴
{
  await reset();
  setCounts({ 1000: 3, 500: 2 }); saveSnapshot(); await settle();
  ok('8a 保存すると cashHistory に入り、payload にも入る', cashHistory.length === 1 && cashHistory[0].total === 4000 && posts().at(-1).data.cashHistory.length === 1 && posts().at(-1).data.cashHistory[0].counts[1000] === 3, cashHistory);
  ok('8a2 localStorage の旧キーには書かない', localStorage.getItem('circle_cash_history') === null);
  // 別端末想定
  const fromServer = clone(srv.data); cashHistory = []; setCounts({}); applyData(fromServer);
  ok('8b 別端末で applyData すると履歴が見える（行に「↩ この状態に戻す」ボタン）', cashHistory.length === 1 && document.getElementById('historyList').textContent.includes('¥4,000') && document.getElementById('historyList').textContent.includes('↩ この状態に戻す'));
  setCounts({ 1000: 9 }); log.length = 0; confirms.length = 0;
  document.querySelector('#historyList button').click(); await settle();
  ok('8c 「この状態に戻す」: confirm に日時と合計 → 枚数が戻り（1000×3・500×2）、画面・保存に反映', confirms.length === 1 && confirms[0].includes('¥4,000') && /\d{4}\/\d{2}\/\d{2}/.test(confirms[0]) && counts[1000] === 3 && counts[500] === 2 && document.getElementById('input_1000').value === '3' && srv.data.counts[1000] === 3 && auditCount('現金を履歴から復元') === 1, { confirms, counts: { ...counts } });
  confirmQ = [false]; setCounts({ 1000: 9 }); restoreHistory(cashHistory[0].time);
  ok('8c2 confirm をキャンセルすれば戻さない', counts[1000] === 9);
  // 旧 localStorage の履歴の移行
  await reset();
  localStorage.setItem('circle_cash_history', JSON.stringify([{ time: '2026-09-02T00:00:00Z', total: 200, counts: { 100: 2 } }, { time: '2026-09-01T00:00:00Z', total: 100, counts: { 100: 1 } }]));
  applyData(basePayload([], { cashHistory: [{ time: '2026-09-03T00:00:00Z', total: 300, counts: {} }, { time: '2026-09-01T00:00:00Z', total: 100, counts: { 100: 1 } }] }));
  ok('8d 旧 localStorage の履歴が time の和集合で取り込まれる（新しい順）', cashHistory.map(h => h.time.slice(8, 10)).join() === '03,02,01', cashHistory.map(h => h.time));
  ok('8d2 保存が成功するまでは旧キーを消さない', localStorage.getItem('circle_cash_history') !== null);
  srv.mode = 'offline'; await persist(); await settle();
  ok('8d3 保存に失敗した時も旧キーは残る', localStorage.getItem('circle_cash_history') !== null && syncDirty === true);
  srv.mode = 'ok'; await persist(); await settle();
  ok('8d4 取り込んだ内容を含む保存が成功したら旧キーが消える', localStorage.getItem('circle_cash_history') === null && srv.data.cashHistory.length === 3, { k: localStorage.getItem('circle_cash_history'), n: srv.data.cashHistory?.length });
  // 旧キーに新しい分が後から増えた場合は、その分が送られるまで消さない
  localStorage.setItem('circle_cash_history', JSON.stringify([{ time: '2026-09-09T00:00:00Z', total: 9, counts: {} }]));
  dropLegacyHistory(cashHistory); ok('8d5 送った内容に含まれない旧履歴があるうちは消さない', localStorage.getItem('circle_cash_history') !== null);
  localStorage.removeItem('circle_cash_history');
  // 全削除
  confirms.length = 0; clearHistory(); await settle();
  ok('8e 履歴の全削除: confirm に「全ての端末から消えます」・メモリ/サーバーとも空・ログ1件', confirms[0].includes('全ての端末から消えます') && cashHistory.length === 0 && srv.data.cashHistory.length === 0 && auditCount('保存履歴の全削除') === 1 && document.getElementById('historyList').textContent.includes('保存履歴がありません'));
  // バックアップ・復元
  await reset(); setCounts({ 1000: 1 }); saveSnapshot(); await settle();
  const bk = await buildFullBackup({ includeReceipts: false });
  ok('8f バックアップに cashHistory が入る（payload 由来）', Array.isArray(bk.cashHistory) && bk.cashHistory.length === 1);
  await reset();
  const rr = await restoreBackup(clone(bk), false);
  ok('8g 復元（マージ）で cashHistory が状態変数に入り、localStorage には書かない', cashHistory.length === 1 && localStorage.getItem('circle_cash_history') === null);
  cashHistory = [{ time: '2020-01-01T00:00:00Z', total: 0, counts: {} }]; await restoreBackup(clone(bk), true);
  ok('8g2 復元（置換）は元の履歴を置き換える', cashHistory.length === 1 && cashHistory[0].time === bk.cashHistory[0].time);
}

// ================= 9. 現金入金の内訳
{
  await reset();
  const fill = ({ type = 'income', status = 'done', account = '現金', amount, summary = 'x', recv = {}, id = null }) => {
    openModal(id); setType(type); setStatus(status); setAccount(account);
    document.getElementById('formSummary').value = summary; document.getElementById('formAmount').value = amount;
    ALL_DENOMS.forEach(d => document.getElementById('recv_' + d.v).value = recv[d.v] || ''); updateRecvUi();
  };
  const vis = () => document.getElementById('recvGroup').style.display !== 'none';
  openModal();
  setType('income'); setStatus('done'); setAccount('現金'); const v1 = vis();
  setType('payment'); const v2 = vis(); setType('income'); setStatus('pending'); const v3 = vis(); setStatus('done'); setAccount('通帳'); const v4 = vis(); setAccount('現金'); const v5 = vis();
  ok('9a 入金・現金・入金済みの時だけ「受け取った内訳」欄が出る', v1 && !v2 && !v3 && !v4 && v5);
  const labels = [...document.querySelectorAll('#recvGrid label')].map(l => l.textContent.trim());
  ok('9a2 金種ごとの入力（大きい順）', labels.join('|') === '一万円|五千円|千円|500円|100円|50円|10円|5円|1円', labels);
  document.getElementById('formAmount').value = 3000; document.getElementById('recv_1000').value = 2; updateRecvUi();
  ok('9a3 合計と取引金額との差を表示', document.getElementById('recvSum').textContent.includes('¥2,000') && document.getElementById('recvSum').textContent.includes('¥1,000'), document.getElementById('recvSum').textContent);
  closeModal();
  // 9b 内訳あり: 枚数が増える
  await reset(); setCounts({ 1000: 1 });
  fill({ amount: 3000, recv: { 1000: 2, 500: 2 } }); saveTx(); await settle();
  let t = transactions[0];
  ok('9b 内訳ありで枚数が増え、cashBreakdown に保存（applied）', counts[1000] === 3 && counts[500] === 2 && JSON.stringify(t.cashBreakdown) === '{"500":2,"1000":2}' && t.applied === true && srv.data.counts[1000] === 3, { c: { ...counts }, t });
  ok('9b2 内訳ありではヒントを出さない', !toasts.some(x => x.includes('内訳を入れると自動で足せます')));
  // 9c 合計不一致
  await reset(); setCounts({});
  fill({ amount: 3000, recv: { 1000: 2 } }); saveTx();
  ok('9c 合計が金額と一致しなければ保存しない（トースト・枚数不変・モーダルは開いたまま）', transactions.length === 0 && counts[1000] === 0 && toasts.some(x => x.includes('一致しません')) && document.getElementById('modalOverlay').classList.contains('open'), toasts);
  closeModal();
  // 9d 内訳なし
  await reset(); setCounts({ 1000: 1 });
  fill({ amount: 3000 }); saveTx(); await settle();
  t = transactions[0];
  ok('9d 内訳なしは枚数を変えず（applied:true・cashBreakdown:null）', counts[1000] === 1 && t.applied === true && t.cashBreakdown === null);
  await sleep(2700);
  ok('9d2 保存後にトースト「💡 現金タブの枚数も更新してください（内訳を入れると自動で足せます）」', toasts.includes('💡 現金タブの枚数も更新してください（内訳を入れると自動で足せます）'), toasts);
  deleteTx(t.id); await settle();
  ok('9d3 内訳なしの取引を削除しても枚数は変わらない', counts[1000] === 1 && transactions.length === 0);
  // 9e 編集で内訳が復元され、前回の効果を戻してから新しい効果
  await reset(); setCounts({});
  fill({ amount: 3000, recv: { 1000: 2, 500: 2 } }); saveTx(); await settle(); t = transactions[0];
  openModal(t.id);
  ok('9e 編集時に前回の内訳が入力欄に復元され欄も出る', document.getElementById('recv_1000').value === '2' && document.getElementById('recv_500').value === '2' && document.getElementById('recv_5000').value === '' && vis());
  document.getElementById('recv_1000').value = 3; document.getElementById('recv_500').value = ''; updateRecvUi(); saveTx(); await settle();
  ok('9e2 編集: 前回の内訳(1000×2,500×2)を引いて新しい内訳(1000×3)を足す', counts[1000] === 3 && counts[500] === 0 && JSON.stringify(transactions[0].cashBreakdown) === '{"1000":3}', { ...counts });
  // 9f 削除: 枚数不足なら取り消せない
  setCounts({ 1000: 1 }); const nTx = transactions.length; deleteTx(transactions[0].id);
  ok('9f 削除: 受け取った枚数が手元に足りなければ何も変えず中止（トースト）', transactions.length === nTx && counts[1000] === 1 && toasts.includes(CASH_SHORT_MSG));
  setCounts({ 1000: 5 }); deleteTx(transactions[0].id); await settle();
  ok('9f2 削除: 足りていれば内訳を引いて削除', transactions.length === 0 && counts[1000] === 2);
  // 9g 済み→未・未→済み
  await reset(); setCounts({});
  fill({ amount: 3000, recv: { 1000: 3 } }); saveTx(); await settle(); t = transactions[0]; toasts.length = 0;
  setCounts({ 1000: 1 }); toggleTxStatus(t.id);
  ok('9g 入金済み→未入金: 枚数が足りなければ取り消せない（status も変えない）', t.status === 'done' && t.applied === true && counts[1000] === 1 && toasts.includes(CASH_SHORT_MSG));
  setCounts({ 1000: 4 }); toggleTxStatus(t.id); await settle();
  ok('9g2 足りていれば枚数を引き、未入金・applied:false・内訳なし', t.status === 'pending' && t.applied === false && t.cashBreakdown === null && counts[1000] === 1);
  toggleTxStatus(t.id); await settle();
  ok('9g3 未入金→入金済みは枚数を変えず（内訳が無いため）、ヒントを出す', t.status === 'done' && t.applied === true && counts[1000] === 1 && toasts.includes('💡 現金タブの枚数も更新してください'));
  // 9h 編集で枚数不足なら中止（何も変えない）
  await reset(); setCounts({});
  fill({ amount: 3000, recv: { 1000: 3 } }); saveTx(); await settle(); t = transactions[0];
  setCounts({ 1000: 1 }); fill({ id: t.id, amount: 3000, recv: { 1000: 3 }, summary: '変更' }); toasts.length = 0; saveTx();
  ok('9h 編集: 前回の内訳を引けなければ中止（取引も枚数も変わらない）', transactions[0].summary !== '変更' && counts[1000] === 1 && toasts.includes(CASH_SHORT_MSG) && document.getElementById('modalOverlay').classList.contains('open'));
  closeModal();
  // 9i 編集で支払いに変える: 現金不足なら全体を中止（部分的に戻さない）
  await reset(); setCounts({ 500: 4 });
  fill({ amount: 3000, recv: { 1000: 3 } }); saveTx(); await settle(); t = transactions[0];
  fill({ id: t.id, type: 'payment', amount: 5000, summary: '支払いへ' }); saveTx();
  ok('9i 編集で支払いに変えて残高不足なら中止し、枚数は元のまま（入金の取消しだけ先に反映しない）', counts[1000] === 3 && counts[500] === 4 && transactions[0].type === 'income' && toasts.some(x => x.includes('現金残高が不足')), { ...counts });
  closeModal();
  fill({ id: t.id, type: 'payment', amount: 1000, summary: '支払いへ' }); saveTx(); await settle();
  ok('9i2 編集で支払いに変える: 入金の内訳(1000×3)を引いてから支払いの枚数(500×2)を使う', counts[1000] === 0 && counts[500] === 2 && transactions[0].type === 'payment' && JSON.stringify(transactions[0].cashBreakdown) === '{"500":2}', { ...counts, t: transactions[0] });
  // 9j 支払い側の既存挙動
  await reset(); setCounts({ 1000: 5 });
  fill({ type: 'payment', amount: 3000, summary: '備品' }); saveTx(); await settle(); t = transactions[0];
  ok('9j 支払い（現金・済み）: 枚数が減り内訳が付く', counts[1000] === 2 && JSON.stringify(t.cashBreakdown) === '{"1000":3}' && t.applied === true && confirms.length === 1);
  toggleTxStatus(t.id); await settle();
  ok('9j2 支払済み→未払い: 足し戻す', counts[1000] === 5 && t.status === 'pending' && t.cashBreakdown === null);
  toggleTxStatus(t.id); await settle();
  ok('9j3 未払い→支払済み: 再び使う', counts[1000] === 2 && t.status === 'done');
  fill({ id: t.id, type: 'payment', amount: 2000, summary: '備品' }); saveTx(); await settle();
  ok('9j4 支払いの編集: 前回を戻して新しい金額で使う', counts[1000] === 3 && JSON.stringify(transactions[0].cashBreakdown) === '{"1000":2}', { ...counts });
  deleteTx(transactions[0].id); await settle();
  ok('9j5 支払いの削除: 足し戻す', counts[1000] === 5);
  fill({ type: 'payment', amount: 99999, summary: '高額' }); saveTx();
  ok('9j6 現金不足なら支払済みで保存できない（既存）', transactions.length === 0 && toasts.some(x => x.includes('現金残高が不足しているため')));
  closeModal();
  // 9k 通帳（既存挙動）
  await reset(); bankBalance = 1000;
  fill({ type: 'income', account: '通帳', amount: 500 }); saveTx(); await settle();
  ok('9k 通帳の入金: 残高が増える（内訳欄は出ない）', bankBalance === 1500 && transactions[0].applied === true);
  deleteTx(transactions[0].id); await settle();
  ok('9k2 通帳の入金を削除: 残高を戻す', bankBalance === 1000);
  fill({ type: 'payment', account: '通帳', amount: 300 }); saveTx(); await settle(); t = transactions[0];
  fill({ id: t.id, type: 'payment', account: '通帳', amount: 100 }); saveTx(); await settle();
  ok('9k3 通帳の支払いを編集: 前回を戻して新しい金額で引く（1000→700→900）', bankBalance === 900);
}

// ================= 10. 操作ログ
{
  await reset();
  document.getElementById('bankBalanceInput').value = 5000; onBankBalanceChange();
  document.getElementById('bankBalanceInput').value = 50000; onBankBalanceChange();
  document.getElementById('bankBalanceInput').value = 6000; onBankBalanceChange();
  await sleep(100);
  ok('10a 通帳残高の連続入力中は記録しない', auditCount('通帳残高変更') === 0);
  await sleep(700); await settle();
  ok('10b 入力が止まってから1件（¥旧→¥新）', auditCount('通帳残高変更') === 1 && auditLog.find(a => a.action === '通帳残高変更').detail === '¥0→¥6,000', auditLog.map(a => a.action + ':' + a.detail));
  document.getElementById('bankBalanceInput').value = 7000; onBankBalanceChange(); document.getElementById('bankBalanceInput').value = 6000; onBankBalanceChange(); await sleep(800); await settle();
  ok('10c 結局変わらなければ記録しない', auditCount('通帳残高変更') === 1);
  setCount(1000, 3); await sleep(800); await settle();
  ok('10d 現金枚数の操作だけでは通帳残高変更は記録されない', auditCount('通帳残高変更') === 1);
  document.getElementById('bankBalanceInput').value = 100; onBankBalanceChange(); await sleep(800); await settle();
  ok('10e 2回目の入力は別の1件', auditCount('通帳残高変更') === 2 && auditLog[0].detail === '¥6,000→¥100');
  ok('10f 通帳残高変更は保存データ（サーバー）にも入っている', srv.data.auditLog.filter(a => a.action === '通帳残高変更').length === 2);
  await reset(); counts[1000] = 2; confirmQ = [false]; resetAll();
  ok('10g 現金リセットを confirm キャンセルすれば記録しない', auditCount('現金リセット') === 0 && counts[1000] === 2);
  resetAll(); await settle();
  ok('10h 現金リセット 1件', auditCount('現金リセット') === 1 && counts[1000] === 0);
  document.getElementById('newMemberInput').value = '次郎'; addMember(); await settle();
  deleteMember(0); await settle();
  ok('10i メンバー追加・削除が1件ずつ', auditCount('メンバー追加') === 1 && auditCount('メンバー削除') === 1 && auditLog.find(a => a.action === 'メンバー削除').detail === '次郎');
  document.getElementById('newCatInput').value = '新カテゴリ'; addCategory(); await settle();
  deleteCat(categories.indexOf('新カテゴリ')); await settle();
  ok('10j カテゴリ追加・削除が1件ずつ', auditCount('カテゴリ追加') === 1 && auditCount('カテゴリ削除') === 1);
  renderCatManager(); document.getElementById('budgetCatSel').value = '食費'; document.getElementById('budgetAmt').value = 8000; setBudget(); await settle();
  ok('10k 予算設定が1件', auditCount('予算設定') === 1 && budgets['食費'] === 8000);
  ok('10l 予算に削除ボタンがある（H）', [...document.querySelectorAll('#budgetList button')].some(b => b.textContent === '削除'));
  confirmQ = [false]; deleteBudget('食費'); ok('10m 予算削除を confirm キャンセルすれば消えない', budgets['食費'] === 8000 && auditCount('予算削除') === 0);
  [...document.querySelectorAll('#budgetList button')].find(b => b.textContent === '削除').click(); await settle();
  ok('10n 予算削除（ボタン→confirm→delete→保存→ログ1件）', !('食費' in budgets) && auditCount('予算削除') === 1 && !('食費' in srv.data.budgets) && document.getElementById('budgetList').textContent.includes('予算が設定されていません'), srv.data.budgets);
  // 保存履歴の全削除（8e）・履歴から復元（8c）・競合を統合（2a8/3b2）・競合を上書き（2c3/3d2）は各項で1件ずつ確認している
}

// ---- 後片付け
await reset();
window.fetch = realFetch; window.showToast = realToast; window.confirm = realConfirm; window.dlBlob = realDl; window.handleAuthFailure = realAuthFail; delete document.hidden;
sessionStorage.removeItem('circle_token'); LS_KEYS.forEach(k => localStorage.removeItem(k));
R.push('externalFetchCalls=' + log.filter(l => l.external).length);
const out = R.join('\n') + `\n\nPASS=${R.filter(x => x.startsWith('PASS')).length} FAIL=${R.filter(x => x.startsWith('FAIL')).length}`;
window.__phase4Result = out;
return out;
})()
