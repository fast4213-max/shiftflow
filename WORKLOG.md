# 作業ログ

公開リポジトリなので、シークレット・カレンダーID・個人情報・マスタの実データは書かない。

---

## 2026-09-29 フェーズ1: 現状把握と設計案

### やったこと
- `gas/Code.gs` / `gas/index.html` / `README.md` を読み、現行仕様(予定の種類・非番・平休判定・手修正メモ・登録/リセットの挙動・画面)を整理した
- Supabase 版の設計案を `docs/DESIGN.md` にまとめた(テーブル、RLS、Edge Functions、画面、祝日の取得方法の比較、セキュリティ、フェーズ)
- `.gitignore` をシークレット・鍵ファイル・CSV(実データ)向けに整備し、`.env.example` を作成した

### 変更したファイル
- `docs/DESIGN.md`(新規)
- `WORKLOG.md`(新規)
- `.gitignore`(更新)
- `.env.example`(新規)

### 決めたこと(理由)
- 作業はすべて main に直接コミットする(依頼の運用ルールどおり)
- 設計案は承認前なので、テーブル定義やコードはまだ作らない
- `*.csv` を無視する(マスタや勤務記録の実データを誤ってコミットしないため)。架空のサンプルだけ `supabase/seed/*.example.csv` で例外にする
- 以下は設計案として提案中(承認待ち):
  - 許可リスト `members` を追加(Google ログインは誰でもできるため)
  - 祝日は Google の公開祝日カレンダーをサービスアカウントで読み、DB にキャッシュ(鍵が増えない。内閣府CSVの手動取り込みを予備に)
  - アプリ作成予定の識別キーを GAS と同じ `shiftflow` = `day` / `offduty` にする(GAS 版で作った予定も消せる見込み)
  - マスタのCSVは日本語見出しの取り込み用テーブル経由で入れる(現行CSVをそのまま使うため)

### 次にやること
- 設計案の承認を受けて、フェーズ2(SQL・RLS・seed・CSVインポート手順)に進む

### 手動でやる作業の残り
- `docs/DESIGN.md` を読んで承認、または修正点を伝える
- (フェーズ2以降で具体化)Supabase プロジェクト作成、Google Cloud の OAuth クライアントとサービスアカウント作成

---

## 2026-09-29 フェーズ2: DB(テーブル・RLS・関数)と seed

### やったこと
- 設計案の承認を受け、承認時の決定事項を `docs/DESIGN.md` の末尾に追記した
- 初期マイグレーションを作成した: `members` / `shift_master` / `user_settings` / `shift_records` / `holidays` / `holiday_years`、すべて RLS 有効
- SQL 関数: `is_member` / `is_admin` / `replace_shift_master`(マスタ入れ替え)/ `save_month_records`(月の記録の入れ替え)/ `admin_stats`(利用状況)/ `acquire_user_lock`・`release_user_lock`(二重実行防止)/ `normalize_time`
- 架空データの seed とサンプルCSVを追加
- ローカルの Postgres 16 に Supabase の auth を模した環境を作り、RLS を確認した
  - 許可リストに無い人: マスタ・記録が見えない、設定を作れない
  - 一般メンバー: マスタは読むだけ、入れ替え・許可リスト追加は拒否、`verified_at` は書けない
  - 管理者: 自分の管理者権限を外す・自分を削除することはできない
  - カレンダーIDを変えると `verified_at` が消える
  - 未ログイン(anon): 表も関数も使えない

### 変更したファイル
- `supabase/migrations/20260929000000_init.sql`(新規)
- `supabase/seed.sql`、`supabase/seed/shift_master.example.csv`(新規・架空データ)
- `supabase/config.toml`(新規)
- `docs/DESIGN.md`、`.env.example`、`WORKLOG.md`(更新)

### 決めたこと(理由)
- マスタの CSV 取り込みは管理画面から行う(依頼で管理画面が欲しいとなったため)。ダッシュボードの取り込み用テーブル案はやめた
- 泊地はメモの2行目に入れる。手修正は1行目(時間)だけ置き換える(泊地を毎回打ち直さなくてよいように)
- 検証済みフラグ・ロック・最終登録日時は列権限で利用者から書けなくし、Edge Function(service_role)だけが書く(接続テストを飛ばせないようにするため)
- 利用状況は SQL 関数で集計する(Edge Function を増やさずに済むため)
- 新しい Supabase プロジェクトでは表の権限が自動で付かないことがあるので、GRANT を明示した
- Edge Functions は関数内で JWT を検証し、ゲートウェイの `verify_jwt` は切る(新しい JWT 署名鍵方式でも動くように)

### 次にやること
- フェーズ3: Edge Functions(app-config / verify-calendar / register-month / delete-month / sync-holidays)と予定組み立てのテスト

### 手動でやる作業の残り
- Supabase のアカウント作成・新規プロジェクト作成(リージョンは Tokyo 推奨)
- SQL Editor でマイグレーション(`supabase/migrations/20260929000000_init.sql`)を実行、または `supabase db push`
- SQL Editor で自分を管理者として許可リストに入れる: `insert into public.members (email, is_admin) values ('自分のGmail', true);`
- (手順の詳細はフェーズ6の README で書く)

---

## 2026-09-29 フェーズ3: Edge Functions

### やったこと
- Edge Functions を作成した(`supabase/functions/`)
  - `app-config`: サービスアカウントのメールアドレスを、ログイン済みのメンバーにだけ返す
  - `verify-calendar`: 登録済みの勤務用・休日用カレンダーにテスト予定を書いて即削除。成功したら検証済みにする
  - `register-month`: 月の入力を保存し、アプリの予定だけ消して作り直す
  - `delete-month`: 月のアプリの予定だけ消す(翌月1日は非番だけ)
  - `sync-holidays`: 祝日を Google の公開祝日カレンダーから取ってDBにキャッシュ
- 共通処理: JWT からの利用者確認と許可リストの判定、サービスアカウントの署名(WebCrypto)、再試行(最大5回・指数バックオフ)、二重実行防止のロック
- 予定の組み立て(`_shared/plan.js`)を GAS の `buildPlan` から移植し、泊地をメモの2行目に付けるようにした。画面用に `web/js/plan.js` へ同じ内容をコピー
- テストを追加: 予定の組み立て13件、カレンダー操作4件(Google への通信は偽物に差し替え)。すべて成功
  - `deno test --allow-read --allow-env supabase/functions`

### 変更したファイル
- `supabase/functions/_shared/`(`http.ts`、`auth.ts`、`google.ts`、`holidays.ts`、`shift-calendar.ts`、`plan.js`、テスト2つ)
- `supabase/functions/{app-config,verify-calendar,register-month,delete-month,sync-holidays}/index.ts`
- `supabase/functions/deno.json`
- `web/js/plan.js`(`_shared/plan.js` のコピー)
- `WORKLOG.md`

### 決めたこと(理由)
- 予定の組み立ては1つの JS ファイルをブラウザと Edge Function で共用し、2か所のコピーが同じかをテストで確認する(ビルド不要の方針のまま、ロジックの食い違いを防ぐため)
- アプリの予定の印は GAS と同じ `extendedProperties.private.shiftflow`(GAS 版で入れた予定も消せる見込み。実機で確認する)
- 削除対象の判定は、印の有無と終日予定の日付で行う。カレンダーのタイムゾーンに左右されないよう、前後1日広めに取得してから日付で絞る
- メインのカレンダー(ID=メールアドレス)は本人のログインメールと一致するときだけ使える。ほかの人が検証済みのIDは使えない(サービスアカウントを全員で共有するため、他人のカレンダーに書けないように)
- 祝日は今年以降の年を30日ごとに取り直す(翌年の祝日が後から公開されるため)。取れなかった年は登録を止めてエラーにする(平休を間違えたまま登録しないため)

### 次にやること
- フェーズ4: フロント(ログイン・勤務入力・設定・管理画面)と GitHub Pages のワークフロー

### 手動でやる作業の残り
- Google Cloud でプロジェクト作成 → Google Calendar API を有効化 → サービスアカウント作成 → 鍵(JSON)をダウンロード(鍵はリポジトリに置かない)
- `supabase secrets set GOOGLE_SERVICE_ACCOUNT_JSON="$(cat 鍵.json)"`(またはダッシュボードの Edge Functions → Secrets)
- `supabase functions deploy`(5つの関数)
- 実機確認: 公開祝日カレンダーをサービスアカウントで読めるか、GAS 版で作った予定を新版が消せるか
- (前回からの残り)Supabase プロジェクト作成、マイグレーション実行、自分を管理者として許可リストに入れる

---

## 2026-09-29 フェーズ4: フロント(ログイン・勤務入力・設定・管理画面)

### やったこと
- `web/` に静的HTMLの画面を作成した(ビルド不要。supabase-js は jsDelivr の CDN から読み込む)
  - `login.html`: Google ログイン。ログイン後は、接続テスト前なら設定画面へ、テスト済みなら勤務入力へ移る
  - `index.html`: 勤務入力。GAS 版の画面と動きをそのまま移した(月切替、当月より前には戻れない、今日の行へスクロール、番号のボタン一覧・手入力・クリア、自動メモと手修正(青字)、非番、未登録の変更があるときの確認、リセット)。泊の日はメモ欄の下に泊地を表示する
  - `settings.html`: サービスアカウントのメールアドレス(コピーボタン付き)、カレンダー設定ページへのリンク、手順の要約、勤務用・休日用ID、保存して接続テスト
  - `admin.html`: 利用状況(許可人数・ログイン済み・接続テスト済み・30日以内に登録した人)、ログインしたがまだ許可されていない人の許可、利用者の追加・削除、マスタCSVの取り込み(UTF-8 / Shift_JIS)
  - 全画面の上のナビに「使い方」。許可リストに無い人には「利用が許可されていません」と表示する
- ホーム画面に追加するための manifest とアイコン
- `.github/workflows/pages.yml`(web/ を GitHub Pages に公開)と `test.yml`(Edge Functions のテスト)
- `help.html` は仮置き(フェーズ5で作る)
- 確認: Playwright(スマホ幅 390px)で、Supabase の応答を偽物に差し替えて全画面を操作した。非番の自動判定、祝日の「休」表示、泊地の表示、登録の送信内容、接続テスト失敗時のメッセージ、ログイン済みのときの画面移動を確認した。CSV の読み込みも単体で確認した

### 変更したファイル
- `web/*.html`、`web/js/*.js`、`web/css/*.css`、`web/manifest.webmanifest`、`web/icons/*`
- `.github/workflows/pages.yml`、`.github/workflows/test.yml`
- `WORKLOG.md`

### 決めたこと(理由)
- `web/js/config.js` には、公開してよい Supabase の URL と anon(publishable)キーだけを置く。今は仮の値で、実際の値は本人が書いてコミットする(GitHub Pages ではビルドしないため。データは RLS で守る)
- 設定の保存は、既存の行があれば update、無ければ insert にする(upsert だと、更新権限を付けていない user_id 列まで更新しようとして拒否されるため)
- 登録・削除のときは画面の値でなく、Edge Function 側でもう一度予定を組み立てる(画面の表示は確認用)
- 見た目はシンプルにした。HTML と CSS だけなので後から自由に変えられる

### 次にやること
- フェーズ5: ヘルプページ(`web/help.html`)。Google の公式ヘルプで画面の名前を確認してから書く

### 手動でやる作業の残り
- `web/js/config.js` に Supabase の URL と anon(publishable)キーを書いてコミットする
- GitHub のリポジトリの Settings → Pages → Source を「GitHub Actions」にする(設定するまで Pages のワークフローは失敗する)
- Supabase の Authentication → URL Configuration に、GitHub Pages の URL(`https://<ユーザー名>.github.io/shiftflow/login.html`)を Redirect URLs として追加する
- Google Cloud で OAuth クライアント(ウェブアプリ)を作り、Supabase の Google プロバイダに設定する
- (前回からの残り)Supabase プロジェクト作成、マイグレーション実行、自分を管理者として登録、サービスアカウント作成と鍵をシークレットに登録、Edge Functions のデプロイ
