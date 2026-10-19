// Phase 6 ブラウザテスト。ページ（リポジトリを http.server で配信）に対し、このファイルの中身を (0,eval) で実行する。
// 結果は window.__p6 = {results:[{name,pass,detail}], done, pass, fail} に置く。fetch は偽物に差し替え（本番・実 Upstash へは出ない）
(async()=>{
const out={results:[],done:false,pass:0,fail:0};window.__p6=out;
const ok=(name,cond,detail)=>{out.results.push({name,pass:!!cond,detail:cond?undefined:detail});};
const eq=(name,a,b)=>{const x=canon(a),y=canon(b);ok(name,x===y,`got ${x} / want ${y}`);};
const has=(name,text,sub)=>ok(name,String(text).includes(sub),`"${sub}" not in "${String(text).slice(0,300)}"`);
let origPersist=null;
try{
// ---------- 環境の差し替え ----------
let confirms=[],confirmAns=true,toasts=[];
window.confirm=m=>{confirms.push(String(m));return typeof confirmAns==='function'?!!confirmAns(String(m)):confirmAns;};
window.showToast=m=>{toasts.push(String(m));};
let printed=0;window.print=()=>{printed++;};
let posted=null,serverData={},serverVersion=1,fetchLog=[];
const J=(o,st=200)=>new Response(JSON.stringify(o),{status:st,headers:{'Content-Type':'application/json'}});
window.fetch=async(url,opt)=>{
  url=String(url);fetchLog.push(url);
  if(!/^\/api\//.test(url))throw new Error('blocked-non-api-fetch '+url);
  if(url.startsWith('/api/data')&&opt&&opt.method==='POST'){posted=JSON.parse(opt.body);return J({version:serverVersion+1});}
  if(url.startsWith('/api/data?v=1'))return J({version:serverVersion});
  if(url.startsWith('/api/data'))return J({data:serverData,version:serverVersion,redis_ok:true});
  if(url.startsWith('/api/audit'))return J({entries:[]});
  if(url.startsWith('/api/receipt'))return J({thumbs:{}});
  return J({},404);
};
sessionStorage.removeItem('circle_token');
deviceName='テスト端末';
const pcalls=[];origPersist=window.persist;
window.persist=function(){pcalls.push(auditLog.slice(0,3).map(a=>a.action));return origPersist.apply(this,arguments);};

let _n=0;
const T=(date,type,amount,o={})=>({id:'t'+(++_n),date,type,summary:'x'+_n,payee:'',amount,status:'done',category:'',account:'現金',cashBreakdown:null,receiptIds:[],createdAt:'2020-01-01T00:00:00Z',...o});
const D=(y,m,d)=>`${y}-${pad2(m)}-${pad2(d)}`;
const find=id=>transactions.find(t=>t.id===id);
const acts=()=>auditLog.map(a=>a.action);
function setup(d={}){
  confirms=[];toasts=[];confirmAns=true;fiscalSel=0;currentFilter='all';currentPeriod='all';
  clearSearch();
  localStorage.removeItem('circle_unsynced');
  applyData({counts:{},bankBalance:0,transactions:[],...d});
  auditLog=[];pcalls.length=0;
}
const closedRec=(fy,closing=0,extra={})=>{const[from,to]=fyRange(fy);return{id:'fy'+fy,fy,from,to,opening:0,income:{items:[],total:0},payment:{items:[],total:0},closing,pending:{income:{count:0,total:0},payment:{count:0,total:0}},unassigned:{count:0,income:0,payment:0,total:0},reconcile:{actualNow:0,cashNow:0,bankNow:0,after:0,actualAtEnd:0,cashAtEnd:0,bankAtEnd:0,unsettledAtEnd:0,diff:0},closedAt:'2021-04-01T00:00:00.000Z',closedBy:'x',...extra};};
function openAdd(o={}){
  openModal();
  document.getElementById('formDate').value=o.date||todayStr();
  document.getElementById('formSummary').value=o.summary||'テスト取引';
  document.getElementById('formAmount').value=o.amount||'1000';
  setType(o.type||'payment');setStatus(o.status||'done');setAccount(o.account||'未設定');
  document.getElementById('formEvent').value=o.event||'';document.getElementById('formPaidBy').value=o.paidBy||'';
}
const text=id=>document.getElementById(id).textContent;
const html=id=>document.getElementById(id).innerHTML;

// 決算用のデータセット（Y年度: 4月始まり）
const Y=2020;
function dataset(iAccount){
  const f=T(D(Y,9,5),'payment',6000,{category:'交通費',account:'立替',paidBy:'A',settlementId:'S1'});
  const txs=[
    T(D(Y,5,1),'income',10000,{category:'部費',account:'現金'}),
    T(D(Y,6,1),'income',5000,{category:'部費',account:'通帳'}),
    T(D(Y,7,1),'income',3000,{category:'',account:'現金'}),
    T(D(Y,8,1),'income',20000,{category:'助成金',account:'通帳'}),
    T(D(Y,9,1),'payment',4000,{category:'備品',account:'現金'}),
    f,
    T(D(Y,10,1),'payment',2000,{category:'食費',status:'pending'}),
    T(D(Y,10,2),'income',1000,{category:'部費',status:'pending'}),
    T(D(Y,11,1),'income',7000,{category:'部費',account:iAccount}),
    T(D(Y-1,12,1),'payment',1500,{category:'備品'}),
    T(D(Y+1,4,10),'income',9000,{category:'部費',account:'現金'}),
    T(D(Y+1,5,1),'payment',800,{category:'備品',account:'現金'}),
    T(D(Y+1,6,1),'income',500,{category:'部費',account:'現金',status:'pending'}),
  ];
  const S1={id:'S1',date:D(Y+1,4,20),member:'A',account:'現金',amount:6000,txIds:[f.id],cashBreakdown:{5000:1,1000:1},createdAt:'2021-04-20T00:00:00Z'};
  return{transactions:txs,settlements:[S1],counts:{10000:3,5000:1,1000:1,100:2},bankBalance:iAccount==='通帳'?57000:50000};
}
const fdata=(d,extra={})=>({transactions:d.transactions,settlements:d.settlements,fiscalYears:[],counts:d.counts,bankBalance:d.bankBalance,today:'2021-06-01',...extra});

// ================= 0. 既定値・payload =================
setup();
eq('0 applyData 既定: settings',settings,{orgName:'',fyStartMonth:4,openingByFy:{}});
eq('0 applyData 既定: fiscalYears/settlements',[fiscalYears,settlements],[[],[]]);
{const p=buildPayload();ok('0 buildPayload に settings/fiscalYears/settlements',p.settings&&Array.isArray(p.fiscalYears)&&Array.isArray(p.settlements),Object.keys(p).join());}
applyData({settings:{orgName:'X',fyStartMonth:99,openingByFy:{2020:'100',abc:5,2021:null}},fiscalYears:[{id:'fyA',fy:2020},{noid:1}],settlements:[{id:'s'},null]});
eq('0 壊れた設定は既定へ・不正キーは捨てる',settings,{orgName:'X',fyStartMonth:4,openingByFy:{2020:100}});
eq('0 id の無い記録は読まない',[fiscalYears.length,settlements.length],[1,1]);
// 旧データ（新キー無し）の取引は変わらない
setup({transactions:[T('2020-05-01','income',100)]});
ok('0 旧データの取引に event/paidBy/settlementId を足さない',!('event' in transactions[0])&&!('paidBy' in transactions[0])&&!('settlementId' in transactions[0]),JSON.stringify(transactions[0]));

// ================= 1. fyRange / fyOf =================
setup();
eq('1 fyRange 4月始まり',fyRange(2026,4),['2026-04-01','2027-03-31']);
eq('1 fyRange 既定(設定)=4月',fyRange(2026),['2026-04-01','2027-03-31']);
eq('1 fyRange 1月始まり',fyRange(2026,1),['2026-01-01','2026-12-31']);
eq('1 fyRange 3月始まり(うるう年を跨ぐ)',fyRange(2027,3),['2027-03-01','2028-02-29']);
eq('1 fyRange 10月始まり',fyRange(2026,10),['2026-10-01','2027-09-30']);
eq('1 fyOf 年度末日',fyOf('2027-03-31',4),2026);
eq('1 fyOf 年度初日',fyOf('2027-04-01',4),2027);
eq('1 fyOf 4月始まり 1月',fyOf('2026-01-01',4),2025);
eq('1 fyOf 1月始まり 1/1',fyOf('2026-01-01',1),2026);
eq('1 fyOf 1月始まり 12/31',fyOf('2026-12-31',1),2026);
eq('1 fyOf 既定(設定)',fyOf('2026-03-31'),2025);
{
  const now=new Date(),td=`${now.getFullYear()}-${pad2(now.getMonth()+1)}-${pad2(now.getDate())}`;
  currentPeriod='fiscal';
  eq('1 今年度の集計期間: 4月始まり',getPeriodRange(),fyRange(fyOf(td,4),4));
  settings.fyStartMonth=1;
  eq('1 今年度の集計期間: 1月始まりに従う',getPeriodRange(),[`${now.getFullYear()}-01-01`,`${now.getFullYear()}-12-31`]);
  settings.fyStartMonth=10;
  eq('1 今年度の集計期間: 10月始まりに従う',getPeriodRange(),fyRange(fyOf(td,10),10));
  settings.fyStartMonth=4;
}
// 設定を変えると fyRange の既定も変わる
settings.fyStartMonth=1;eq('1 設定1月で fyRange(2026)',fyRange(2026),['2026-01-01','2026-12-31']);settings.fyStartMonth=4;

// ================= 2. computeFiscalReport =================
{
  const d=dataset('未設定');
  const r=computeFiscalReport(Y,fdata(d,{openingByFy:{[Y]:50000}}));
  eq('2 期間',[r.from,r.to],['2020-04-01','2021-03-31']);
  eq('2 収入の部: カテゴリ別・金額の大きい順・未分類',r.income.items.map(i=>[i.category,i.amount]),[['部費',22000],['助成金',20000],['未分類',3000]]);
  eq('2 収入合計',r.income.total,45000);
  eq('2 支出の部: 立替を含める・未払いは含めない',r.payment.items.map(i=>[i.category,i.amount]),[['交通費',6000],['備品',4000]]);
  eq('2 支出合計',r.payment.total,10000);
  eq('2 前年度の取引・年度末より後の取引は入らない',[r.income.items.find(i=>i.category==='部費').count,r.payment.items.find(i=>i.category==='備品').count],[3,1]);
  eq('2 手入力の繰越',[r.opening,r.openingFrom],[50000,'manual']);
  eq('2 次年度繰越金',r.closing,85000);
  eq('2 注記: 未収入金・未払金',r.pending,{income:{count:1,total:1000},payment:{count:1,total:2000}});
  eq('2 注記: 口座未設定',[r.unassigned.count,r.unassigned.income,r.unassigned.payment,r.unassigned.total],[1,7000,0,7000]);
  const c=r.reconcile;
  eq('2 照合: 今の現金＋通帳',[c.cashNow,c.bankNow,c.actualNow],[36200,50000,86200]);
  eq('2 照合: 年度末より後の効果(入金9000−支払800−精算6000)',c.after,2200);
  eq('2 照合: 年度末の推定(現金/預金/合計)',[c.cashAtEnd,c.bankAtEnd,c.actualAtEnd],[34000,50000,84000]);
  eq('2 照合: 未精算の立替(精算日が年度末より後)',c.unsettledAtEnd,6000);
  eq('2 照合: 差額(口座未設定の入金7000が照合に入らない)',c.diff,-7000);
  const d2=dataset('通帳');
  const r2=computeFiscalReport(Y,fdata(d2,{openingByFy:{[Y]:50000}}));
  eq('2 差額0のケース',[r2.reconcile.actualAtEnd,r2.reconcile.unsettledAtEnd,r2.closing,r2.reconcile.diff],[91000,6000,85000,0]);
  eq('2 口座未設定が無ければ注記なし',r2.unassigned.count,0);
  // 精算日が年度内なら未精算ではない
  const d3=dataset('通帳');d3.settlements[0].date=D(Y,12,1);
  const r3=computeFiscalReport(Y,fdata(d3,{openingByFy:{[Y]:50000}}));
  eq('2 年度内に精算済みなら未精算0・after に精算を含めない',[r3.reconcile.unsettledAtEnd,r3.reconcile.after],[0,9000-800]);
  // 精算が無い立替は未精算
  const d4=dataset('通帳');d4.settlements=[];d4.transactions.find(t=>t.settlementId).settlementId=undefined;
  eq('2 精算の無い立替は未精算',computeFiscalReport(Y,fdata(d4,{openingByFy:{[Y]:50000}})).reconcile.unsettledAtEnd,6000);
  // 前年度が締め済み → 自動で繰越（手入力より優先）
  const r5=computeFiscalReport(Y,fdata(d2,{fiscalYears:[closedRec(Y-1,30000)],openingByFy:{[Y]:50000}}));
  eq('2 前年度締め済みからの繰越(手入力より優先)',[r5.opening,r5.openingFrom,r5.closing],[30000,'prev',65000]);
  // 繰越が無い → null
  const r6=computeFiscalReport(Y,fdata(d2));
  eq('2 繰越なし: opening/closing/diff が null',[r6.opening,r6.openingFrom,r6.closing,r6.reconcile.diff],[null,null,null,null]);
  eq('2 繰越なしでも収入支出は出る',[r6.income.total,r6.payment.total],[45000,10000]);
  // グローバルの settings.openingByFy も読む
  settings.openingByFy={[Y]:1};eq('2 settings.openingByFy を既定で読む',computeFiscalReport(Y,fdata(d2)).opening,1);settings.openingByFy={};
  // 0 円の手入力は有効（未入力と区別）
  eq('2 手入力0は有効',computeFiscalReport(Y,fdata(d2,{openingByFy:{[Y]:0}})).opening,0);
  // 締め済みは記録をそのまま返す
  const rec=closedRec(Y,12345);
  ok('2 締め済みは記録をそのまま返す',computeFiscalReport(Y,fdata(d2,{fiscalYears:[rec]}))===rec,'not same');
  // 1月始まりを data で指定
  eq('2 data.fyStartMonth=1',computeFiscalReport(2020,fdata(d2,{fyStartMonth:1})).from,'2020-01-01');
  // 逆算の参考値
  const hint=openingHint(Y,fdata(d2));
  eq('2 参考値 = 今残高 −年度内の現金/通帳の入金 +年度内の支払い +年度内の精算',hint,93200-(10000+5000+3000+20000+7000-4000));
  const d7=dataset('通帳');d7.settlements[0].date=D(Y,12,1);
  eq('2 参考値: 年度内の精算額を足し戻す',openingHint(Y,fdata(d7)),93200-(10000+5000+3000+20000+7000-4000)+6000);
}

// ================= 3. 締める・取消し・confirm =================
{
  const d=dataset('通帳');
  setup({...d});
  closeFiscalYear(Y);
  ok('3 繰越が無いと締められない',fiscalYears.length===0&&toasts.some(t=>t.includes('前年度繰越金')),toasts.join());
  setOpening(Y,'50000');
  eq('3 手入力は settings.openingByFy に保存（fiscalYears ではない）',[settings.openingByFy[Y],fiscalYears.length],[50000,0]);
  has('3 繰越の変更を記録',auditLog[0].detail,'¥50,000');
  closeFiscalYear(Y);
  eq('3 差額0・過去年度は確認なしで締まる',[fiscalYears.length,confirms.length],[1,0]);
  const f=fiscalYears[0];
  eq('3 記録の項目',Object.keys(f).sort(),['closedAt','closedBy','closing','fy','from','id','income','opening','payment','pending','reconcile','to','unassigned'].sort());
  eq('3 記録の値',[f.id,f.fy,f.from,f.to,f.opening,f.closing,f.closedBy],['fy2020',2020,'2020-04-01','2021-03-31',50000,85000,'テスト端末']);
  ok('3 closedAt は ISO',!isNaN(Date.parse(f.closedAt)),f.closedAt);
  eq('3 ログ「年度締め」',acts()[0],'年度締め');
  ok('3 保存データに入る',buildPayload().fiscalYears.length===1,'');
  // 締め後に取引が変わっても決算は動かない
  transactions.push(T(D(Y,6,6),'income',99999,{category:'部費'}));
  eq('3 締め済みは記録を返す(取引が増えても不変)',computeFiscalReport(Y,fiscalData()).closing,85000);
  // 締め済みの間は開始月を変更できない
  toasts=[];setFyStart(1);
  ok('3 締め済みの間は開始月を変えられない(トースト・不変)',settings.fyStartMonth===4&&toasts.some(t=>t.includes('開始月')),toasts.join());
  ok('3 開始月のセレクトが無効',document.getElementById('fyStart').disabled,'');
  setOpening(Y,'1');eq('3 締め済み年度の繰越は変更できない',settings.openingByFy[Y],50000);
  closeFiscalYear(Y);eq('3 二重に締めない',fiscalYears.length,1);
  // 取消し
  confirms=[];confirmAns=false;unCloseFiscalYear(Y);
  eq('3 取消しをキャンセル→そのまま',fiscalYears.length,1);
  confirmAns=true;unCloseFiscalYear(Y);
  eq('3 締めの取消し',fiscalYears.length,0);
  eq('3 ログ「年度締めの取消し」',acts()[0],'年度締めの取消し');
  ok('3 取消し後は再計算(増えた取引が反映)',computeFiscalReport(Y,fiscalData()).income.total===45000+99999,'');
  setFyStart(1);eq('3 締め年度が無ければ開始月を変えられる',settings.fyStartMonth,1);
  eq('3 ログ「年度開始月変更」',[acts()[0],auditLog[0].detail],['年度開始月変更','4月→1月']);
  setFyStart(4);
}
{
  // 差額がある時の confirm
  const d=dataset('未設定');
  setup({...d,settings:{openingByFy:{[Y]:50000}}});
  confirmAns=false;closeFiscalYear(Y);
  eq('3 差額あり: キャンセルで締めない',fiscalYears.length,0);
  has('3 差額の confirm 文言',confirms[0],'残高照合に差額（-¥7,000）があります。このまま締めますか？');
  confirmAns=true;closeFiscalYear(Y);
  eq('3 差額あり: OKで締まる',fiscalYears.length,1);
  eq('3 差額が記録に残る',fiscalYears[0].reconcile.diff,-7000);
}
{
  // 年度の途中
  const cur=fyOf(todayStr());
  setup({settings:{openingByFy:{[cur]:0}}});
  confirmAns=false;closeFiscalYear(cur);
  eq('3 年度の途中: キャンセルで締めない',[fiscalYears.length,confirms[0]],[0,'年度の途中ですが締めますか？']);
  confirmAns=true;closeFiscalYear(cur);
  eq('3 年度の途中: OKで締まる',fiscalYears.length,1);
}
{
  // 画面
  setup({...dataset('通帳')});
  fiscalSel=Y;renderFiscal();
  ok('3 繰越未入力: 締めるボタンは無効＋理由',document.querySelector('#fiscalBody button[onclick^="closeFiscalYear"]').disabled&&text('fiscalBody').includes('前年度繰越金を入力すると'),text('fiscalBody').slice(0,200));
  ok('3 繰越の入力欄',!!document.getElementById('fyOpening'),'');
  has('3 画面: 収入の部/支出の部/残高照合',text('fiscalBody'),'収入の部');has('3 画面: 支出の部',text('fiscalBody'),'支出の部');has('3 画面: 残高照合',text('fiscalBody'),'残高照合');
  has('3 画面: 年度のラベルと期間',text('fiscalBody'),'2020年4月1日〜2021年3月31日');
  setOpening(Y,'50000');fiscalSel=Y;renderFiscal();
  ok('3 繰越入力後は締められる',!document.querySelector('#fiscalBody button[onclick^="closeFiscalYear"]').disabled,'');
  has('3 画面: 注記(未収入金)',text('fiscalBody'),'未収入金 1件 ¥1,000');has('3 画面: 注記(未払金)',text('fiscalBody'),'未払金 1件 ¥2,000');
  ok('3 画面: 差額0は一致と出す',text('fiscalBody').includes('一致'),'');
  setOpening(Y,'');ok('3 空欄で繰越を未入力へ戻せる',!(Y in settings.openingByFy),JSON.stringify(settings.openingByFy));
  toasts=[];setOpening(Y,'12.5');ok('3 小数は受け付けない',!(Y in settings.openingByFy)&&toasts.length>0,'');
  // 前年度締め済みは自動・編集不可
  fiscalYears=[closedRec(Y-1,777)];fiscalSel=Y;renderFiscal();
  ok('3 前年度が締め済みなら繰越は自動(入力欄なし)',!document.getElementById('fyOpening')&&text('fiscalBody').includes('¥777'),text('fiscalBody').slice(0,300));
  // 現在年度の参考値ボタン
  const cur=fyOf(todayStr());fiscalYears=[];fiscalSel=cur;renderFiscal();
  ok('3 今の年度なら参考値と「入力欄に入れる」',text('fiscalBody').includes('今の残高から逆算した参考値'),'');
  fiscalSel=Y;renderFiscal();ok('3 過去の年度には参考値を出さない',!text('fiscalBody').includes('今の残高から逆算した参考値'),'');
  // 参考値ボタンで入る
  fiscalSel=cur;renderFiscal();
  const btn=[...document.querySelectorAll('#fiscalBody button')].find(b=>b.textContent.includes('入力欄に入れる'));btn.click();
  ok('3 参考値を入れられる',cur in settings.openingByFy,JSON.stringify(settings.openingByFy));
  // 年度の選択肢: 最も古い取引の年度〜今の年度
  const opts=[...document.querySelectorAll('#fyPick option')].map(o=>+o.value);
  eq('3 年度の選択肢(新しい順・最古〜今)',[opts[0],opts[opts.length-1]],[cur,Y-1]);
  // 団体名
  {const before=auditLog.length;setOrgName('  帯広部  ');eq('3 団体名を保存(前後空白除去)',settings.orgName,'帯広部');eq('3 ログ「団体名変更」',acts()[0],'団体名変更');setOrgName('帯広部');eq('3 同じ値は記録しない',auditLog.length,before+1);}
  // XSS
  setOrgName('<img src=x onerror=1>');fiscalSel=Y;renderFiscal();
  ok('3 団体名はエスケープされる',!document.querySelector('#fiscalBody img')&&document.getElementById('fyOrg').value==='<img src=x onerror=1>','');
}

// ================= 4. 締め済み年度の取引の保護 =================
const CLOSED_MSG=y=>`締め済みの年度（${y}年度）の取引です。変更すると決算報告書と合わなくなります。続けますか？`;
{
  const a=T(D(2020,6,1),'payment',1000,{account:'未設定',summary:'AA'}),b=T(D(2021,5,1),'payment',500,{account:'未設定',summary:'BB'}),c=T(D(2020,7,1),'payment',300,{account:'未設定',summary:'CC',status:'pending'});
  setup({transactions:[a,b,c],fiscalYears:[closedRec(2020)]});
  // 追加
  openAdd({date:D(2020,8,1),summary:'追加甲'});confirmAns=false;saveTx();
  eq('4 追加: キャンセルなら何も変わらない',[transactions.length,confirms.length,confirms[0]],[3,1,CLOSED_MSG(2020)]);
  ok('4 追加: キャンセル時はモーダルが開いたまま',document.getElementById('modalOverlay').classList.contains('open'),'');
  eq('4 追加: キャンセル時は保存もログもしない',[pcalls.length,auditLog.length],[0,0]);
  confirmAns=true;saveTx();
  eq('4 追加: 続けたら追加される',transactions.length,4);
  ok('4 追加: ログ「締め済み年度の変更」',acts().includes('締め済み年度の変更')&&auditLog.find(x=>x.action==='締め済み年度の変更').detail.includes('2020年度'),acts().join());
  ok('4 追加: ログは保存より前',pcalls[0].includes('締め済み年度の変更')&&pcalls[0].includes('取引追加'),JSON.stringify(pcalls));
  // 開いている年度は確認なし
  confirms=[];openAdd({date:D(2021,8,1),summary:'追加乙'});saveTx();
  eq('4 追加: 開いている年度は確認なし',[transactions.length,confirms.length],[5,0]);
  // 編集
  confirms=[];confirmAns=false;openModal(a.id);document.getElementById('formSummary').value='AA変更';saveTx();
  eq('4 編集: キャンセルなら不変',[find(a.id).summary,confirms.length],['AA',1]);
  confirmAns=true;saveTx();
  eq('4 編集: 続けたら変わる',find(a.id).summary,'AA変更');
  // 日付を締め済みへ移す
  confirms=[];confirmAns=false;openModal(b.id);document.getElementById('formDate').value=D(2020,9,9);saveTx();
  eq('4 日付移動(開→締め済み): キャンセルなら不変',[find(b.id).date,confirms.length,confirms[0]],[D(2021,5,1),1,CLOSED_MSG(2020)]);
  confirmAns=true;saveTx();eq('4 日付移動(開→締め済み): 続けたら移る',find(b.id).date,D(2020,9,9));
  // 締め済みから外へ
  confirms=[];confirmAns=false;openModal(b.id);document.getElementById('formDate').value=D(2021,9,9);saveTx();
  eq('4 日付移動(締め済み→開): キャンセルなら不変',[find(b.id).date,confirms.length],[D(2020,9,9),1]);
  confirmAns=true;saveTx();eq('4 日付移動(締め済み→開): 続けたら移る',find(b.id).date,D(2021,9,9));
  closeModal();
  // 削除
  confirms=[];confirmAns=m=>!m.startsWith('締め済み');deleteTx(a.id);
  eq('4 削除: 削除確認のあと締め済み確認、キャンセルなら残る',[confirms.length,!!find(a.id),confirms[1]],[2,true,CLOSED_MSG(2020)]);
  confirms=[];confirmAns=true;deleteTx(a.id);
  eq('4 削除: 続けたら消える',[!!find(a.id),confirms.length],[false,2]);
  ok('4 削除: ログ「締め済み年度の変更」',auditLog[0].action==='締め済み年度の変更'||acts().slice(0,3).includes('締め済み年度の変更'),acts().slice(0,4).join());
  // 状態の切り替え
  confirms=[];confirmAns=false;toggleTxStatus(c.id);
  eq('4 状態切替: キャンセルなら不変',[find(c.id).status,confirms.length,confirms[0]],['pending',1,CLOSED_MSG(2020)]);
  confirmAns=true;toggleTxStatus(c.id);
  eq('4 状態切替: 続けたら切り替わる',find(c.id).status,'done');
  // 開いている年度の切替・削除は確認が増えない
  const e=T(D(2022,1,1),'payment',100,{account:'未設定',status:'pending'});transactions.push(e);confirms=[];toggleTxStatus(e.id);
  eq('4 開いている年度の切替は確認なし',[find(e.id).status,confirms.length],['done',0]);
  // ログの順序: すべて persist より前（pcalls は persist 呼び出し時点の先頭3件）
  ok('4 状態切替のログも保存より前',pcalls.some(p=>p[0]==='締め済み年度の変更')&&pcalls.some(p=>p.includes('ステータス変更')),JSON.stringify(pcalls.slice(-4)));
  // 複数の締め済み年度を跨ぐ場合は両方を表示
  fiscalYears=[closedRec(2020),closedRec(2021)];confirms=[];confirmAns=false;
  const g=guardClosed([D(2020,6,1),D(2021,6,1)]);
  ok('4 guardClosed: 複数年度',g===null&&confirms[0].includes('2020年度・2021年度'),confirms[0]);
  eq('4 guardClosed: 無関係なら[]',guardClosed([D(2030,1,1),undefined,'']),[]);
}
{
  // 集金記録の自動取引
  setup({fiscalYears:[closedRec(fyOf(todayStr()))],collections:[{_type:'members',list:['甲']},{id:'p1',name:'合宿',amount:500,paid:[],createdAt:'x'}]});
  confirms=[];confirmAns=m=>!m.startsWith('締め済み');togglePaid(0,'甲');
  ok('4 集金記録: 締め済み年度ならキャンセルで取引を作らない',transactions.length===0&&confirms.length===2,confirms.join('|'));
}

// ================= 5. 印刷 =================
{
  setup({...dataset('通帳'),settings:{orgName:'帯広大馬術部',openingByFy:{[Y]:50000}}});
  fiscalSel=Y;printed=0;
  printFiscalReport(Y);
  const pr=document.getElementById('printReport'),t=pr.textContent;
  eq('5 window.print が呼ばれる',printed,1);
  ok('5 printing-report が付く',document.body.classList.contains('printing-report'),'');
  has('5 見出し(未締めは未確定)',t,'帯広大馬術部 2020年度 会計報告書（未確定）');
  has('5 期間',t,'2020年4月1日〜2021年3月31日');
  for(const s of['収入の部','支出の部','科目','前年度繰越金','収入合計','支出合計','次年度繰越金','次年度繰越金の内訳','現金','預金','未精算の立替金（マイナス）','注記','未収入金 1件 ¥1,000','未払金 1件 ¥2,000','上記のとおり報告いたします。','作成日','会計 ＿','印','上記の会計を監査した結果、適正であることを認めます。','会計監査 ＿','¥22,000','¥45,000','¥85,000','¥50,000'])has('5 内容: '+s,t,s);
  ok('5 内訳の現金・預金・立替',t.includes('¥34,000')&&t.includes('¥57,000')&&t.includes('-¥6,000'),t);
  eq('5 画面では #printReport は非表示',getComputedStyle(pr).display,'none');
  const printRules=[...document.styleSheets].flatMap(s=>{try{return[...s.cssRules];}catch{return[];}}).filter(r=>r.media&&r.media.mediaText.includes('print')).map(r=>r.cssText).join('\n');
  has('5 印刷CSS: printing-report 以外を隠す',printRules,'body.printing-report > :not(#printReport) { display: none !important; }');
  has('5 印刷CSS: A4縦',printRules,'size: a4;');
  has('5 印刷CSS: printing-report の時だけ #printReport を表示',printRules,'body.printing-report #printReport');
  window.dispatchEvent(new Event('afterprint'));
  ok('5 afterprint で printing-report が外れる',!document.body.classList.contains('printing-report'),'');
  // 既存の「印刷」ボタン（画面全体）は影響を受けない
  const pb=[...document.querySelectorAll('.export-row button')].find(b=>b.getAttribute('onclick')==='window.print()');
  printed=0;pb.click();ok('5 既存の印刷ボタンはそのまま(クラスを付けない)',printed===1&&!document.body.classList.contains('printing-report'),'');
  // 締め済み
  fiscalYears=[closedRec(Y,85000,{opening:50000})];printFiscalReport(Y);
  ok('5 締め済みは(未確定)が付かない',!document.getElementById('printReport').textContent.includes('未確定'),document.getElementById('printReport').textContent.slice(0,80));
  window.dispatchEvent(new Event('afterprint'));
  // 繰越なし・団体名なし・XSS
  setup({...dataset('通帳')});fiscalSel=Y;printFiscalReport(Y);
  const t2=document.getElementById('printReport').textContent;
  ok('5 団体名なしでも見出しが出る・繰越なしは—',t2.startsWith('2020年度 会計報告書（未確定）')&&t2.includes('—'),t2.slice(0,120));
  window.dispatchEvent(new Event('afterprint'));
  setup({...dataset('通帳'),settings:{orgName:'<img src=x onerror=1>',openingByFy:{[Y]:1}}});printFiscalReport(Y);
  ok('5 団体名はエスケープ',!document.querySelector('#printReport img')&&document.getElementById('printReport').textContent.includes('<img src=x onerror=1>'),'');
  window.dispatchEvent(new Event('afterprint'));
  // 差額がある時は内訳に出す
  setup({...dataset('未設定'),settings:{orgName:'',openingByFy:{[Y]:50000}}});printFiscalReport(Y);
  has('5 差額あり: 内訳に「差額（要確認）」',document.getElementById('printReport').textContent,'差額（要確認）');
  window.dispatchEvent(new Event('afterprint'));
  // print が例外でもクラスを残さない
  const op=window.print;window.print=()=>{throw new Error('x');};printFiscalReport(Y);ok('5 print 例外でもクラスが残らない',!document.body.classList.contains('printing-report'),'');window.print=op;
}

// ================= 6. 立替 =================
{
  setup({counts:{1000:5,5000:1},bankBalance:20000});
  // モーダルの表示
  openModal();setType('income');ok('6 入金では「立替」を出さない',document.getElementById('accAdv').style.display==='none','');
  setType('payment');ok('6 支払いでは「立替」を出す',document.getElementById('accAdv').style.display==='','');
  setAccount('立替');ok('6 立替を選ぶと「立て替えた人」欄が出て状態が隠れる',document.getElementById('advGroup').style.display===''&&document.getElementById('statusGroup').style.display==='none'&&modalStatus==='done','');
  setType('income');eq('6 入金へ切り替えると現金に戻る',modalAccount,'現金');ok('6 入金へ戻すと状態欄が戻る',document.getElementById('statusGroup').style.display==='','');
  closeModal();
  // 必須チェック
  openAdd({type:'payment',account:'立替',amount:'5000',summary:'交通費',paidBy:''});saveTx();
  ok('6 立て替えた人が空なら保存しない',transactions.length===0&&toasts.some(t=>t.includes('立て替えた人')),toasts.join());
  document.getElementById('formPaidBy').value='  A  ';saveTx();
  eq('6 立替の保存: 取引',transactions.length,1);
  const x=transactions[0];
  eq('6 立替の保存: 項目',[x.account,x.paidBy,x.status,x.applied,x.cashBreakdown,x.type],['立替','A','done',true,null,'payment']);
  ok('6 立替の保存: settlementId は持たない',!('settlementId' in x),'');
  eq('6 現金・通帳が動かない',[calcTotal(),bankBalance,confirms.length],[10000,20000,0]);
  closeModal();
  // 状態が pending のまま立替を保存しても done
  openAdd({type:'payment',account:'立替',amount:'3000',summary:'飲み物',paidBy:'A',status:'pending'});saveTx();
  ok('6 立替は状態が pending でも done に固定',transactions[0].status==='done'&&transactions[0].applied===true,JSON.stringify(transactions[0]));
  openAdd({type:'payment',account:'立替',amount:'500',summary:'コピー代',paidBy:'B',event:'春合宿'});saveTx();
  const [t3,t2,t1]=transactions;
  // 状態は切り替えられない
  toasts=[];toggleTxStatus(t1.id);
  ok('6 状態切替不可(トースト)',find(t1.id).status==='done'&&find(t1.id).applied===true&&toasts.includes('立替の取引は精算で処理します'),toasts.join());
  eq('6 状態切替でも現金・通帳は動かない',[calcTotal(),bankBalance],[10000,20000]);
  ok('6 一覧に状態ボタンを出さない',![...document.querySelectorAll('#txList .tx-item')].some(i=>i.textContent.includes('立替: ')&&i.querySelector('.tx-status-btn')),'');
  has('6 一覧バッジ: 未精算',text('txList'),'立替: A・未精算');
  // カード
  const card=document.getElementById('advCard');
  ok('6 未精算カードが出る',card.style.display!=='none','');
  has('6 カード: A 2件 ¥8,000',text('advList').replace(/\s/g,''),'A2件¥8,000');has('6 カード: B',text('advList').replace(/\s/g,''),'B1件¥500');
  // 精算ダイアログ
  openSettle('A');
  ok('6 精算ダイアログ: 全部オン・合計',document.querySelectorAll('#settleList .settle-chk').length===2&&[...document.querySelectorAll('#settleList .settle-chk')].every(c=>c.checked)&&text('settleTotal').includes('¥8,000'),text('settleTotal'));
  eq('6 精算日の既定は今日',document.getElementById('settleDate').value,todayStr());
  const chk=document.querySelector(`#settleList .settle-chk[value="${t1.id}"]`);chk.checked=false;chk.onchange();
  has('6 チェックを外すと合計が変わる',text('settleTotal'),'¥3,000');
  chk.checked=true;chk.onchange();
  // 現金で精算（金種を confirm で見せる）
  confirms=[];doSettle();
  has('6 現金精算: 金種を confirm',confirms[0],'五千円×1');has('6 現金精算: 金種(千円)',confirms[0],'千円×3');
  eq('6 現金精算: 枚数を引く',[counts[5000],counts[1000]],[0,2]);
  eq('6 現金精算: 通帳は動かない',bankBalance,20000);
  eq('6 settlements に記録',settlements.length,1);
  const s1=settlements[0];
  eq('6 記録の項目',Object.keys(s1).sort(),['account','amount','cashBreakdown','createdAt','date','id','member','txIds'].sort());
  eq('6 記録の値',[s1.member,s1.account,s1.amount,s1.date,s1.cashBreakdown],['A','現金',8000,todayStr(),{5000:1,1000:3}]);
  eq('6 txIds',[...s1.txIds].sort(),[t1.id,t2.id].sort());
  eq('6 取引に settlementId',[find(t1.id).settlementId,find(t2.id).settlementId,find(t3.id).settlementId],[s1.id,s1.id,undefined]);
  eq('6 ログ「立替精算」',[acts()[0],auditLog[0].detail],['立替精算','A ¥8,000']);
  ok('6 ログは保存より前',pcalls.at(-1)[0]==='立替精算',JSON.stringify(pcalls.at(-1)));
  ok('6 ダイアログが閉じる',!document.getElementById('settleDialog').classList.contains('open'),'');
  has('6 バッジ: 精算済 月/日',text('txList'),`立替: A・精算済 ${+todayStr().slice(5,7)}/${+todayStr().slice(8,10)}`);
  ok('6 精算したAはカードから消える',!text('advList').includes('A'),text('advList'));
  ok('6 精算の履歴が出る',document.getElementById('settleHistCard').style.display!=='none'&&text('settleHistList').includes('¥8,000'),text('settleHistList'));
  // 支出に二重計上しない: 支出の合計は立て替えた時点のまま
  eq('6 精算は支出に入らない(支出済み合計は立替の合計のまま)',document.getElementById('sum-payment-done').textContent,'¥8,500');
  // 精算後の保護
  toasts=[];confirms=[];openModal(t1.id);document.getElementById('formAmount').value='5001';saveTx();
  ok('6 精算済み: 金額は変えられない',find(t1.id).amount===5000&&toasts.includes(SETTLED_MSG),toasts.join());
  openModal(t1.id);document.getElementById('formAmount').value='5000';setAccount('現金');toasts=[];saveTx();
  ok('6 精算済み: 口座は変えられない',find(t1.id).account==='立替'&&toasts.includes(SETTLED_MSG),toasts.join());
  openModal(t1.id);document.getElementById('formPaidBy').value='C';toasts=[];saveTx();
  ok('6 精算済み: 立てた人は変えられない',find(t1.id).paidBy==='A'&&toasts.includes(SETTLED_MSG),toasts.join());
  toasts=[];confirms=[];deleteTx(t1.id);
  ok('6 精算済み: 削除できない(確認も出さない)',!!find(t1.id)&&toasts.includes(SETTLED_MSG)&&confirms.length===0,toasts.join());
  openModal(t1.id);document.getElementById('formSummary').value='交通費(修正)';document.getElementById('formEvent').value='  夏合宿 ';document.getElementById('formDate').value='2020-02-02';toasts=[];saveTx();
  ok('6 精算済み: 摘要・日付・イベントは変えられる／精算の印は残る',find(t1.id).summary==='交通費(修正)'&&find(t1.id).event==='夏合宿'&&find(t1.id).date==='2020-02-02'&&find(t1.id).settlementId===s1.id&&find(t1.id).paidBy==='A',JSON.stringify(find(t1.id)));
  // 現金不足
  toasts=[];confirms=[];openSettle('B');
  doSettle();
  ok('6 現金不足: トーストのみ・何も変えない',toasts.some(t=>t.includes('現金残高が不足'))&&settlements.length===1&&!find(t3.id).settlementId&&confirms.length===0&&counts[1000]===2,toasts.join());
  // 通帳で精算
  toasts=[];confirms=[];openSettle('B');document.getElementById('settleAccount').value='通帳';doSettle();
  eq('6 通帳精算: 残高を引く',bankBalance,19500);
  eq('6 通帳精算: 記録',[settlements[0].account,settlements[0].amount,settlements[0].cashBreakdown,settlements[0].member],['通帳',500,null,'B']);
  eq('6 通帳精算: 現金は動かない・confirm なし',[counts[1000],confirms.length],[2,0]);
  ok('6 全員精算済みで未精算カードが消える',document.getElementById('advCard').style.display==='none','');
  ok('6 未精算が無くても履歴は見られる',document.getElementById('settleHistCard').style.display!=='none','');
  // 通帳不足
  setup({counts:{1000:5},bankBalance:100});
  openAdd({type:'payment',account:'立替',amount:'500',summary:'a',paidBy:'B'});saveTx();
  toasts=[];openSettle('B');document.getElementById('settleAccount').value='通帳';doSettle();
  ok('6 通帳不足: トーストのみ',toasts.some(t=>t.includes('通帳残高が不足'))&&bankBalance===100&&settlements.length===0,toasts.join());
  toasts=[];openSettle('B');document.getElementById('settleList').querySelector('.settle-chk').checked=false;doSettle();
  ok('6 何も選ばないと精算しない',toasts.some(t=>t.includes('精算する取引を選んで'))&&settlements.length===0,toasts.join());
  closeSettle();
  // 取消し
  setup({counts:{1000:5,5000:1},bankBalance:20000});
  openAdd({type:'payment',account:'立替',amount:'5000',summary:'p1',paidBy:'A'});saveTx();
  openAdd({type:'payment',account:'立替',amount:'3000',summary:'p2',paidBy:'A'});saveTx();
  openAdd({type:'payment',account:'立替',amount:'700',summary:'p3',paidBy:'B'});saveTx();
  openSettle('A');doSettle();
  const sA=settlements[0];
  openSettle('B');document.getElementById('settleAccount').value='通帳';doSettle();
  const sB=settlements.find(x=>x.member==='B');
  eq('6 取消し前の状態',[counts[5000],counts[1000],bankBalance],[0,2,19300]);
  confirms=[];confirmAns=false;cancelSettlement(sA.id);
  ok('6 取消しをキャンセル→何も変わらない',settlements.length===2&&counts[5000]===0,'');
  confirmAns=true;cancelSettlement(sA.id);
  eq('6 現金精算の取消し: 内訳を戻す',[counts[5000],counts[1000]],[1,5]);
  eq('6 取消し: 記録が消え settlementId が外れる',[settlements.length,transactions.filter(t=>t.settlementId===sA.id).length,transactions.filter(t=>t.paidBy==='A'&&!t.settlementId).length],[1,0,2]);
  eq('6 取消し: ログ',[acts()[0],auditLog[0].detail],['立替精算の取消し','A ¥8,000']);
  ok('6 取消し: ログは保存より前',pcalls.at(-1)[0]==='立替精算の取消し',JSON.stringify(pcalls.at(-1)));
  has('6 取消し: バッジが未精算に戻る',text('txList'),'立替: A・未精算');
  ok('6 取消し: Aがカードに戻る',text('advList').replace(/\s/g,'').includes('A2件¥8,000'),text('advList'));
  cancelSettlement(sB.id);
  eq('6 通帳精算の取消し: 足し戻す',bankBalance,20000);
  eq('6 すべて取消し',settlements.length,0);
  ok('6 取消し後は金額・削除が再び可能',(()=>{const t=transactions.find(t=>t.summary==='p1');confirms=[];confirmAns=true;deleteTx(t.id);return !find(t.id);})(),'');
  // 検索の口座に立替
  ok('6 検索の口座に「立替」',[...document.querySelectorAll('#srchAccount option')].some(o=>o.value==='立替'),'');
  document.getElementById('srchAccount').value='立替';applySearch();
  eq('6 口座=立替で絞り込み',document.querySelectorAll('#txList .tx-item').length,2);
  clearSearch();
}

// ================= 7. イベント =================
{
  setup();
  openAdd({type:'income',account:'未設定',summary:'e1',event:'  春合宿  ',date:D(2020,5,1)});saveTx();
  eq('7 イベントは前後の空白を除いて保存',transactions[0].event,'春合宿');
  openAdd({type:'income',account:'未設定',summary:'e2',event:'   ',date:D(2020,5,2)});saveTx();
  ok('7 空なら event を付けない',!('event' in transactions[0]),JSON.stringify(transactions[0]));
  // 編集でイベントを消す
  const e1id=transactions.find(t=>t.summary==='e1').id;
  openModal(e1id);eq('7 編集画面にイベントが入る',document.getElementById('formEvent').value,'春合宿');document.getElementById('formEvent').value='';saveTx();
  ok('7 編集でイベントを空にすると外れる',!('event' in find(e1id)),JSON.stringify(find(e1id)));
}
{
  const e=(date,type,amount,event,o={})=>T(date,type,amount,{event,account:'未設定',...o});
  setup({transactions:[
    e(D(2020,5,1),'income',10000,'春合宿'),e(D(2020,5,3),'payment',3000,'春合宿'),e(D(2020,6,15),'payment',500,'春合宿',{status:'pending'}),
    e(D(2020,8,10),'payment',7000,'夏祭り'),e(D(2020,8,12),'income',2000,'夏祭り'),
    e(D(2020,3,1),'payment',900,'新歓'),
    T(D(2020,9,9),'payment',100,{account:'未設定'}),
  ]});
  currentPeriod='all';renderReport();
  ok('7 カードが出る',document.getElementById('eventCard').style.display!=='none','');
  const rows=[...document.querySelectorAll('#eventBody .ev-row')];
  eq('7 並びは最後の取引日の新しい順(夏祭り 8/12 → 春合宿 6/15 → 新歓 3/1)',rows.map(r=>r.querySelector('b').textContent),['夏祭り','春合宿','新歓']);
  const t0=rows[1].textContent.replace(/\s/g,'');
  has('7 収入',t0,'収入¥10,000');has('7 支出(済みのみ)',t0,'支出¥3,000');has('7 差額',t0,'差額¥7,000');has('7 件数と未処理',t0,'2件（未処理1件）');
  has('7 夏祭りの差額はマイナス',rows[0].textContent.replace(/\s/g,''),'差額-¥5,000');
  ok('7 並びは差額順ではない',rows[0].textContent.includes('-¥5,000'),'');
  // 行クリックで絞り込み
  rows[1].click();
  ok('7 行クリックで取引タブへ',document.getElementById('tab-bank').classList.contains('active'),'');
  eq('7 検索の「イベント」が設定される',document.getElementById('srchEvent').value,'春合宿');
  ok('7 検索パネルが開く',document.getElementById('searchPanel').classList.contains('open'),'');
  const items=[...document.querySelectorAll('#txList .tx-item')];
  ok('7 春合宿の3件だけ表示・タグ付き',items.length===3&&items.every(i=>i.textContent.includes('春合宿')),items.map(i=>i.textContent.slice(0,40)).join('|'));
  ok('7 一覧のイベントタグ',!!document.querySelector('#txList .tx-event'),'');
  // 他の絞り込みはクリアされる
  document.getElementById('srchText').value='zzz';clearSearch();
  eq('7 クリアでイベントも空に',document.getElementById('srchEvent').value,'');
  // 候補（新しい順）
  openModal();
  eq('7 datalist の候補(新しい順)',[...document.querySelectorAll('#eventList option')].map(o=>o.value),['夏祭り','春合宿','新歓']);
  eq('7 イベント名の一覧',eventNames(),['夏祭り','春合宿','新歓']);
  closeModal();
  // 期間に従う
  currentPeriod='custom';periodFrom=D(2020,8,1);periodTo=D(2020,12,31);renderReport();
  eq('7 期間: 範囲内のイベントだけ',[...document.querySelectorAll('#eventBody .ev-row b')].map(b=>b.textContent),['夏祭り']);
  periodFrom=D(2020,5,1);periodTo=D(2020,5,31);renderReport();
  const sp=document.querySelector('#eventBody .ev-row');has('7 期間: 春合宿は5月分だけ集計',sp.textContent.replace(/\s/g,''),'収入¥10,000');has('7 期間: 未処理(6月)は入らない',sp.textContent.replace(/\s/g,''),'支出¥3,000');
  eq('7 期間: 5月は春合宿の2件',[...document.querySelectorAll('#eventBody .ev-row')].length,1);
  periodFrom=D(2019,1,1);periodTo=D(2019,12,31);renderReport();
  ok('7 期間内にイベントが無ければカードを隠す',document.getElementById('eventCard').style.display==='none','');
  currentPeriod='all';
  // イベントが1件も無い
  setup({transactions:[T(D(2020,5,1),'income',100)]});renderReport();
  ok('7 イベントが無いとカードが出ない',document.getElementById('eventCard').style.display==='none','');
  // XSS
  setup({transactions:[T(D(2020,5,1),'income',100,{event:'<img src=x onerror=1>'})]});currentPeriod='all';renderReport();
  ok('7 イベント名はエスケープ',!document.querySelector('#eventBody img')&&!document.querySelector('#txList img[src="x"]'),'');
  const row=document.querySelector('#eventBody .ev-row');row.click();
  eq('7 特殊文字のイベント名でも行クリックで絞り込める',[document.getElementById('srchEvent').value,document.querySelectorAll('#txList .tx-item').length],['<img src=x onerror=1>',1]);
  clearSearch();
}

// ================= 8. CSV / Excel =================
{
  const OLD9=['日付','種別','摘要','支払先','金額','状態','カテゴリ','口座','ID'];
  const t1=T(D(2020,5,1),'income',1500,{summary:'=SUM(A1)',event:'春合宿',account:'通帳',id:'idA'});
  const t2=T(D(2020,5,2),'payment',6000,{summary:'交通費',account:'立替',paidBy:'山田',settlementId:'S9',event:'X,Y "z"',id:'idB'});
  const t3=T(D(2020,5,3),'payment',200,{summary:'plain',id:'idC'});
  setup({transactions:[t1,t2,t3]});
  let cap=null;window.dlBlob=(b,n)=>{cap={b,n};};
  exportCSV();const csv=await cap.b.text();
  const lines=csv.replace(/^﻿/,'').split('\n');
  eq('8 CSV ヘッダ: 既存9列の位置は不変',lines[0].split(',').slice(0,9),OLD9);
  eq('8 CSV ヘッダ: 末尾にイベント・立替者',lines[0].split(',').slice(9),['イベント','立替者']);
  const parsed=rowsToTxs(parseCSV(csv));
  eq('8 CSV 往復: 読めない行なし',parsed.bad,0);
  const p1=parsed.txs.find(t=>t.id==='idA'),p2=parsed.txs.find(t=>t.id==='idB'),p3=parsed.txs.find(t=>t.id==='idC');
  eq('8 CSV 往復: イベント・数式ガード',[p1.event,p1.summary],['春合宿','=SUM(A1)']);
  eq('8 CSV 往復: 立替',[p2.account,p2.paidBy,p2.status,p2.applied,p2.event],['立替','山田','done',true,'X,Y "z"']);
  ok('8 CSV 往復: settlementId は取り込まない',!('settlementId' in p2),JSON.stringify(p2));
  ok('8 CSV 往復: イベント・立替者が無い行は項目を持たない',!('event' in p3)&&!('paidBy' in p3),JSON.stringify(p3));
  // 旧9列（見出しあり／なし）
  const oldH=rowsToTxs(parseCSV('日付,種別,摘要,支払先,金額,状態,カテゴリ,口座,ID\n2020-01-01,支払い,a,b,100,済み,食費,現金,idz\n'));
  eq('8 旧9列CSV(見出し付き)',[oldH.txs.length,oldH.bad,oldH.txs[0].id,oldH.txs[0].account,oldH.txs[0].category],[1,0,'idz','現金','食費']);
  ok('8 旧9列CSV: event/paidBy なし',!('event' in oldH.txs[0])&&!('paidBy' in oldH.txs[0]),'');
  const oldN=rowsToTxs(parseCSV('2020-01-01,入金,a,b,100,済み,部費,通帳,idq\n'));
  eq('8 旧9列CSV(見出し無し・位置対応)',[oldN.txs.length,oldN.txs[0].id,oldN.txs[0].type,oldN.txs[0].account],[1,'idq','income','通帳']);
  const newN=rowsToTxs(parseCSV('2020-01-01,支払い,a,b,100,未処理,部費,現金,idr,夏祭り,田中\n'));
  eq('8 11列CSV(見出し無し): 立替者があれば立替・済み固定',[newN.txs[0].event,newN.txs[0].paidBy,newN.txs[0].account,newN.txs[0].status,newN.txs[0].applied],['夏祭り','田中','立替','done',true]);
  const odd=rowsToTxs(parseCSV('日付,種別,摘要,支払先,金額,状態,カテゴリ,口座,ID,イベント,立替者\n2020-01-01,入金,a,b,100,済み,部費,立替,i1,,誰か\n2020-01-02,支払い,a,b,100,済み,部費,立替,i2,,\n'));
  eq('8 入金の立替者は無視／立替者の無い「立替」は未設定へ',[odd.txs[0].account,'paidBy' in odd.txs[0],odd.txs[1].account,'paidBy' in odd.txs[1]],['未設定',false,'未設定',false]);
  // 取り込み(mergeImport)で保存される
  setup();mergeImport(parsed.txs);
  eq('8 取り込み: 項目が取引に入る',[transactions.find(t=>t.id==='idB').paidBy,transactions.find(t=>t.id==='idA').event],['山田','春合宿']);
  // Excel
  ok('8 XLSX ライブラリが読めている',typeof XLSX!=='undefined','XLSX undefined');
  if(typeof XLSX!=='undefined'){
    setup({transactions:[t1,t2,t3]});
    let wbCap=null;const ow=XLSX.writeFile;XLSX.writeFile=(wb,n)=>{wbCap=wb;};
    exportExcel();XLSX.writeFile=ow;
    const rows=XLSX.utils.sheet_to_json(wbCap.Sheets['取引'],{header:1});
    eq('8 Excel ヘッダ: 既存9列の位置は不変＋末尾2列',rows[0],[...OLD9,'イベント','立替者']);
    const px=rowsToTxs(rows);
    const q2=px.txs.find(t=>t.id==='idB'),q1=px.txs.find(t=>t.id==='idA');
    eq('8 Excel 往復: 立替・イベント',[q2.account,q2.paidBy,q2.event,q1.event,px.bad],['立替','山田','X,Y "z"','春合宿',0]);
    // 旧9列のシート
    const wsOld=XLSX.utils.aoa_to_sheet([OLD9,['2020-01-01','入金','a','b',100,'済み','部費','現金','idx']]);
    const po=rowsToTxs(XLSX.utils.sheet_to_json(wsOld,{header:1}));
    eq('8 旧9列のExcelも読める',[po.txs.length,po.txs[0].id],[1,'idx']);
  }
  delete window.dlBlob;
}

// ================= 9. mergeThreeWay =================
{
  const S0={orgName:'',fyStartMonth:4,openingByFy:{}};
  const base={transactions:[],counts:{},bankBalance:0,settings:S0,fiscalYears:[],settlements:[]};
  // settings: キーごと
  let m=mergeThreeWay(base,{...base,settings:{...S0,orgName:'A部'}},{...base,settings:{...S0,fyStartMonth:1}});
  eq('9 settings: キーごとの3者マージ(双方の変更が残る)',[m.data.settings.orgName,m.data.settings.fyStartMonth],['A部',1]);
  m=mergeThreeWay(base,{...base,settings:{...S0,orgName:'L'}},{...base,settings:{...S0,orgName:'S'}});
  eq('9 settings: 同じキーを両方で変えたら local',m.data.settings.orgName,'L');
  m=mergeThreeWay(base,{...base,settings:{...S0,openingByFy:{2026:100}}},{...base,settings:{...S0,openingByFy:{2027:200}}});
  eq('9 settings: openingByFy は年度ごと',m.data.settings.openingByFy,{2026:100,2027:200});
  m=mergeThreeWay(base,{...base,settings:{...S0,openingByFy:{2026:100}}},{...base,settings:{...S0,openingByFy:{2026:300}}});
  eq('9 settings: 同じ年度の繰越は local',m.data.settings.openingByFy,{2026:100});
  // 古い基準（settings 無し）でも、既定値の local が他端末の設定を潰さない
  const oldBase={transactions:[],counts:{},bankBalance:0};
  m=mergeThreeWay(oldBase,{...oldBase,settings:{...S0}},{...oldBase,settings:{orgName:'他端末',fyStartMonth:1,openingByFy:{2026:5}}});
  eq('9 settings: 基準に無い項目は既定を基準にする(他端末の設定を潰さない)',[m.data.settings.orgName,m.data.settings.fyStartMonth,m.data.settings.openingByFy],['他端末',1,{2026:5}]);
  m=mergeThreeWay(oldBase,{transactions:[]},{...oldBase,settings:{orgName:'他端末',fyStartMonth:4,openingByFy:{}}});
  eq('9 settings: local に settings が無くても落ちない',m.data.settings.orgName,'他端末');
  m=mergeThreeWay(null,{},{});
  eq('9 すべて空でも既定の settings/配列',[m.data.settings,m.data.fiscalYears,m.data.settlements],[{orgName:'',fyStartMonth:4,openingByFy:{}},[],[]]);
  // fiscalYears / settlements: id でマージ
  const fyA=closedRec(2024),fyB=closedRec(2025),fyC=closedRec(2026);
  m=mergeThreeWay({...base,fiscalYears:[fyA]},{...base,fiscalYears:[fyA,fyB]},{...base,fiscalYears:[fyA,fyC]});
  eq('9 fiscalYears: 双方の追加が残る',m.data.fiscalYears.map(f=>f.fy).sort(),[2024,2025,2026]);
  m=mergeThreeWay({...base,fiscalYears:[fyA,fyB]},{...base,fiscalYears:[fyA]},{...base,fiscalYears:[fyA,fyB]});
  eq('9 fiscalYears: 自分が取り消した締めは消える',m.data.fiscalYears.map(f=>f.fy),[2024]);
  m=mergeThreeWay({...base,fiscalYears:[fyA]},{...base,fiscalYears:[{...fyA,closedBy:'L'}]},{...base,fiscalYears:[{...fyA,closedBy:'S'}]});
  eq('9 fiscalYears: 両方で変わったら local',m.data.fiscalYears[0].closedBy,'L');
  const sA={id:'a',date:'2020-01-01',member:'A',account:'現金',amount:1,txIds:[]},sB={id:'b',date:'2020-01-02',member:'B',account:'通帳',amount:2,txIds:[]},sC={id:'c',date:'2020-01-03',member:'C',account:'現金',amount:3,txIds:[]};
  m=mergeThreeWay({...base,settlements:[sA]},{...base,settlements:[sA,sB]},{...base,settlements:[sA,sC]});
  eq('9 settlements: 双方の追加が残る',m.data.settlements.map(x=>x.id).sort(),['a','b','c']);
  m=mergeThreeWay({...base,settlements:[sA,sB]},{...base,settlements:[sA]},{...base,settlements:[sA,sB]});
  eq('9 settlements: 自分が取り消した精算は消える',m.data.settlements.map(x=>x.id),['a']);
  // 取引の event / paidBy / settlementId
  const bt=T(D(2020,5,1),'payment',1000,{id:'m1',account:'立替',paidBy:'A',summary:'s'});
  const bt2=T(D(2020,5,2),'payment',500,{id:'m2',account:'未設定',summary:'u'});
  const b2={...base,transactions:[bt,bt2]};
  m=mergeThreeWay(b2,{...b2,transactions:[{...bt,event:'春合宿'},bt2]},{...b2,transactions:[{...bt,settlementId:'S1'},bt2]});
  let r1=m.data.transactions.find(t=>t.id==='m1');
  eq('9 取引: 片方がイベント・片方が精算 → 両方残る(精算の印を落とさない)',[r1.event,r1.settlementId],['春合宿','S1']);
  ok('9 取引: 両方で変わった記録(both_changed)が残る',m.notes.some(n=>n.kind==='both_changed'),JSON.stringify(m.notes));
  m=mergeThreeWay(b2,{...b2,transactions:[{...bt,summary:'s2'},bt2]},{...b2,transactions:[{...bt,event:'E'},bt2]});
  r1=m.data.transactions.find(t=>t.id==='m1');
  eq('9 取引: 摘要(local)とイベント(server)',[r1.summary,r1.event],['s2','E']);
  const bs={...bt,settlementId:'S0'};const b3={...base,transactions:[bs,bt2]};
  m=mergeThreeWay(b3,{...b3,transactions:[{...bt,summary:'c'},bt2]},{...b3,transactions:[{...bs,event:'E2'},bt2]});
  r1=m.data.transactions.find(t=>t.id==='m1');
  eq('9 取引: 自分が精算を取り消し(印を外す)・相手がイベント → 取り消しとイベント両方',[r1.settlementId,r1.event,r1.summary],[undefined,'E2','c']);
  m=mergeThreeWay(b2,{...b2,transactions:[bt,{...bt2,event:'L'}]},{...b2,transactions:[{...bt,paidBy:'Z'},bt2]});
  eq('9 取引: 別々の取引の変更は互いに潰さない',[m.data.transactions.find(t=>t.id==='m1').paidBy,m.data.transactions.find(t=>t.id==='m2').event],['Z','L']);
  m=mergeThreeWay(b2,{...b2,transactions:[{...bt,event:'L'},bt2]},{...b2,transactions:[{...bt,event:'S'},bt2]});
  eq('9 取引: 同じ項目は local',m.data.transactions.find(t=>t.id==='m1').event,'L');
  // 現金・通帳は差分を足す（精算で引いた分が他端末の変更と両立）
  m=mergeThreeWay({...base,counts:{1000:5},bankBalance:1000},{...base,counts:{1000:3},bankBalance:900},{...base,counts:{1000:6},bankBalance:1100});
  eq('9 現金・通帳の差分マージは従来どおり',[m.data.counts[1000],m.data.bankBalance],[4,1000]);
  // 実際の競合保存の流れ: persist が 409 を受けて merge
  const oldRead=window.askConflict;
  setup({transactions:[bt]});
  window.askConflict=async()=>'merge';
  sessionStorage.setItem('circle_token','tok');
  const sv={...base,transactions:[{...bt,settlementId:'S1'}],settlements:[{id:'S1',date:'2020-06-01',member:'A',account:'現金',amount:1000,txIds:['m1'],cashBreakdown:{1000:1}}],settings:{...S0,orgName:'他'}};
  let calls=0;
  const f0=window.fetch;
  window.fetch=async(url,opt)=>{
    url=String(url);
    if(url.startsWith('/api/data')&&opt&&opt.method==='POST'){calls++;const b=JSON.parse(opt.body);if(calls===1)return J({currentVersion:7,currentData:sv},409);posted=b;return J({version:8});}
    return f0(url,opt);
  };
  writeBase(0,{...base,transactions:[bt]});lastServerVersion=0;
  transactions[0].event='L';
  await persist();
  const mt=transactions.find(t=>t.id==='m1');
  eq('9 競合保存: 端末のイベントと他端末の精算が両方残る',[mt.event,mt.settlementId,settlements.length,settings.orgName],['L','S1',1,'他']);
  ok('9 競合保存: 統合結果が送信される',posted&&posted.data.settlements.length===1&&posted.data.settings.orgName==='他',JSON.stringify(posted&&Object.keys(posted.data)));
  window.fetch=f0;window.askConflict=oldRead;sessionStorage.removeItem('circle_token');
}

// ================= 10. 復元 =================
{
  const bk=()=>({counts:{1000:2},bankBalance:100,transactions:[T(D(2020,5,1),'payment',1000,{id:'r1',account:'立替',paidBy:'A',settlementId:'RS',event:'E'})],
    settlements:[{id:'RS',date:'2020-06-01',member:'A',account:'現金',amount:1000,txIds:['r1'],cashBreakdown:{1000:1},createdAt:'x'}],fiscalYears:[closedRec(2020,5)],
    settings:{orgName:'復元部',fyStartMonth:1,openingByFy:{2022:5}},categories:[],budgets:{},collections:[],auditLog:[],cashHistory:[]});
  // 置換
  setup({transactions:[T(D(2020,1,1),'income',1)],settlements:[{id:'OLD',date:'2020-01-01',member:'Z',account:'現金',amount:1,txIds:[]}],fiscalYears:[closedRec(2019)],settings:{orgName:'今の部',fyStartMonth:4,openingByFy:{2030:1}}});
  let r=await restoreBackup(bk(),true);
  eq('10 置換: settings を戻す',settings,{orgName:'復元部',fyStartMonth:1,openingByFy:{2022:5}});
  eq('10 置換: 年度の記録・精算は丸ごと入れ替わる',[fiscalYears.map(f=>f.id),settlements.map(x=>x.id)],[['fy2020'],['RS']]);
  eq('10 置換: 取引の新フィールド',[transactions[0].event,transactions[0].paidBy,transactions[0].settlementId],['E','A','RS']);
  // 置換で settings 無しのバックアップ → 既定へ
  setup({settings:{orgName:'今の部',fyStartMonth:1,openingByFy:{}}});
  const old=bk();delete old.settings;delete old.fiscalYears;delete old.settlements;
  await restoreBackup(old,true);
  eq('10 置換: 旧バックアップ(新キー無し)は既定の設定',[settings,fiscalYears,settlements],[{orgName:'',fyStartMonth:4,openingByFy:{}},[],[]]);
  // マージ
  setup({settlements:[{id:'RS',date:'2020-06-01',member:'A',account:'現金',amount:999,txIds:[]},{id:'MINE',date:'2020-01-01',member:'Z',account:'現金',amount:1,txIds:[]}],fiscalYears:[closedRec(2019,1)],settings:{orgName:'今の部',fyStartMonth:4,openingByFy:{}}});
  await restoreBackup(bk(),false);
  eq('10 マージ: settings は戻さない',settings,{orgName:'今の部',fyStartMonth:4,openingByFy:{}});
  eq('10 マージ: id で和集合(自分の分が優先)',[settlements.map(x=>x.id).sort(),settlements.find(x=>x.id==='RS').amount],[['MINE','RS'],999]);
  eq('10 マージ: fiscalYears の和集合',fiscalYears.map(f=>f.id).sort(),['fy2019','fy2020']);
  // commitRestore まで
  setup();
  const r2=await restoreBackup(bk(),true);commitRestore('バックアップ復元','replace',r2);
  ok('10 復元後に保存データへ入る',buildPayload().settlements.length===1&&buildPayload().fiscalYears.length===1&&buildPayload().settings.orgName==='復元部','');
  ok('10 復元のログ',acts().includes('バックアップ復元'),acts().join());
  // バックアップ(完全)に新キーが入る
  const full=await buildFullBackup({includeReceipts:false});
  ok('10 完全バックアップに settings/fiscalYears/settlements',full.settings.orgName==='復元部'&&full.fiscalYears.length===1&&full.settlements.length===1,Object.keys(full).join());
  // 暗号化バックアップの往復
  const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12)),key=await deriveKey('pw',salt);
  const plain=new TextEncoder().encode(JSON.stringify(full)),cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,plain);
  const dec=JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv},await deriveKey('pw',salt),cipher)));
  setup();await restoreBackup(dec,true);
  eq('10 暗号化バックアップ相当の往復',[settings.orgName,settlements.length,fiscalYears.length],['復元部',1,1]);
}

// ================= 11. 操作ログ・保存/読み込み =================
{
  setup({...dataset('通帳'),settings:{orgName:'',fyStartMonth:4,openingByFy:{}}});
  setOrgName('甲部');setFyStart(1);setFyStart(4);setOpening(Y,'50000');closeFiscalYear(Y);unCloseFiscalYear(Y);
  const a=acts();
  for(const k of['団体名変更','年度開始月変更','前年度繰越金変更','年度締め','年度締めの取消し'])ok('11 ログ: '+k,a.includes(k),a.join());
  ok('11 すべて保存より前に積まれる',pcalls.every(p=>p.length>0)&&pcalls.length>=6,JSON.stringify(pcalls));
  const names=['団体名変更','年度開始月変更','年度開始月変更','前年度繰越金変更','年度締め','年度締めの取消し'];
  eq('11 各 persist の直前に対応するログが先頭にある',pcalls.map(p=>p[0]),names);
  // 保存(実際の送信): payload にキーが載る
  sessionStorage.setItem('circle_token','tok');posted=null;lastServerVersion=0;
  await persist();
  ok('11 送信される payload に settings/fiscalYears/settlements',posted&&posted.data.settings&&posted.data.settings.orgName==='甲部'&&Array.isArray(posted.data.fiscalYears)&&Array.isArray(posted.data.settlements),JSON.stringify(posted&&Object.keys(posted.data)));
  // 読み込み
  serverData={counts:{},bankBalance:0,transactions:[T(D(2020,5,1),'income',10,{event:'E'})],settings:{orgName:'クラウド部',fyStartMonth:1,openingByFy:{2020:7}},fiscalYears:[closedRec(2020,3)],settlements:[{id:'cs',date:'2020-01-01',member:'Q',account:'現金',amount:5,txIds:[]}],categories:[],budgets:{},collections:[],auditLog:[],cashHistory:[]};
  localStorage.removeItem('circle_unsynced');
  await loadData();
  eq('11 サーバーから読み込むと新キーが入る',[settings.orgName,settings.fyStartMonth,fiscalYears.length,settlements.length,transactions[0].event],['クラウド部',1,1,1,'E']);
  sessionStorage.removeItem('circle_token');serverData={};
  // 本番へは出ていない
  ok('11 fetch は /api/ のスタブにしか出ていない',fetchLog.every(u=>u.startsWith('/api/')),fetchLog.filter(u=>!u.startsWith('/api/')).join());
  // 締め済み年度の変更ログ
  setup({transactions:[T(D(2020,6,1),'payment',10,{account:'未設定',summary:'q'})],fiscalYears:[closedRec(2020)]});
  confirms=[];toggleTxStatus(transactions[0].id);
  eq('11 ログ「締め済み年度の変更」(状態切替)',[acts().slice(0,2)],[['締め済み年度の変更','ステータス変更']]);
}

// ================= 12. 既存動作の回帰（今回触った経路） =================
{
  setup({counts:{1000:5,500:2},bankBalance:10000});
  openAdd({type:'payment',account:'現金',amount:'1500',summary:'cashpay'});saveTx();
  const c1=transactions[0];
  ok('12 現金の支払い: confirm と金種',confirms[0].includes('現金から支払います')&&canon(c1.cashBreakdown)===canon({1000:1,500:1})&&counts[1000]===4&&counts[500]===1,confirms.join('|'));
  toggleTxStatus(c1.id);
  eq('12 済み→未払い: 枚数が戻る',[find(c1.id).status,counts[1000],counts[500],find(c1.id).applied],['pending',5,2,false]);
  toggleTxStatus(c1.id);
  eq('12 未払い→済み: 再び引く',[find(c1.id).status,counts[1000],counts[500]],['done',4,1]);
  ok('12 状態切替のログが保存より前',pcalls.at(-1)[0]==='ステータス変更',JSON.stringify(pcalls.at(-1)));
  deleteTx(c1.id);
  eq('12 削除: 枚数が戻る',[counts[1000],counts[500],transactions.length],[5,2,0]);
  ok('12 削除のログが保存より前',pcalls.at(-1)[0]==='取引削除',JSON.stringify(pcalls.at(-1)));
  openAdd({type:'payment',account:'通帳',amount:'2000',summary:'bankpay'});saveTx();
  eq('12 通帳の支払い: 残高を引く',bankBalance,8000);
  deleteTx(transactions[0].id);eq('12 通帳の支払い削除: 残高が戻る',bankBalance,10000);
  openAdd({type:'income',account:'現金',amount:'700',summary:'inc'});saveTx();
  ok('12 現金の入金(内訳なし): 枚数は変えない',counts[1000]===5&&transactions[0].applied===true,'');
  // 取引の編集で口座を変える（現金→通帳）
  openAdd({type:'payment',account:'現金',amount:'1000',summary:'mv'});saveTx();
  const mv=transactions[0];eq('12 準備: 現金から1000',counts[1000],4);
  openModal(mv.id);setAccount('通帳');saveTx();
  eq('12 編集で現金→通帳: 現金を戻し通帳から引く',[counts[1000],bankBalance],[5,9000]);
  // 立替→現金に変える（精算前）
  openAdd({type:'payment',account:'立替',amount:'1000',summary:'adv2',paidBy:'A'});saveTx();
  const av=transactions[0];openModal(av.id);setAccount('現金');setStatus('done');saveTx();
  eq('12 精算前の立替は現金払いへ変えられる(その時点で現金から引く)',[find(av.id).account,find(av.id).paidBy,counts[1000]],['現金',undefined,4]);
}
}catch(e){ok('テスト自体が例外で止まった',false,String(e&&e.stack||e));}
finally{
  if(origPersist)window.persist=origPersist;
  out.pass=out.results.filter(r=>r.pass).length;out.fail=out.results.filter(r=>!r.pass).length;out.done=true;
}
})();
