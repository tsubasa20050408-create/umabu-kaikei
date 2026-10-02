# vendor/ 同梱ライブラリ

外部CDNのURLが失効してもグラフとExcel出力が壊れないよう、ライブラリ本体をリポジトリに同梱しています。
中身を書き換えないでください（更新するときは下の入手元から取り直し、sha256 とこの表を更新します）。
更新したら `sw.js` の `CACHE` 名（`circle-vN`）も1つ上げると、利用者の端末に新しい版が行き渡ります。

| ファイル | ライブラリ | 版 | 用途 |
|---|---|---|---|
| `chart.umd.min.js` | Chart.js | 4.4.0 | グラフ表示 |
| `xlsx.full.min.js` | SheetJS Community Edition | 0.20.3 | Excelの書き出し・読み込み |

## 入手元（取得日 2026-10-02）

- `chart.umd.min.js`
  - URL: https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js
  - ライセンス: MIT（ファイル先頭に表記あり）
  - サイズ: 205,222 bytes
  - sha256: `0e2326c6868072bec1592760c6729043caeea2960a2b46cee6a2192aac6abff0`
- `xlsx.full.min.js`
  - URL: https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js
  - ライセンス: Apache-2.0（SheetJS Community Edition）
  - サイズ: 951,904 bytes
  - sha256: `cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41`
  - 0.18.5 から更新（0.18.5 には既知の脆弱性があるため）。

## 確認方法

```
sha256sum vendor/*.js
```

上の値と一致すれば、取得時点のファイルと同一です。
