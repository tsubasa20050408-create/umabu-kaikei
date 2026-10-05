# サークル会計アプリ

部の現金・通帳・取引・集金・領収書写真を管理する PWA。陸上部（trackfield-kaikei）と umabu（umabu-kaikei）が、同じコードを別々のリポジトリ・Vercel・Upstash で動かしている。2つの違いは `index.html` のテーマ色だけ。

運用担当者向けの手順（バックアップ、PIN の変更、料金、引き継ぎ）は、各団体の「引き継ぎガイド」にある。この README は手伝う人向けの技術メモ。

## 構成

| 場所 | 中身 |
| --- | --- |
| `index.html` | 画面と処理のすべて（ビルド無し。インライン JS） |
| `sw.js` | Service Worker。**デプロイのたびに `CACHE` の番号を上げる**（上げないと古い画面が残る） |
| `api/auth.js` | PIN でログインし、7日有効のトークンを返す（10回失敗で10分ロック） |
| `api/data.js` | 本体データ（`circle:data`）。版番号による楽観ロック（Lua で比較と書き込みを一度に行う） |
| `api/receipt.js` | 領収書写真。1枚1キー（`circle:receipt:<id>`）。id は画像の SHA-256 で、書き換え不可 |
| `api/audit.js` | 古い操作ログの保管庫（`circle:audit`、最大5000件） |
| `api/health.js` | 設定の診断。値は出さず、有無だけを返す |
| `vendor/` | Chart.js・SheetJS を同梱（外部 CDN に頼らない） |

## 環境変数（Vercel）

- `CIRCLE_PIN`：4桁の数字（必須）
- `CIRCLE_SECRET`：トークンの署名鍵（必須。団体ごとに別の値）
- Redis（Upstash）の接続情報：次のどれか1組。上ほど優先
  1. `CIRCLE_REDIS_REST_URL` / `CIRCLE_REDIS_REST_TOKEN`
  2. `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`
  3. `KV_REST_API_URL` / `KV_REST_API_TOKEN`（Vercel の Storage 連携が自動で入れる名前）

どの組が使われているかは `/api/health` の `redis_source` で分かる。変更は再デプロイ後に反映される。

## テスト

```bash
npm test
```

サーバー側の処理を偽の Redis で確かめる（`test/*.test.mjs`）。画面側の処理は、ブラウザで `window.fetch` を差し替えて確かめている（リポジトリには含めていない）。

## 2つのアプリへの反映（引き継ぐまでの運用）

`main` で直して `origin`（trackfield-kaikei）へ push し、同じコミットを `umabu-health` ブランチへ cherry-pick して `umabu`（umabu-kaikei）の `main` へ push する。2つのブランチの差は、`index.html` のテーマ色の7行だけ。
