// Opus レビューで追加した「未送信の印（circle_unsynced）」と強制上書き時の再競合のテスト。
// サーバーは楽観ロック（expectedVersion が違えば 409）を再現する。本番へは一切通信しない。
(async () => {
const R = [];
const ok = (name, cond, extra) => R.push((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''));
const sleep = ms => new Promise(r => setTimeout(r, ms));
Object.defineProperty(document, 'hidden', { value: false, configurable: true });
const realFetch = window.fetch, realConfirm = window.confirm, realToast = window.showToast, realAsk = window.askConflict;
const srv = { version: 5, data: {}, mode: 'ok', bumpBeforeNextPost: 0 };
const posts = [];
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });
window.fetch = async (url, opt = {}) => {
  url = String(url); const m = opt.method || 'GET';
  if (srv.mode === 'offline') return J({ error: 'offline' }, 503);
  if (url.startsWith('/api/audit')) return J(m === 'GET' ? { entries: [] } : { ok: true, count: 0 });
  if (!url.startsWith('/api/data')) return J({}, 404);
  if (m === 'GET') return url.includes('v=1') ? J({ version: srv.version, redis_ok: true }) : J({ data: srv.data, version: srv.version, redis_ok: true });
  const b = JSON.parse(opt.body); posts.push(b);
  await sleep(100);
  if (srv.bumpBeforeNextPost > 0) { srv.bumpBeforeNextPost--; srv.version++; }   // 他端末が割り込んで保存した状況
  if (b.expectedVersion !== srv.version) return J({ error: 'version_conflict', currentVersion: srv.version, currentData: srv.data }, 409);
  srv.version++; srv.data = b.data; return J({ ok: true, version: srv.version, redis_ok: true });
};
// Phase 4: 競合の選択は confirm() ではなく3択ダイアログ（askConflict）になった。ここでは選択を直接返す偽物に差し替える（本物のダイアログは phase4-client-tests.js で検証）。
// 旧: OK/キャンセルの2択 → 新: 'merge'|'server'|'local'。confirmAnswer を dialogChoice に置き換え、ダイアログが出た回数を confirmCalls に数える
let dialogChoice = 'local', confirmCalls = 0; window.askConflict = async () => { confirmCalls++; return dialogChoice; };
const toasts = []; window.showToast = m => toasts.push(m);
const unsynced = () => JSON.parse(localStorage.getItem('circle_unsynced') || 'null');
const serverState = (bank) => ({ counts: { 1000: 1 }, bankBalance: bank, transactions: [], categories: [...DEFAULT_CATS], budgets: {}, collections: [], auditLog: [], savedAt: '2026-10-01T00:00:00Z' });
const reset = () => {
  sessionStorage.setItem('circle_token', 'tok'); clearTimeout(persistTimer); persistTimer = null;
  syncDirty = false; syncOffline = false; isSyncing = false; persistPending = false;
  srv.version = 5; srv.data = serverState(100); srv.mode = 'ok'; srv.bumpBeforeNextPost = 0;
  posts.length = 0; toasts.length = 0; confirmCalls = 0; dialogChoice = 'local';
  ['circle_unsynced', 'circle_server_version', 'circle_data', 'circle_audit_outbox'].forEach(k => localStorage.removeItem(k));
  auditLog = []; auditOutbox = [];
};
// 「端末で編集した状態」を作って保存だけした（＝送信前に閉じた）状況を再現する
const editLocallyThenClose = async (base, bank) => {
  applyData(serverState(100)); setServerVersion(base);
  bankBalance = bank; schedulePersist();                // 端末には保存、送信はまとめ待ち
  clearTimeout(persistTimer); persistTimer = null;      // 送信前にアプリを閉じた
};

// T1: 送れなかった変更が残っていて、他の端末は更新していない → 起動時にそのまま送る
reset(); await editLocallyThenClose(5, 555);
ok('T1a 閉じる前に未送信の印が残る（base=5）', unsynced()?.base === 5, unsynced());
applyData(serverState(0)); lastServerVersion = 0;         // 再起動（メモリは空）
await loadData(); await sleep(50);
ok('T1b 起動時に端末の内容を送信した', posts.length === 1 && posts[0].data.bankBalance === 555 && posts[0].expectedVersion === 5, posts.map(p => [p.expectedVersion, p.data.bankBalance]));
ok('T1c サーバーの古い内容で上書きしていない', bankBalance === 555 && srv.data.bankBalance === 555);
ok('T1d 送信後は印が消え、版が記録される', unsynced() === null && localStorage.getItem('circle_server_version') === '6', { u: unsynced(), v: localStorage.getItem('circle_server_version') });
ok('T1e 競合ダイアログは出ない（誰も更新していないため）', confirmCalls === 0);
ok('T1f 利用者に送信したことを知らせる', toasts.some(t => t.includes('前回送れなかった変更')), toasts);

// T2: 送れなかった変更があり、その後に他の端末も更新した → 選んでもらう（ここでは「他の端末の内容を使う」）
reset(); await editLocallyThenClose(5, 555);
srv.version = 7; srv.data = serverState(700);
applyData(serverState(0)); lastServerVersion = 0; dialogChoice = 'server';   // 旧: キャンセル＝他の端末の最新を使う
await loadData(); await sleep(50);
ok('T2a 競合ダイアログが1回出る', confirmCalls === 1);
ok('T2b 「他の端末の内容」: 他の端末の最新が使われ、送信しない', bankBalance === 700 && posts.length === 0, { bankBalance, posts: posts.length });
ok('T2c 「他の端末の内容」: 印は消え、端末にもサーバーの内容と版が書き写される', unsynced() === null && JSON.parse(localStorage.getItem('circle_data')).bankBalance === 700 && localStorage.getItem('circle_server_version') === '7');

// T2': 同じ状況で OK＝この端末の内容で上書き
reset(); await editLocallyThenClose(5, 555);
srv.version = 7; srv.data = serverState(700);
applyData(serverState(0)); lastServerVersion = 0; dialogChoice = 'local';    // 旧: OK＝この端末の内容で上書き
await loadData(); await sleep(50);
ok("T2'a 「この端末」: この端末の内容で上書き（最新の版を前提に送る）", posts.length === 1 && posts[0].expectedVersion === 7 && srv.data.bankBalance === 555, posts.map(p => p.expectedVersion));
ok("T2'b 「この端末」: 送信後は印が消える", unsynced() === null && syncDirty === false);

// T3: 未送信の変更がある状態でオフライン起動 → つながったら、前提の版で再送
reset(); await editLocallyThenClose(5, 555);
applyData(serverState(0)); lastServerVersion = 0; srv.mode = 'offline';
await loadData(); await sleep(50);
ok('T3a オフライン起動: 端末の内容を表示し、前提の版を復元して未送信扱い', bankBalance === 555 && lastServerVersion === 5 && syncDirty === true, { bankBalance, lastServerVersion, syncDirty });
srv.mode = 'ok'; await pollOnce(); await sleep(250);
ok('T3b つながったら取り込む前に再送（base=5 で成功）', posts.length === 1 && posts[0].expectedVersion === 5 && srv.data.bankBalance === 555, posts.map(p => p.expectedVersion));
ok('T3c 再送後は印も未送信表示も消える', unsynced() === null && syncDirty === false);

// T4: 強制上書きを選んだが、送り直す間にさらに別の端末が保存した → 成功扱いにしない
reset(); applyData(serverState(100)); setServerVersion(5);
srv.version = 6; srv.data = serverState(600); srv.bumpBeforeNextPost = 0;
dialogChoice = 'local';                                   // 旧: キャンセル＝強制上書き
bankBalance = 999;
const origApiSave = apiSave; let calls = 0;
// 2回目の送信の直前に他端末が保存した状況
window.apiSave = async (p) => { calls++; if (calls === 2) { srv.version++; } return origApiSave(p); };
await persist(); await sleep(50); window.apiSave = origApiSave;
ok('T4a 2回目も競合したら「強制保存しました」を出さない', !toasts.some(t => t.includes('強制保存しました')) && toasts.some(t => t.includes('同時に更新')), toasts);
ok('T4b 未送信のまま扱い、印も残る（後で自動再試行）', syncDirty === true && unsynced() !== null, { syncDirty, u: unsynced() });

// T5: ポーリングでサーバーの更新を取り込んだら、端末にも内容と版を書き写す（オフライン起動に備える）
reset(); applyData(serverState(100)); setServerVersion(5);
srv.version = 12; srv.data = serverState(4242);
await pollOnce(); await sleep(50);
ok('T5 取り込んだ内容と版が端末に残る', bankBalance === 4242 && JSON.parse(localStorage.getItem('circle_data')).bankBalance === 4242 && localStorage.getItem('circle_server_version') === '12' && unsynced() === null);

// T6: 送信中にさらに入力があった場合、送信成功でも印は消さない（その入力はまだ未送信）
reset(); applyData(serverState(100)); setServerVersion(5);
bankBalance = 1; const pr = persist();
await sleep(20); setCount(1000, 9);                       // 送信中に±を押した
await pr;
ok('T6a 送信成功時、まとめ待ちがあれば印を残す', unsynced() !== null && persistTimer !== null);
await sleep(800);
ok('T6b まとめ送信が終われば印が消える', unsynced() === null && srv.data.counts[1000] === 9, { u: unsynced(), c: srv.data.counts[1000] });

window.fetch = realFetch; window.confirm = realConfirm; window.showToast = realToast; window.askConflict = realAsk; delete document.hidden;
sessionStorage.removeItem('circle_token');
['circle_unsynced', 'circle_server_version', 'circle_data', 'circle_audit_outbox'].forEach(k => localStorage.removeItem(k));
return R.join('\n') + `\n\nPASS=${R.filter(x => x.startsWith('PASS')).length} FAIL=${R.filter(x => x.startsWith('FAIL')).length}`;
})()
