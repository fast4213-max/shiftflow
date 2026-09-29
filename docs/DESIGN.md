# shiftflow Supabase 版 設計案

状態: **承認待ち**(2026-09-29 作成)

GAS + スプレッドシートの個人用アプリ(`gas/`)を、複数ユーザーで使える Supabase 版に作り直す。
挙動は `gas/Code.gs` / `gas/index.html` を元仕様とし、落とさずに移す。

---

## 0. 現行仕様の要点(gas/ から読み取ったもの)

| 項目 | 現行の挙動 |
|---|---|
| マスタ | 「勤務コード」シート: 番号 / 種別(泊・日勤・休日) / 平日出勤 / 平日退勤 / 休日出勤 / 休日退勤 / 泊。時刻は `(9:01)` や `09:01:00` を `9:01` に正規化 |
| 記録 | 「勤務記録」シート: 日付 / 勤務 / (日種別: 未使用) / メモ。メモは手修正した日だけ。登録時にその月の行を入れ替え |
| 平/休 | 土日・祝日(Google「日本の祝日」カレンダー)・12/30〜1/3 は休、他は平。表示のみ |
| 予定 | すべて終日。泊=番号/出勤時間、日勤=番号/出勤〜退勤、非番=「〜」/退勤時間(前日の泊の退勤列を、その日の平休で選ぶ)、休日=番号/メモなし(休日用カレンダー)、手入力=入力文字/メモなし |
| 非番 | 前日が泊なら自動で非番。番号は無視され、メモだけ手修正できる。月末が泊なら翌月1日の非番も作る。1日の非番は前月末の記録から判定 |
| 時刻の選び方 | その日の平休の列。空なら平日の列にフォールバック |
| 手修正メモ | 自動値と同じなら保存しない。番号を選び直すと自動値に戻る |
| 登録 | 保存 → その月(+翌月1日の非番)のアプリ作成予定だけ削除 → 作り直し。タグ `shiftflow` = `day` / `offduty` |
| リセット | 月を選んで、アプリ作成予定だけ削除(記録は残る)。翌月1日は `offduty` だけ対象 |
| 再試行 | カレンダー操作は最大5回、指数バックオフ。1件ごとに100ms待つ |
| 画面 | 月切替(当月より前に戻れない)、1日1行、今日の行へスクロール、番号はボタングリッド(勤務/休み)+手入力+クリア、未登録の変更があれば月移動時に確認、リセットは月選択→確認→削除 |

---

## 1. 全体構成

```
[スマホのブラウザ / ホーム画面]
   │  静的HTML (GitHub Pages)  web/*.html + supabase-js(CDN)
   │
   ├─ Supabase Auth (Google ログイン: email/profile のみ)
   ├─ Supabase DB (Postgres + RLS)   ← マスタ・設定・記録を直接読み書き
   └─ Supabase Edge Functions (Deno) ← カレンダー操作だけはここ経由
            │ サービスアカウントの鍵 (Supabase シークレット)
            ▼
       Google Calendar API
```

- ブラウザは Google カレンダーに一切触らない(OAuth スコープもカレンダー権限を取らない)
- カレンダーに書くのはサービスアカウント(以下 SA)だけ。ユーザーは自分のカレンダーを SA に「予定の変更権限」で共有する
- 課金は作らないが、`members.plan` 列を置いて後から足せるようにする

---

## 2. テーブル(すべて RLS 有効)

### 2-1. `members`(利用者の許可リスト)※追加提案

| 列 | 型 | 説明 |
|---|---|---|
| email | text PK | 利用を許可する Google アカウントのメール(小文字) |
| is_admin | boolean | 管理者(マスタ編集など) |
| plan | text default 'free' | 将来の課金用。今は使わない |
| note | text | 管理用メモ(誰か分かる程度。リポジトリには入らない) |
| created_at | timestamptz | |

- **理由**: Google ログインは誰でもできるので、許可リストが無いと、URL を知った第三者も使えてしまう(SA 経由でカレンダーに書ける)。身内数人〜数十人なので、管理者がダッシュボードでメールを足す運用で十分
- 判定用の関数 `is_member()` / `is_admin()`(`security definer`、`auth.jwt()->>'email'` と照合)を作り、他テーブルの RLS から使う
- RLS: 本人の行だけ読める(自分が許可されているかの確認用)。書き込みはダッシュボードのみ(ポリシーなし)

### 2-2. `shift_master`(勤務コードマスタ)

| 列 | 型 | 元の列 |
|---|---|---|
| code | text PK | 番号 |
| kind | text check in ('泊','日勤','休日') | 種別 |
| weekday_start / weekday_end | text | 平日出勤 / 平日退勤(`H:MM`、空は '') |
| holiday_start / holiday_end | text | 休日出勤 / 休日退勤 |
| stay | text | 泊 |
| sort_order | int | ボタン一覧の並び順(CSV の行順) |

- RLS: `select` はメンバー全員。`insert/update/delete` は `is_admin()` のみ
- **CSV インポート**: Table Editor の CSV 取り込みは列名が一致している必要があるので、日本語見出しそのままの取り込み用テーブル `shift_master_import`("番号","種別","平日出勤",…すべて text)を用意する。
  手順: ①Table Editor で `shift_master_import` に CSV を取り込む → ②SQL Editor で `select import_shift_master();` を実行 → 時刻を `9:01` 形式に正規化して `shift_master` を入れ替え、取り込み用テーブルを空にする。
  現行と同じ CSV(kinmu-master-csv で作るもの)がそのまま使える
- `supabase/seed.sql` には**架空の**サンプルマスタだけを入れる(実データは入れない)

### 2-3. `user_settings`

| 列 | 型 | 説明 |
|---|---|---|
| user_id | uuid PK = auth.uid() | |
| work_calendar_id | text | 勤務用カレンダーID |
| holiday_calendar_id | text | 休日用カレンダーID |
| verified_at | timestamptz null | 接続テスト成功日時(= 検証済みフラグ) |
| busy_until | timestamptz null | 登録・削除の二重実行防止(GAS の LockService の代わり) |
| updated_at | timestamptz | |

- RLS: 本人のみ select/insert/update
- `verified_at` と `busy_until` は**ユーザーが直接更新できない**(列権限で authenticated から外し、Edge Function の service role だけが書く)
- トリガー: カレンダーIDが変わったら `verified_at` を null に戻す
- カレンダーIDは**他のユーザーと重複登録できない**(Edge Function の検証時に service role で確認)。理由は 6章「セキュリティ」

### 2-4. `shift_records`(勤務記録)

| 列 | 型 | 説明 |
|---|---|---|
| user_id | uuid | auth.uid() |
| date | date | 日付 |
| code | text default '' | 勤務(番号 or 手入力の文字。非番の日は '') |
| memo | text default '' | 手修正したときだけ |
| updated_at | timestamptz | |

- PK (user_id, date)
- RLS: 本人のみ select/insert/update/delete
- 月の入れ替え保存は SQL 関数 `save_month_records(year, month, entries jsonb)`(`security invoker` なので RLS がそのまま効く)で、削除+挿入を1トランザクションで行う

### 2-5. `holidays`(祝日キャッシュ)

| 列 | 型 |
|---|---|
| date | date PK |
| name | text |

`holiday_years(year int PK, fetched_at timestamptz)` で「その年を取得済みか」を持つ。
RLS: メンバーは select のみ。書き込みは Edge Function(service role)だけ。

---

## 3. 祝日の取得方法の比較

| 案 | 内容 | 良い点 | 悪い点 |
|---|---|---|---|
| A. Google の公開祝日カレンダーを API キーで読む | `ja.japanese.official#holiday@group.v.calendar.google.com` を API キーで events.list | 現行と同じデータ源。臨時の祝日も自動で反映 | API キーを別に作って管理する必要がある。公開範囲は前後1年程度 |
| A'. 同じカレンダーを **SA で読む** | 上と同じだが、既にある SA の認証で読む | **鍵が増えない**。現行と同じデータ源 | 同上(前後1年程度)。Google 側の都合でカレンダーIDが変わる可能性はゼロではない |
| B. 祝日テーブルを手で持つ | 内閣府の `syukujitsu.csv` を年1回取り込む | 外部依存なし・確実 | 毎年の手作業(忘れると平休判定がずれる)。CSV が Shift_JIS |
| C. 計算ライブラリ | 春分・秋分の計算や振替休日を実装 | 通信不要 | 法改正や特例(2020/2021年の移動など)でライブラリ更新が必要 |
| D. 第三者の祝日API | holidays-jp など | 手軽 | 第三者のサービスが止まるリスク |

**提案: A' + テーブルにキャッシュ(失敗時は B で手動補完できる)**

- Edge Function の共通処理 `getHolidays(from, to)` が、`holiday_years` に無い年だけ SA で祝日カレンダーを読み、`holidays` に保存する(年1回程度しか Google を呼ばない)
- 画面の平休表示は `holidays` テーブルを直接読む。その年が未取得なら `sync-holidays` 関数を呼んでから読む
- Google から取れない場合に備え、`holidays` に内閣府 CSV を手で取り込む手順も README に書く(案Bを予備に)
- 年末年始(12/30〜1/3)は祝日テーブルとは別にコードで休扱い(現行と同じ)

---

## 4. Edge Functions(`supabase/functions/`)

共通(`_shared/`):
- `auth.ts`: `Authorization` の JWT から user_id / email を取得(本文の値は使わない)。`members` に無ければ 403
- `google.ts`: SA の JSON 鍵(シークレット `GOOGLE_SERVICE_ACCOUNT_JSON`)で JWT を署名(WebCrypto RS256)→ アクセストークン取得。スコープは `https://www.googleapis.com/auth/calendar.events` のみ。429/403(rateLimit)/5xx は最大5回の指数バックオフで再試行(現行と同じ)
- `plan.ts`: 現行 `buildPlan` を移植(平休判定・非番・メモ・翌月1日)。Deno のユニットテストを付ける
- `holidays.ts`: 3章の取得・キャッシュ
- `lock.ts`: `user_settings.busy_until` を使った二重実行防止(60秒)

| 関数 | 入力 | 処理 |
|---|---|---|
| `app-config` | なし | SA のメールアドレス(シークレットの JSON から取り出す)を返す。**ログイン済みメンバーだけ**。設定画面とヘルプで表示 |
| `verify-calendar` | なし | `user_settings` に登録済みの勤務用・休日用IDそれぞれに、テスト予定を作成→即削除。どちらかが失敗したら、どちらのカレンダーかと「共有設定(予定の変更権限)を確認してください」を返す。他ユーザーと重複するIDも拒否。両方成功で `verified_at = now()` |
| `register-month` | `{year, month, entries}` | 未検証なら拒否 → ロック → マスタ・前月末・翌月1日の記録・祝日を読む → `buildPlan` → `save_month_records` で保存 → アプリ作成予定だけ削除 → 作り直し → 件数を返す |
| `delete-month` | `{year, month}` | 未検証なら拒否 → ロック → その月の、アプリ作成予定だけを削除(翌月1日は `offduty` だけ)。記録は消さない |
| `sync-holidays` | `{year}` | その年が未取得なら取得してキャッシュ(メンバーなら誰でも呼べる。冪等) |

### アプリが作った予定の識別

- 終日予定を `start.date` / `end.date`(翌日、排他)で作る
- `extendedProperties.private = { shiftflow: "day" | "offduty" }` を付ける
  - GAS の `setTag("shiftflow", kind)` と同じキー・値にしてあるので、**GAS 版で登録済みの予定も新版から削除・作り直しできる見込み**(CalendarApp のタグは private extended property として保存されるため。実機で要確認)
- 削除は `events.list`(`privateExtendedProperty=shiftflow=day` と `=offduty` で絞り込み、`timeMin/timeMax` は `+09:00` で指定)→ 1件ずつ `events.delete`
- カレンダーIDは**常に `user_settings` から読む**。リクエスト本文にカレンダーIDを入れても無視する

### 実行時間

1か月で最大 約31件作成 + 約31件削除 = 60〜70回の API 呼び出し。同時実行数を少し(例: 4)に抑えて並列にし、10〜20秒程度を見込む(Edge Function の上限内)。

---

## 5. 画面(`web/`、ビルド不要)

```
web/
  index.html        勤務入力(メイン)
  login.html        ログイン
  settings.html     設定
  help.html         使い方(未ログインでも読める)
  help/             ヘルプ用の画像(個人情報を写さない)
  css/app.css
  js/config.js      Supabase の URL と anon(publishable)キー ※公開前提の値
  js/supabase.js    クライアント初期化・ログイン状態の確認・画面の振り分け
  js/shift.js       平休判定・自動メモ(表示用。本体は Edge Function 側)
  js/index.js / settings.js / help.js
  manifest.webmanifest, icons/  ホーム画面追加用
```

- supabase-js は CDN(`cdn.jsdelivr.net/npm/@supabase/supabase-js@2`)から読む
- 画面の流れ: `login.html` → ログイン後、`user_settings` が無い/未検証なら `settings.html`、検証済みなら `index.html`。メンバーでなければ「利用が許可されていません」を表示してログアウト
- 全画面のヘッダーに「使い方」リンク。勤務入力画面には「設定」リンクも
- **勤務入力**: 現行 `index.html` の UI・挙動をそのまま移植(月切替・当月より前に戻れない・1日1行・今日にスクロール・ボタングリッド+手入力+クリア・自動メモ/手修正(青字)・非番表示・未登録の変更の確認・リセット→月選択→確認→削除)。データの読み込みは DB を直接、登録・削除は Edge Function
- **設定**: SA のメールアドレス(コピーボタン)、Google カレンダーの設定ページへのリンク、勤務用・休日用ID入力、保存、「接続テスト」、結果表示、ヘルプへのリンク。スマホではリンク先がアプリに奪われることがある旨と手順の要約も併記
- スマホ最優先(現行と同じ最大幅 560px 程度のレイアウト)
- **GitHub Pages**: `web/` を配信するため `.github/workflows/pages.yml`(Actions で web/ をデプロイ)を置く。ブランチ直下/`docs` 以外のフォルダはブランチ配信で選べないため

### ヘルプ(`web/help.html`)

依頼の 1〜8 の構成で作成。短い手順を表に出し、詳細は `<details>` で折りたたむ。
SA のメールアドレスはログイン済みのときだけ `app-config` から取得して表示し、未ログイン時は「ログイン後に表示されます」とする。
Google 側の画面名は執筆時に公式ヘルプで確認し、確認日を末尾に載せる。

---

## 6. セキュリティ

- **シークレット**: SA の JSON 鍵は `supabase secrets set` でだけ設定。`.env` / `supabase/.env` / `*.json` の鍵ファイルは `.gitignore`。`.env.example` には項目名だけ
- **コミットしてよい値**: Supabase の URL と anon(publishable)キーは公開前提の値(RLS で守る)なので `web/js/config.js` に置く。service_role キーはフロントにもリポジトリにも置かない
- **カレンダーIDのなりすまし対策**: 全員が同じ SA を使うため、他人が SA に共有したカレンダーのIDを知っていれば書き込めてしまう。対策として
  1. `members` の許可リスト(身内以外は使えない)
  2. 同じカレンダーIDを複数ユーザーで登録できない(先に登録・検証した人のもの)
  3. ヘルプでは新しく作ったカレンダー(推測できないID)を使うことを推奨し、メインのカレンダー(ID=メールアドレス)を使う場合は本人のログインメールと一致するときだけ許可する
- Edge Function はすべて JWT 必須。本文のカレンダーIDは無視
- ユーザーは `verified_at` / `busy_until` を自分で書き換えられない(列権限)

---

## 7. 手順(フェーズ)

| # | 内容 | 主な成果物 |
|---|---|---|
| 1 | 現状把握・設計案(今回) | `docs/DESIGN.md`, `WORKLOG.md`, `.gitignore`, `.env.example` |
| 2 | SQL(テーブル+RLS+関数)、seed(架空データ)、CSV インポート手順 | `supabase/migrations/*.sql`, `supabase/seed.sql`, `supabase/config.toml` |
| 3 | Edge Functions + `plan.ts` のテスト | `supabase/functions/**` |
| 4 | フロント(ログイン・勤務入力・設定)、Pages のワークフロー | `web/**`, `.github/workflows/pages.yml` |
| 5 | ヘルプページ(公式ヘルプで名称確認、スマホ幅で表示確認) | `web/help.html`, `web/help/` |
| 6 | README(初心者向けセットアップ・デプロイ手順) | `README.md` |
| 7 | 動作確認後、`gas/` 削除(**削除前に確認**)と README 全面書き換え | 別コミット |

各フェーズの最後に「手動でやる作業」を一覧にし、WORKLOG.md にも書く。
