// umabu の旧データ（取引に領収書画像が埋め込まれた形式）を読み込んだ時に、画像を失わないことのテスト（Phase 3 の仕様に合わせて書き直し）。
// Phase 2 では「端末の localStorage（circle_receipts）に書き写す」だったが、Phase 3 では「IndexedDB に取り込み → /api/receipt へ送信 →
// 送り終えてから初めてクラウドの旧データから画像を外す」になった。偽サーバーに差し替えるので本番へは一切通信しない。
(async () => {
const R = [];
const ok = (name, cond, extra) => R.push((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) return false; await sleep(25); } return true; };
Object.defineProperty(document, 'hidden', { value: false, configurable: true });
const realFetch = window.fetch, realToast = window.showToast;
// 実際にデコードできる約数十KBの画像を5枚作る（ノイズ入り）
const mkImg = (seed) => { const c = document.createElement('canvas'); c.width = 400; c.height = 300; const x = c.getContext('2d'); let s = seed * 7919 + 1; for (let y = 0; y < 300; y += 3) for (let xx = 0; xx < 400; xx += 3) { s = (s * 1664525 + 1013904223) >>> 0; x.fillStyle = `rgb(${s >>> 24},${(s >>> 16) & 255},${(s >>> 8) & 255})`; x.fillRect(xx, y, 3, 3); } return c.toDataURL('image/jpeg', 0.8); };
const IMGS = [1, 2, 3, 4, 5].map(mkImg);
const legacy = {
  counts: { 1000: 3 }, bankBalance: 320803, categories: [...DEFAULT_CATS], budgets: {}, collections: [], auditLog: [], savedAt: '2026-07-01T07:27:10Z',
  transactions: [0, 1, 2, 3, 4, 5, 6].map(i => ({ id: 'u' + i, type: 'payment', summary: '取引' + i, payee: '', amount: 100 * (i + 1), status: 'done', date: '2026-06-0' + (i + 1), account: '通帳', category: '', applied: true, cashBreakdown: null, createdAt: '2026-06-01T00:00:00Z', ...(i < 5 ? { receipt: IMGS[i] } : {}) }))
};
const srv = { version: 104, data: JSON.parse(JSON.stringify(legacy)), rc: 'offline', receipts: new Map() };
const posts = [], dataPosts = [];
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });
window.fetch = async (url, opt = {}) => {
  url = String(url); const m = opt.method || 'GET';
  if (url.startsWith('/api/audit')) return J(m === 'GET' ? { entries: [] } : { ok: true, count: 0 });
  if (url.startsWith('/api/receipt')) {
    if (srv.rc === 'offline') return J({ error: 'offline' }, 503);
    if (m === 'POST') { const b = JSON.parse(opt.body); posts.push(b.id); if ('r' + (await sha256(b.data)).slice(0, 32) !== b.id) return J({ error: 'id_mismatch' }, 400); srv.receipts.set(b.id, b); return J({ ok: true, id: b.id }); }
    const u = new URL(url, location.origin);
    if (u.searchParams.has('thumbs')) return J({ thumbs: Object.fromEntries(u.searchParams.get('thumbs').split(',').map(id => [id, srv.receipts.get(id)?.thumb ?? null])) });
    const r = srv.receipts.get(u.searchParams.get('id')); return r ? J({ id: r.id, data: r.data }) : J({ error: 'not_found' }, 404);
  }
  if (!url.startsWith('/api/data')) return J({}, 404);
  if (m === 'GET') return url.includes('v=1') ? J({ version: srv.version }) : J({ data: srv.data, version: srv.version, redis_ok: true });
  const b = JSON.parse(opt.body); dataPosts.push({ bytes: opt.body.length, b });
  if (b.expectedVersion !== srv.version) return J({ error: 'version_conflict', currentVersion: srv.version, currentData: srv.data }, 409);
  srv.version++; srv.data = b.data; return J({ ok: true, version: srv.version });
};
const toasts = []; window.showToast = m => toasts.push(m);
const db = await rcDb(); if (db) await rcTx(db, 'readwrite', s => s.clear()); rcMem.clear(); thumbCache.clear(); thumbMiss.clear(); legacyIdMap.clear();
['circle_receipts', 'circle_unsynced', 'circle_server_version', 'circle_data', 'circle_audit_outbox'].forEach(k => localStorage.removeItem(k));
sessionStorage.setItem('circle_token', 'tok'); clearTimeout(persistTimer); persistTimer = null;
syncDirty = false; isSyncing = false; persistPending = false; auditLog = []; auditOutbox = []; rcGen++; rcScanGen = -1; receiptPendingN = 0;
const settle = async () => { await until(() => !receiptUploading && !legacyMigrating && !isSyncing); await sleep(80); await until(() => !receiptUploading && !legacyMigrating && !isSyncing); };
const hasImg = v => JSON.stringify(v).includes('data:image');

// 1. 旧データを読み込んだだけ（何も編集していない）。画像の送信はまだ失敗している（503）
await loadData(); await settle();
const recs = await rcAll();
ok('1a 読み込んだだけで、5枚の画像が端末の IndexedDB に書き写される（原本のまま）', recs.length === 5 && IMGS.every(i => recs.some(r => r.full === i)), recs.length);
ok('1b localStorage の circle_receipts には書かない', localStorage.getItem('circle_receipts') === null);
ok('1c 画面上の取引は receiptIds を持ち、旧形式の receipt / receipts は消えている', transactions.filter(t => t.receiptIds.length === 1).length === 5 && transactions.every(t => !('receipt' in t) && !('receipts' in t)));

// 2. バックアップには（端末にある）全画像が入る
const bk = await buildFullBackup();
ok('2 バックアップに5枚の原寸が receiptFiles で含まれる', Object.keys(bk.receiptFiles).length === 5 && IMGS.every(i => Object.values(bk.receiptFiles).includes(i)) && bk._receiptsMissing === 0);

// 3. 画像の送信が終わるまでは、保存してもクラウドの旧データから画像を外さない
ok('3a 読み込み直後の保存（receiptIds 付与）は成功し、旧 receipts をそのまま含む', dataPosts.length >= 1 && dataPosts.every(p => p.b.data.transactions.filter(t => t.receipts?.length === 1).length === 5));
bankBalance = 320000; await persist(); await settle();
ok('3b 画像の送信が503で失敗し続ける間は、保存しても旧 receipts は消えない', dataPosts.at(-1).b.data.transactions.filter(t => t.receipts?.length === 1 && IMGS.includes(t.receipts[0])).length === 5 && receiptPendingN === 5);

// 4. 送信が終わると、次の保存でクラウドの旧データから画像が外れる
srv.rc = 'ok'; await pollOnce(); await settle();
ok('4a 5枚ともクラウド（/api/receipt）に原本のまま保存された', srv.receipts.size === 5 && IMGS.every(i => [...srv.receipts.values()].some(r => r.data === i)));
const last = dataPosts.at(-1);
ok('4b 送信後の保存では画像を含まず（数KB）、receiptIds だけになる', last.bytes < 20000 && !hasImg(last.b.data) && last.b.data.transactions.filter(t => t.receiptIds?.length === 1).length === 5 && transactions.every(t => !t._legacyReceipts), { bytes: last.bytes });
ok('4c クラウドのデータから画像が外れている', !hasImg(srv.data));

// 5. 別の端末を想定：端末の画像を消して、クラウドの新しいデータを読み込む → サーバーから取れるので見える
const db2 = await rcDb(); if (db2) await rcTx(db2, 'readwrite', s => s.clear()); thumbCache.clear();
applyData(JSON.parse(JSON.stringify(srv.data)));
await until(() => thumbCache.size >= 5);
ok('5a 別の端末でも5枚のサムネイルが表示される', thumbCache.size === 5 && document.querySelectorAll('#txList .tx-item img').length === 5);
const full = await getFullReceipt(transactions[0].receiptIds[0]);
ok('5b 原寸も取得できる（元の画像と一致）', IMGS.includes(full));

// 6. 元の端末では、再読み込み後も画像が残っている
await loadData(); await settle();
ok('6 再読み込みしても5枚の写真が付いている', transactions.filter(t => t.receiptIds.length === 1).length === 5);

window.fetch = realFetch; window.showToast = realToast; delete document.hidden; sessionStorage.removeItem('circle_token');
const db3 = await rcDb(); if (db3) await rcTx(db3, 'readwrite', s => s.clear());
['circle_receipts', 'circle_unsynced', 'circle_server_version', 'circle_data', 'circle_audit_outbox'].forEach(k => localStorage.removeItem(k));
return R.join('\n') + `\n\nPASS=${R.filter(x => x.startsWith('PASS')).length} FAIL=${R.filter(x => x.startsWith('FAIL')).length}`;
})()
