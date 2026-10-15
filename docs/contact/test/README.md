# お問い合わせ・お知らせ の確かめ方(デバッグ用)

GitHub で毎回自動で動くテストは2つあります(`test.yml`、`deploy-supabase.yml` の反映の前)。
- Deno のテスト: `deno test --allow-read --allow-env supabase/functions`(お問い合わせの分は `_shared/contact_test.ts`・`contact-core_test.ts`・`notify_test.ts`)
- DB のテスト: 空の PostgreSQL 17 に全 migration を当てて、`db_stub.sql` と `db_assert.sql` で確かめる(下の表)

このフォルダの `gas.test.mjs`・`e2e.mjs`・`db_setup.sh` + `db_test.sql` は、手元で深く確かめるときのものです(GitHub では動かない)。

| ファイル | 確かめること | 動かし方 |
|---|---|---|
| `gas.test.mjs` | GAS(`../gas/Code.gs`)を Gmail などの偽物の上で動かす: 合言葉・二重送信の防止・件名の制限・相手のメールへの返信・受付メール・受信の取り込み・90日の掃除 | `node docs/contact/test/gas.test.mjs` |
| `db_stub.sql` + `db_assert.sql` | GitHub で自動(`test.yml` の `database`。`deploy-supabase.yml` の反映の前にも動く)。Supabase 風の土台を作って全 migration を当てたあと、権限・RLS・利用者が書ける列(grant)・お知らせの期間・二重送信・回数制限・マスタの切替(切替日の権限・まとめて作る/直す/消す・古い切替日の片付け・区所を足したとき)などを assert で確かめる。失敗するとそこで止まる | 手元: `sudo bash docs/contact/test/db_setup.sh` のあと `psql -h /tmp/sfpg/sock -p 54329 -U postgres -d t -v ON_ERROR_STOP=1 -f docs/contact/test/db_assert.sql` |
| `e2e.mjs` | 画面(ログイン画面のお知らせ・お問い合わせ・お知らせ・管理画面[マスタの切替日のタブ・次のマスタ・まとめて作る]・設定・勤務入力[マスタの切替の知らせ・赤と黄色の行]・写真取込の受け取り・区所の並び替え・通信の時間切れ・公開直後の古い HTML と新しい JS・幅320px)を Chromium で操作する。Supabase は偽物 | `npm i playwright` のあと `node docs/contact/test/e2e.mjs`(画面の画像は `shots/`) |
| `db_setup.sh` + `db_test.sql` | 本物の PostgreSQL 16 に全 migration を当てて、権限(未ログイン・利用者・管理者)・お知らせの期間(日本時間)・二重送信・回数制限・90日の削除を確かめる | `sudo bash docs/contact/test/db_setup.sh` → `psql -h /tmp/sfpg/sock -p 54329 -U postgres -d t -f docs/contact/test/db_test.sql` |

予想されるバグの一覧と状態は [`../DESIGN.md`](../DESIGN.md) の4章。
