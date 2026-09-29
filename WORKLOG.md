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

---

## 2026-09-29 フェーズ5: ヘルプページ

### やったこと
- `web/help.html` を作成した(未ログインでも読める)。構成: 1.はじめに(予定の種類の表)/ 2.カレンダーの準備 / 3.共有(A: PC、B: スマホだけの人。PC版サイトへの切り替え方と、アプリに奪われたときの対処つき)/ 4.カレンダーID / 5.接続テストと対処 / 6.入力・登録・リセット / 7.ホーム画面に追加 / 8.よくある質問。冒頭に「共有設定は最初の1回だけ」と書いた
- 短い手順を表に出し、詳細は折りたたみ(`<details>`)にした
- 登録用アドレス(サービスアカウントのメール)は、ログイン済みのメンバーのときだけ表示する
- 書く前に Google・Apple の公式ヘルプで画面の名前を確認した(確認日 2026-09-29 をページ末尾に記載)
- 設定画面の説明文と、書き込めないときのエラーメッセージを、確認した表記に合わせた
- Playwright でスマホ幅(390px)の表示を確認した。横にはみ出さないこと、ログイン前後の表示の違いを確認し、崩れていた対処表は見出し+箇条書きの形に直した
- 画像は使っていない(文章だけで手順が分かるようにした。個人情報が写るおそれもない)

### 変更したファイル
- `web/help.html`、`web/css/help.css`、`web/js/help.js`(新規)
- `web/settings.html`(説明文)、`supabase/functions/_shared/google.ts`(エラーメッセージ)、`supabase/functions/_shared/shift-calendar_test.ts`
- `WORKLOG.md`

### 決めたこと(理由)
- 公式ヘルプで確認した表記を使った。依頼時の表記と違ったものは次のとおり
  - 共有先の欄: 公式ヘルプでは「共有する相手」。旧表記の「特定のユーザーまたはグループと共有する」も併記した
  - 権限: 公式ヘルプには「予定の変更権限」という名前がなく、「予定の表示(時間枠のみ、詳細は非表示)」「予定の詳細の表示」「変更可能(限定公開の予定を、予定の有無としてのみ表示)」「予定の詳細を変更、表示可能」「予定の変更および共有の管理」の5つ。ヘルプでは「予定を変更できるもの」と書き、公式表記の「予定の詳細を変更、表示可能」を案内し、「予定の変更権限」と表示される場合もあると添えた(公式ヘルプはAI翻訳の注記つきで、実際の画面と違う可能性があるため)
  - スマホアプリでの共有: 公式ヘルプ(Android / iPhone)には、アプリの「設定」から共有する手順が載っていた。依頼どおり PC 版サイトでの操作を案内の中心にし、「アプリで共有できる場合もあるが、カレンダーIDの確認は PC 版で」と断定しない書き方にした
  - iPhone Safari: Apple の表記は「デスクトップ用ウェブサイトを表示」(ページメニューのボタンから)
  - Android Chrome: 「︙」→「PC 版サイト」
  - カレンダーID: 「カレンダーの統合」は公式ヘルプで確認できた。その中の「カレンダー ID」という項目名は公式ヘルプでは確認できなかった(一般の解説記事ではこの名前)
  - ホーム画面に追加: iPhone は公式ヘルプで確認した。Android Chrome は版によって名前が違うことがあると書いた

### 次にやること
- フェーズ6: README(Supabase プロジェクト作成、Google Cloud の OAuth クライアントとサービスアカウント、シークレット、デプロイ手順)

### 手動でやる作業の残り
- 実際の Google カレンダーの画面で、ヘルプの名前(特に権限の名前・「カレンダー ID」)が合っているか見て、違えば教えてほしい
- (前回からの残り)Supabase プロジェクト作成、マイグレーション実行、自分を管理者として登録、Google Cloud の設定、シークレット登録、Edge Functions のデプロイ、config.js の記入、GitHub Pages の有効化、リダイレクトURLの登録

---

## 2026-09-29 フェーズ6: README

### やったこと
- README を Supabase 版のセットアップ手順(管理者向け・初心者向け)に書き換えた: Supabase プロジェクト作成 → DB(SQL)と管理者登録 → Google Cloud のサービスアカウントと鍵 → OAuth クライアント(Google Auth Platform)と Supabase の Google プロバイダ → Edge Functions のシークレットとデプロイ → config.js と GitHub Pages → マスタ取り込みと利用者の招待 → 動作確認。更新方法、テスト、祝日の手動登録、トラブル対処、セキュリティも書いた
- 利用者向けの使い方は README に書かず、`web/help.html` へリンクした
- Supabase の公式ドキュメントで、Edge Functions に渡される鍵の変数名が新方式(`SUPABASE_SECRET_KEYS` / `SUPABASE_PUBLISHABLE_KEYS`)に移りつつあることを確認したので、`_shared/auth.ts` を旧方式・新方式のどちらでも動くようにした
- `gas/` はまだ残している(README の冒頭に旧版と注記)

### 変更したファイル
- `README.md`
- `supabase/functions/_shared/auth.ts`
- `WORKLOG.md`

### 決めたこと(理由)
- Edge Functions のデプロイは `npx supabase@latest` で行う(CLI を別にインストールしなくて済むため)
- シークレットの登録は CLI とダッシュボードの両方を書いた(Windows の PowerShell ではコマンドの書き方が違うため)
- OAuth の公開ステータスは「テスト中+テストユーザー」「公開」のどちらでもよいと書いた(利用者の絞り込みはアプリの許可リストで行うため)

### 次にやること
- 実環境で動作確認(下の手動作業)。問題があれば直す
- 確認が終わったら `gas/` の削除(削除前に確認をもらう)と、README の旧版の注記を消す

### 手動でやる作業の残り
- README の「セットアップ」1〜8 を順に実施する
  1. Supabase プロジェクト作成(Tokyo)
  2. SQL Editor でマイグレーション実行、自分を管理者として登録
  3. Google Cloud: プロジェクト作成、Calendar API 有効化、サービスアカウントと鍵(JSON)作成
  4. Google Cloud: OAuth クライアント作成、Supabase の Google プロバイダに設定
  5. シークレット `GOOGLE_SERVICE_ACCOUNT_JSON` の登録と `functions deploy`
  6. `web/js/config.js` の記入とプッシュ、GitHub Pages の Source を「GitHub Actions」に、Supabase の URL Configuration
  7. 管理画面でマスタ CSV を取り込み、利用者を追加
  8. 動作確認(登録・メモの泊地・リセット・祝日の「休」・GAS 版で登録済みの予定が消せるか)
- ヘルプの画面の名前が実際の Google カレンダーと合っているか確認

---

## 2026-09-29 追加対応: 区所ごとのマスタ・マスタの表・管理画面のパスワード

### やったこと
- **区所**: `offices` テーブルを追加し、勤務コードマスタを区所ごとに持つようにした(`shift_master` の主キーは 区所+番号)。利用者は設定画面で自分の区所を選び、勤務入力と登録はその区所のマスタだけを使う。区所を選んでいないと勤務入力に進めない
- **CSV 取り込み**: 管理画面で区所を選んでから CSV を選ぶ。取り込む前に全列(番号・種別・平日出勤・平日退勤・休日出勤・休日退勤・泊)の表を出し、種別の間違い・番号の重複・読めない時刻・泊/日勤の平日出勤が空の行を赤くして、直すまで取り込めないようにした
- **マスタの表**: いま入っているマスタを区所ごとに全列の表で表示し、「CSVで保存」で書き出せるようにした
- **管理画面のパスワード**: 管理の操作は「管理者フラグ」かつ「そのログインでパスワード解除済み(1時間)」のときだけ DB が許可する。パスワードは bcrypt のハッシュだけを保存し、SQL Editor の `set_admin_passcode()` でだけ設定できる。5回間違えると15分ロック。「ロックする」ボタンもある
- DB はまだ作っていないとのことなので、追加のマイグレーションは作らず、初期マイグレーション1本にまとめ直した
- 管理の区所・利用状況に区所の情報(区所ごとのマスタ件数・利用者数、利用者ごとの区所)を追加
- README・使い方ページ・設計書を更新

### 変更したファイル
- `supabase/migrations/20260929000000_init.sql`(作り直し)、`supabase/seed.sql`
- `supabase/functions/_shared/shift-calendar.ts`、`supabase/functions/register-month/index.ts`
- `web/admin.html`、`web/js/admin.js`、`web/js/csv.js`、`web/settings.html`、`web/js/settings.js`、`web/js/index.js`、`web/js/app.js`、`web/js/login.js`、`web/css/app.css`、`web/help.html`
- `README.md`、`docs/DESIGN.md`、`WORKLOG.md`

### 決めたこと(理由)
- 管理画面を「URL + パスワード」で守る方法は、静的サイトでは URL もパスワードも見えてしまうので使わない。代わりにパスワードの照合を DB 側で行い、Google ログイン(管理者のアカウント)+ パスワードの二段にした
- 解除はログインセッションごと・1時間(ほかの端末や、ログインし直した後は再入力)。パスワードを間違え続けた場合に備えてロックを付けた
- Supabase は新しい関数に一般ユーザーの実行権限を自動で付けるため、関数の実行権限をいったん全部外して必要なものだけ付けた(テストで、一般ユーザーがパスワード設定やロック用の関数を呼べてしまうことが分かったため)
- 区所を変えても接続テスト済みは外さない(カレンダーは変わらないため)。カレンダーIDを変えたときだけ外す
- 区所を削除すると、その区所のマスタも消え、選んでいた利用者は未選択に戻る(確認ダイアログで件数を出す)

### 確認したこと
- ローカルの Postgres で: パスワード未解除の管理者は管理操作ができない / 解除後はできる / 別セッションは未解除 / 5回で15分ロック / 一般ユーザーはパスワード設定・ロック用関数・区所追加ができない / 区所ごとのマスタ入れ替え / 区所を変えても検証済みは残り、IDを変えると外れる / 未ログインは何も使えない
- Playwright(スマホ幅)で: パスワード解除、CSV の確認表(問題の行が赤・取り込み不可)、取り込み、CSV の書き出し、設定画面の区所選択、勤務入力が区所のマスタだけを読むこと
- Edge Functions のテスト 17件成功

### 次にやること
- 実環境での動作確認(README のセットアップ 1〜8)
- 確認後、`gas/` の削除(削除前に確認をもらう)

### 手動でやる作業の残り
- README のセットアップ 1〜8(Supabase・Google Cloud・シークレット・デプロイ・config.js・Pages・リダイレクトURL)
- SQL Editor で、自分を管理者に登録したあと `select public.set_admin_passcode('...');` で管理画面のパスワードを設定し、そのクエリを SQL Editor から消す
- 管理画面で区所を追加し、区所ごとに CSV を取り込む

---

## 2026-09-29 いったん中断

### やったこと
- セットアップ(Supabase・Google Cloud など)の手間が大きいため、ここで作業をいったん止めることにした。コードは main にすべて push 済み

### 変更したファイル
- `WORKLOG.md`

### 決めたこと(理由)
- 実環境のセットアップは保留。GAS 版(`gas/`)はそのまま残し、引き続き使える状態にしておく(新版の動作確認が済むまで削除しない方針のため)

### 次にやること(再開するとき)
- README の「セットアップ」1〜8 を順に実施し、動作確認する
- 確認後、`gas/` の削除(削除前に確認をもらう)

### 手動でやる作業の残り
- README のセットアップ 1〜8 すべて(未着手)
