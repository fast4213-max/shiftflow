# お問い合わせ・お知らせ の確かめ方(デバッグ用)

ふだんのテスト(GitHub でも自動で動く)は Deno だけです: `deno test --allow-read --allow-env supabase/functions`
(お問い合わせの分は `_shared/contact_test.ts`・`contact-core_test.ts`・`notify_test.ts`)。

ここにあるのは、手元で深く確かめるときのものです(GitHub では動かない)。

| ファイル | 確かめること | 動かし方 |
|---|---|---|
| `gas.test.mjs` | GAS(`../gas/Code.gs`)を Gmail などの偽物の上で動かす: 合言葉・二重送信の防止・件名の制限・相手のメールへの返信・受付メール・受信の取り込み・90日の掃除 | `node docs/contact/test/gas.test.mjs` |
| `e2e.mjs` | 画面(ログイン画面のお知らせ・お問い合わせ・お知らせ・管理画面)を Chromium で操作する。Supabase は偽物 | `npm i playwright` のあと `node docs/contact/test/e2e.mjs`(画面の画像は `shots/`) |
| `db_setup.sh` + `db_test.sql` | 本物の PostgreSQL 16 に全 migration を当てて、権限(未ログイン・利用者・管理者)・お知らせの期間(日本時間)・二重送信・回数制限・90日の削除を確かめる | `sudo bash docs/contact/test/db_setup.sh` → `psql -h /tmp/sfpg/sock -p 54329 -U postgres -d t -f docs/contact/test/db_test.sql` |

予想されるバグの一覧と状態は [`../DESIGN.md`](../DESIGN.md) の4章。
