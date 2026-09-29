# shiftflow

スマホで勤務を入力して、Googleカレンダー(勤務用・休日用)に終日予定として登録する Web アプリです。
身内の数人〜数十人で使うことを想定しています。

- 画面: 静的 HTML(ビルド不要)を GitHub Pages で配信
- ログイン・データ: [Supabase](https://supabase.com/)(Google ログイン、Postgres + RLS)
- カレンダー登録: Supabase Edge Functions から、Google のサービスアカウントで Google Calendar API を呼ぶ

**使い方(利用者向け)は、アプリ内の「使い方」ページ([`web/help.html`](web/help.html))にあります。**
この README は、アプリを用意する人(管理者)向けのセットアップ手順です。

> `gas/` は旧版(Google Apps Script + スプレッドシート)です。新版の動作確認が終わったら削除します。

---

## しくみ

```
スマホのブラウザ(ホーム画面に追加)
  │  web/*.html  … GitHub Pages
  ├─ Supabase Auth ……… Google でログイン(メールアドレスと名前だけ。カレンダーの権限は取らない)
  ├─ Supabase DB ……… マスタ・設定・勤務記録(本人の行しか読み書きできない)
  └─ Edge Functions … カレンダーへの登録・削除・接続テスト
         │  サービスアカウントの鍵(Supabase のシークレットにだけ置く)
         ▼
     Google Calendar API … 利用者が「予定を変更できる権限」で共有したカレンダーにだけ書ける
```

- 利用者は、自分のカレンダーをサービスアカウントのメールアドレスと共有し、カレンダーIDを設定画面に入れる
- Edge Function は、リクエストに書かれたカレンダーIDは使わず、ログイン中の本人が登録したIDだけを使う
- 使えるのは管理者が許可したメールアドレス(許可リスト)の人だけ

## ファイル

```
web/                        画面(GitHub Pages で配信)
  login.html                ログイン
  index.html                勤務入力
  settings.html             設定(カレンダーID・接続テスト)
  admin.html                管理(利用状況・利用者の許可・マスタCSV取り込み)
  help.html                 使い方(未ログインでも読める)
  js/config.js              Supabase の URL と公開キー(★自分の値を書く)
  js/plan.js                予定の組み立て(supabase/functions/_shared/plan.js と同じ内容)
supabase/
  migrations/*.sql          テーブル・RLS・SQL関数
  seed.sql, seed/*.csv      ローカル用の架空データ
  functions/                Edge Functions
    app-config/             サービスアカウントのメールアドレスを返す
    verify-calendar/        接続テスト(テスト予定を書いてすぐ消す)
    register-month/         月の入力を保存してカレンダーに登録
    delete-month/           月のアプリの予定だけ削除
    sync-holidays/          祝日を取得して保存
    _shared/                共通処理とテスト
.github/workflows/          Pages への公開、テスト
docs/DESIGN.md              設計
WORKLOG.md                  作業ログ
```

---

## セットアップ(はじめての人向け)

PC で作業してください。所要時間は1時間ほどです。途中で出てくる値のうち、**鍵(JSON)と service_role / secret キーは絶対にリポジトリに入れないでください。**

必要なもの:
- Google アカウント(管理者用。自分のもので可)
- GitHub アカウント(このリポジトリを自分のアカウントに置く)
- [Node.js](https://nodejs.org/)(Supabase CLI を `npx` で使うため。LTS 版でよい)

以下、`<ユーザー名>` は GitHub のユーザー名、`<ref>` は Supabase のプロジェクト ID(URL の `https://<ref>.supabase.co` の部分)です。

### 1. Supabase のプロジェクトを作る

1. https://supabase.com/ でアカウントを作り(GitHub でサインインできる)、「New project」
2. 名前(例: shiftflow)、データベースのパスワード(控えておく)、Region は **Northeast Asia (Tokyo)** を選んで作成
3. できたら、左下の歯車(Project Settings)→「API Keys」(または「Data API」)で次を確認する
   - Project URL: `https://<ref>.supabase.co`
   - **publishable キー**(`sb_publishable_...`)または旧方式の **anon キー** … 画面に書いてよい公開用の値
   - secret キー / service_role キー … **秘密の値。どこにも貼らない**(Edge Functions には自動で渡される)

### 2. データベースを作る

1. Supabase の左メニュー「SQL Editor」→「New query」
2. [`supabase/migrations/20260929000000_init.sql`](supabase/migrations/20260929000000_init.sql) の中身を全部貼り付けて「Run」
3. 続けて、自分を管理者として許可リストに入れる(メールアドレスはログインに使う Google アカウント)

   ```sql
   insert into public.members (email, is_admin, note) values ('自分のアドレス@gmail.com', true, '管理者');
   ```

### 3. Google Cloud: サービスアカウントを作る(カレンダーに書き込む役)

1. https://console.cloud.google.com/ を開き、上のプロジェクト選択 →「新しいプロジェクト」(例: shiftflow)を作って選ぶ
2. 「API とサービス」→「ライブラリ」→「Google Calendar API」を検索 →「有効にする」
3. 「IAM と管理」→「サービス アカウント」→「サービス アカウントを作成」
   - 名前: 例 `shiftflow-calendar`。ロールの付与は不要(スキップしてよい)
4. できたサービスアカウントを開き、「キー」→「鍵を追加」→「新しい鍵を作成」→「JSON」→ ダウンロード
   - この JSON ファイルが秘密鍵です。**リポジトリのフォルダに置かない**(`.gitignore` でも除外しているが、念のため別の場所に保存)
   - 「鍵の作成が無効」と出る場合は、組織のポリシーで鍵の作成が禁止されています(個人の Google アカウントでは通常出ません)
5. サービスアカウントのメールアドレス(`...@<プロジェクト>.iam.gserviceaccount.com`)は、ログイン後の設定画面と使い方ページに自動で表示されるので、控えなくてよい

### 4. Google Cloud: ログイン用の OAuth クライアントを作る

同じ Google Cloud のプロジェクトで行います。

1. 「Google Auth Platform」(https://console.cloud.google.com/auth/overview)を開き、「開始」
   - アプリ名(例: 勤務登録)、サポートメール(自分)を入れる
   - 対象(Audience)は **外部**
2. 「データアクセス」(スコープ)は `openid`、`.../auth/userinfo.email`、`.../auth/userinfo.profile` だけにする(カレンダーのスコープは**追加しない**)
3. 「対象」で公開ステータスを確認する
   - 「テスト中」のままだと、「テストユーザー」に追加した人しかログインできない(身内だけならこれでもよい。人数分追加する)
   - 誰でもログイン画面まで進めるようにするなら「アプリを公開」(基本のスコープだけなので審査は通常不要。使える人はアプリの許可リストで絞る)
4. 「クライアント」→「クライアントを作成」→ 種類「ウェブ アプリケーション」
   - 承認済みの JavaScript 生成元: `https://<ユーザー名>.github.io`
   - 承認済みのリダイレクト URI: `https://<ref>.supabase.co/auth/v1/callback`
   - 作成したら **クライアント ID** と **クライアント シークレット** を控える
5. Supabase に戻り「Authentication」→「Sign In / Providers」(または「Providers」)→「Google」を有効にし、クライアント ID とシークレットを貼って保存

### 5. Edge Functions を置く

PC のターミナルで、このリポジトリのフォルダに移動して実行します。

```bash
npx supabase@latest login                         # ブラウザが開くのでログイン
npx supabase@latest link --project-ref <ref>      # データベースのパスワードを聞かれたら 1. で決めたもの

# サービスアカウントの鍵をシークレットに登録(パスは自分が保存した場所)
npx supabase@latest secrets set GOOGLE_SERVICE_ACCOUNT_JSON="$(cat ~/Downloads/鍵のファイル名.json)"

# 関数を全部デプロイ(supabase/config.toml の設定も反映される)
npx supabase@latest functions deploy
```

- Windows の PowerShell で `$(cat ...)` が使えない場合は、Supabase のダッシュボード「Edge Functions」→「Secrets」で、名前 `GOOGLE_SERVICE_ACCOUNT_JSON`、値に JSON ファイルの中身全部を貼り付けて保存してもよい
- 2. の SQL を CLI で入れたい場合は `npx supabase@latest db push` でもよい(SQL Editor で実行済みなら不要)

### 6. 画面を公開する(GitHub Pages)

1. [`web/js/config.js`](web/js/config.js) の2行を自分の値に書き換えてコミット・プッシュする
   - `SUPABASE_URL` = `https://<ref>.supabase.co`
   - `SUPABASE_ANON_KEY` = publishable キー(または anon キー)
   - どちらも公開してよい値です。**secret / service_role キーは書かない**
2. GitHub のリポジトリ →「Settings」→「Pages」→「Source」を **GitHub Actions** にする
3. 「Actions」タブで「GitHub Pages」ワークフローが成功するのを待つ(失敗していたら「Re-run jobs」)
   - URL は `https://<ユーザー名>.github.io/shiftflow/`
4. Supabase の「Authentication」→「URL Configuration」
   - Site URL: `https://<ユーザー名>.github.io/shiftflow/login.html`
   - Redirect URLs に `https://<ユーザー名>.github.io/shiftflow/**` を追加

### 7. マスタを入れて、利用者を招待する

1. `https://<ユーザー名>.github.io/shiftflow/` を開いて Google でログイン
2. 上のメニュー「管理」→「勤務コードマスタ」で CSV を選んで「この内容で入れ替える」
   - 1行目: `番号,種別,平日出勤,平日退勤,休日出勤,休日退勤,泊`(「泊」列=泊地は無くてもよい)
   - 種別は `泊` / `日勤` / `休日`。時刻は `9:01` `09:01:00` `(9:01)` のどれでもよい
   - 見本(架空データ): [`supabase/seed/shift_master.example.csv`](supabase/seed/shift_master.example.csv)
   - 実データの CSV はリポジトリに入れない(`.gitignore` で `*.csv` を除外済み)
3. 「利用者」で家族などのメールアドレスを追加し、アプリの URL と「使い方」ページを伝える
   - 先にログインしてもらった場合は、「ログインしたが未許可の人」に出るので「許可」を押す

### 8. 動作確認

1. 自分で「設定」→ カレンダーを共有してIDを入れ →「保存して接続テスト」
2. 勤務入力で1〜2日だけ番号を入れて「登録」→ Googleカレンダーに終日予定が入り、タイトル・メモ(泊なら2行目に泊地)が合っているか確認
3. 「リセット」でその月の予定が消え、手で入れた予定は残ることを確認
4. 平/休の表示で祝日が「休」になっているか確認(祝日は Google の「日本の祝日」カレンダーから自動取得)

---

## 更新するとき

| 変えたもの | やること |
|---|---|
| `web/` | main にプッシュすれば自動で Pages に反映 |
| `supabase/functions/` | `npx supabase@latest functions deploy` |
| `supabase/migrations/`(新しいファイルを足す) | SQL Editor で新しいファイルを実行、または `npx supabase@latest db push` |
| マスタ | 管理画面で CSV を取り込み直す |

予定の組み立て(`supabase/functions/_shared/plan.js`)を変えたら、`web/js/plan.js` にも同じ内容をコピーしてください(テストで一致を確認しています)。

## テスト

```bash
# Deno(https://deno.com/)が必要
deno test --allow-read --allow-env supabase/functions
```

予定の組み立て(GAS 版と同じ挙動か)と、カレンダー操作(Google への通信は偽物)を確認します。GitHub Actions でも自動で動きます。

## 祝日について

- Google の公開カレンダー「日本の祝日」を、サービスアカウントで読んでデータベースに保存しています(年に1回程度しか取りに行きません。今年以降の分は30日ごとに取り直します)
- 取得できなかった年は、登録時にエラーになります(平/休を間違えたまま登録しないため)。そのときは、内閣府の「国民の祝日」の一覧を見て、SQL Editor で手で入れられます

  ```sql
  insert into public.holidays (date, name) values
    ('2027-01-01', '元日'),
    ('2027-01-11', '成人の日');  -- …その年の分をすべて
  insert into public.holiday_years (year, source) values (2027, 'manual')
    on conflict (year) do update set source = 'manual', fetched_at = now();
  ```

  `source = 'manual'` の年は自動で取り直しません
- 年末年始(12/30〜1/3)は祝日と関係なく「休」として扱います

## うまくいかないとき(管理者向け)

| 症状 | 確認すること |
|---|---|
| 画面に「js/config.js に Supabase の URL とキーを設定してください」 | 6-1 の config.js |
| Google ログイン後にエラー / 戻ってこない | 4-4 のリダイレクト URI、6-4 の Redirect URLs、4-3 のテストユーザー |
| 「利用が許可されていません」 | 管理画面の利用者、または 2-3 の SQL(アドレスは小文字で比較) |
| 設定画面で登録用アドレスが「取得できませんでした」 | 5 のシークレット `GOOGLE_SERVICE_ACCOUNT_JSON` と関数のデプロイ |
| 接続テストで書き込めない | 使い方ページ「5. 接続テスト」の対処。Google Calendar API を有効にしたか(3-2) |
| 「○年の祝日を取得できませんでした」 | 3-2 の API 有効化。直らなければ上の「祝日について」の手動登録 |
| 関数のログを見たい | Supabase の「Edge Functions」→ 関数名 →「Logs」 |

## セキュリティ・個人情報

- 秘密の値(サービスアカウントの鍵、secret / service_role キー、OAuth のクライアントシークレット)は Supabase / Google Cloud の画面にだけ置き、リポジトリに入れない。項目名は [`.env.example`](.env.example) を参照
- すべてのテーブルで RLS を有効にしています。勤務記録と設定は本人だけ、マスタは全員が読むだけ(書くのは管理者)
- 同じカレンダーIDは1人しか使えません。他人のメインのカレンダー(ID=メールアドレス)も使えません
- 氏名・勤務先・マスタの実データ・カレンダーIDはリポジトリに含めない
- Supabase の無料プランは、1週間使われないとプロジェクトが一時停止することがあります。停止したらダッシュボードから再開してください

## 今後の拡張

- 課金を足す場合は `members.plan`(今は常に `free`)を使って、Edge Functions や RLS で分岐できるようにしてあります
