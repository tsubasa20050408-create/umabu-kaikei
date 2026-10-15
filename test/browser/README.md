# 画面側のテスト（ブラウザで実行）

画面の処理（同期・競合の解決・領収書・決算など）を、ブラウザ上で `window.fetch` を偽物に差し替えて確かめる。本番や Upstash には通信しない。

## 実行のしかた

1. リポジトリ直下でローカルサーバーを起動する（ポート番号は空いていれば何でもよい）

   ```bash
   python -m http.server 3150 --bind 127.0.0.1
   ```

2. ブラウザで `http://127.0.0.1:3150/index.html` を開き、開発者ツールのコンソールで次を実行する

   ```js
   for (const f of ['phase4-client-tests.js','phase3-client-tests.js','phase2-client-tests.js','phase2-review-tests.js','phase2-legacy-receipt-tests.js','phase6-client-tests.js']) {
     const t = await (await fetch('/test/browser/' + f)).text();
     console.log(f, await (0, eval)(t));
   }
   console.log('phase6', window.__p6);
   ```

- 各ファイルは `PASS=n FAIL=n` を返す。`phase6-client-tests.js` だけは結果を `window.__p6`（`done` / `pass` / `fail` / `results`）に置く。
- 写真のテストは端末内の保管庫（IndexedDB）を使う。同じアドレスで開いた古いタブが残っていると止まることがあるので、他のタブを閉じるか、ポート番号を変えて開き直す。
- 画面が裏に隠れているとタイマーが遅くなり、数分かかることがある。
