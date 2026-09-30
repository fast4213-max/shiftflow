# shiftflow

勤務を入力して、Googleカレンダー(勤務用・休日用)に終日予定として登録する Web アプリです。
身内の数人〜数十人で使うことを想定しています。ログインは **社員番号(7桁)+ PIN(4桁)** です。

- 画面: 静的 HTML(ビルド不要)を GitHub Pages で配信
- データ・ログイン: [Supabase](https://supabase.com/)(Postgres + RLS)
- カレンダー登録: Supabase Edge Functions から、Google のサービスアカウントで Google Calendar API を呼ぶ
- デプロイ: GitHub Actions が自動で行う(**Chromebook でもターミナルは不要**。ブラウザだけで済みます)

**使い方(利用者向け)は、アプリ内の「使い方」ページ([`web/help.html`](web/help.html))にあります。**
この README は、アプリを用意する人(管理者)向けのセットアップ手順です。

---

## しくみ

```
スマホのブラウザ(ホーム画面に追加)
  │  web/*.html  … GitHub Pages
  ├─ Edge Functions ……… ログイン・新規登録・カレンダーへの登録
  │      │  サービスアカウントの鍵(Supabase のシークレットにだけ置く)
  │      ▼
  │   Google Calendar API … 利用者が「すべての予定の詳細の変更や表示ができます」の権限で共有したカレンダーにだけ書ける
  └─ Supabase DB ……… マスタ・設定・勤務記録(本人の行しか読み書きできない)

cron-job.org ──(6時間ごと)──▶ Supabase の keepalive() … 無料プランの一時停止を防ぐ
```

- 利用者は社員番号+PINでログインする。新規登録は「共通パスワード」を知っている人だけ(管理者が決める)
- 管理画面には、最初の画面の「管理」タブから管理用パスワードで入る
- 利用者は、自分のカレンダーをサービスアカウントのメールアドレスと共有し、カレンダーIDを設定画面に入れる(休日用のカレンダーは、なくてもよい。空にすると「休日」の番号は登録されない。休みも勤務用に入れたいときは、休日用に勤務用と同じIDを入れる)
- Edge Function は、リクエストに書かれたカレンダーIDは使わず、ログイン中の本人が登録したIDだけを使う

## ファイル

```
web/                        画面(GitHub Pages で配信)
  index.html                最初の画面(利用者ログイン / 管理ログイン)
  register.html             新規登録
  settings.html             設定(区所・カレンダーID・接続テスト・PIN の変更)
  input.html                勤務入力
  admin.html                管理ダッシュボード
  help.html                 使い方(未ログインでも読める)
  js/config.js              Supabase の URL と公開キー(★自分の値を書く)
  js/plan.js                予定の組み立て(supabase/functions/_shared/plan.js と同じ内容)
supabase/
  migrations/*.sql          テーブル・RLS・SQL関数
  seed.sql, seed/*.csv      ローカル用の架空データ
  functions/                Edge Functions
    login/ sign-up/         社員番号+PINのログイン、新規登録
    admin-login/            管理用パスワードでのログイン
    admin-users/            利用者の削除、PIN の再設定(管理者だけ)
    change-pin/             自分のPINの変更
    app-config/             サービスアカウントのメールアドレスを返す
    verify-calendar/        接続テスト(テスト予定を書いてすぐ消す)
    register-month/         月の入力を保存してカレンダーに登録
    delete-month/           月のアプリの予定だけ削除
    sync-holidays/          祝日を取得して保存
    _shared/                共通処理とテスト
.github/workflows/          Pages への公開、Supabase への自動デプロイ、テスト
docs/DESIGN.md              設計
WORKLOG.md                  作業ログ
```

---

## セットアップ(はじめての人向け・ブラウザだけ)

所要時間は1時間ほどです。途中で出てくる値のうち、**サービスアカウントの鍵(JSON)、各種パスワード、アクセストークンは、リポジトリに絶対に書かないでください。**
画面に書いてよいのは、`web/js/config.js` に入れる Supabase の URL と公開用キーだけです。

必要なもの: Google アカウント、GitHub アカウント(このリポジトリを自分のアカウントに置いてあること)

Supabase・Google・GitHub の画面の名前は変わることがあります(2026年9月29日に Supabase の公式ドキュメントで確認した名前で書いています)。名前が違うときは、近い名前の項目を探してください。

以降、`<ユーザー名>` は GitHub のユーザー名、`<ref>` は Supabase のプロジェクト ID(`https://<ref>.supabase.co` の `<ref>`)です。

### 1. Supabase のプロジェクトを作る

1. https://supabase.com/ でアカウントを作り(GitHub でサインインできる)、「New project」
2. 名前(例: shiftflow)、データベースのパスワード(**控えておく**)、Region は **Northeast Asia (Tokyo)** を選んで作成
3. できたら、次を控える
   - Project URL(`https://<ref>.supabase.co`)と `<ref>`
   - 公開用キー: 左下の歯車(Project Settings)→「API Keys」の **publishable キー**(`sb_publishable_...`)または旧方式の **anon キー**(長い文字列)
   - ※ secret キー / service_role キーは使いません(どこにも貼らない)
4. 左メニュー「Authentication」→「Sign In / Providers」で
   - 「Allow new users to sign up」を **オフ**(ユーザーは新規登録の画面からだけ作るため)
   - 「Email」は有効のままにして、「Confirm email」は **オフ**

### 2. GitHub に、自動デプロイ用の3つの秘密の値を登録する

Supabase のトークンを作り、それを **GitHub の画面**(このリポジトリの Secrets)に登録します。登録すると、あなたが何もしなくても、push のたびに GitHub が Supabase へ自動で反映します。

**2-1. Supabase でトークンを作る**

Supabase の右上のアイコン →「Account Preferences」→「Access Tokens」→「Generate new token」で、トークンを作ってコピーする(この画面を閉じると二度と見られないので、次の 2-2 が終わるまで閉じない)

**2-2. GitHub に3つ登録する**

1. GitHub で、このリポジトリを開く
2. 上のタブの「Settings」→ 左メニューの「Secrets and variables」→「Actions」
3. 「New repository secret」を押し、次の3つを **1つずつ** 登録する(Name と Secret を入れて「Add secret」)

   | Name(そのまま入力) | Secret(貼り付ける値) |
   |---|---|
   | `SUPABASE_ACCESS_TOKEN` | 2-1 で作って、コピーしたトークン |
   | `SUPABASE_PROJECT_ID` | プロジェクトID `<ref>`(`https://<ref>.supabase.co` の `<ref>` の部分) |
   | `SUPABASE_DB_PASSWORD` | 1-2 でプロジェクトを作るときに決めたデータベースのパスワード |

### 3. Google Cloud: サービスアカウントを作る(カレンダーに書き込む役)

1. https://console.cloud.google.com/ を開き、上のプロジェクト選択 →「新しいプロジェクト」(例: shiftflow)を作って選ぶ
2. 「API とサービス」→「ライブラリ」→「Google Calendar API」を検索 →「有効にする」
3. 「IAM と管理」→「サービス アカウント」→「サービス アカウントを作成」
   - 名前: 例 `shiftflow-calendar`。ロールの付与は不要(スキップしてよい)
4. できたサービスアカウントを開き、「キー」→「鍵を追加」→「新しい鍵を作成」→「JSON」→ ダウンロード
   - この JSON ファイルが秘密鍵です。**リポジトリに入れない**(`.gitignore` でも除外しているが、念のため別の場所に保存)
   - 「鍵の作成が無効」と出る場合は、組織のポリシーで鍵の作成が禁止されています(個人の Google アカウントでは通常出ません)
5. サービスアカウントのメールアドレスは、ログイン後の設定画面・管理画面・使い方ページに自動で表示されるので、控えなくてよい

### 4. Supabase に、2つのシークレットを登録する

Supabase の左メニュー「Edge Functions」→「Secrets」(または「Project Settings」→「Edge Functions」)で、次の2つを追加する。

| Name | 値 |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | 3-4 でダウンロードした JSON ファイルを**メモ帳などで開き、中身を全部**貼り付ける |
| `ADMIN_PASSWORD` | 管理画面に入るパスワード(**12文字以上**。自分で決める) |

- 管理画面のパスワードを変えたいときは、ここの `ADMIN_PASSWORD` を書き換えます
- 登録した内容は、関数を再デプロイしなくてもすぐ使われます。手順6より前に登録しても大丈夫です

### 5. 画面を公開する(GitHub Pages)

1. [`web/js/config.js`](web/js/config.js) を、GitHub の画面で開いて鉛筆アイコンで編集し、2行を自分の値に書き換えて「Commit changes」(そのまま main にコミット)
   - `SUPABASE_URL` = `https://<ref>.supabase.co`
   - `SUPABASE_ANON_KEY` = 1-3 の公開用キー
   - どちらも公開してよい値です。**secret / service_role キーは書かない**
2. GitHub のリポジトリ →「Settings」→「Pages」→「Source」を **GitHub Actions** にする
3. 「Actions」タブで「GitHub Pages」が成功するのを待つ(失敗していたら「Re-run jobs」)
   - アプリの URL: `https://<ユーザー名>.github.io/shiftflow/`

### 6. データベースと Edge Functions を反映する

1. GitHub の「Actions」タブ →「Deploy Supabase」→「Run workflow」で、はじめの1回を手動で実行する
   - 緑になれば、テーブルの作成と、全部の関数のデプロイが済んでいます
   - 赤くなったら、ログを開いて、どの手順で止まったかを確認してください(多くは 2 の3つの値の間違いです)
2. これ以降は、`supabase/` を変えて main に push すると自動で反映されます

### 7. 最初の設定(管理画面)

1. アプリを開き、最初の画面の「管理」タブで、4 の `ADMIN_PASSWORD` を入れて入る
2. 「設定」タブで **共通パスワード** を決めて設定する(新規登録のときに、利用者が入れるパスワード。8文字以上)
3. 「マスタ登録」タブで **区所** を追加し、区所ごとに CSV を取り込む
   - 区所を選び、CSV を選ぶと、取り込む内容が表で出るので目で確認して「この内容で入れ替える」
   - 1行目: `番号,種別,平日出勤,平日退勤,休日出勤,休日退勤,泊`(「泊」列=泊地は無くてもよい)
   - 種別は `泊` / `日勤` / `休日`。時刻は `9:01` `09:01:00` `(9:01)` のどれでもよい(表では `9:01` の形で表示)
   - 種別の間違い・番号の重複・読めない時刻・泊/日勤の平日出勤が空、の行は赤くなり、直すまで取り込めない
   - 取り込んだマスタは「マスタ表」タブで確認でき、「CSVで保存」で書き出せる
   - 見本(架空データ): [`supabase/seed/shift_master.example.csv`](supabase/seed/shift_master.example.csv)
   - 実データの CSV はリポジトリに入れない(`.gitignore` で `*.csv` を除外済み)
4. 利用者に、アプリの URL・共通パスワード・「使い方」ページを伝える。利用者は「新規登録」から登録すれば、そのまま使える

### 8. データベースの停止対策(cron-job.org)

Supabase の無料プランは、1週間ほどデータベースが使われないと一時停止します。
[cron-job.org](https://cron-job.org/) で、6時間ごとにデータベースを読むよう登録します(GitHub のトークンは不要です)。

1. cron-job.org のアカウントを作り、「Create cronjob」
2. 管理画面の「設定」タブの「データベースの停止対策」に、登録する内容(URL とキー)が表示されているので、それを使う
   - URL: `https://<ref>.supabase.co/rest/v1/rpc/keepalive`
   - Schedule: 6時間ごと(Every 6 hours)
   - 「Advanced」→ Request method: **POST**、Headers: `apikey: <公開用キー>` と `Content-Type: application/json`、Request body: `{}`
3. 「Test run」で、結果が `200` で `{"ok":true,...}` と返ることを確認する

### 9. 動作確認

1. 自分で「新規登録」する(社員番号・名前・PIN・共通パスワード)
2. 設定画面で区所を選び、カレンダーを共有してIDを入れ、「保存して接続テスト」
3. 勤務入力で1〜2日だけ番号を入れて「登録」→ Googleカレンダーに終日予定が入り、タイトル・メモ(泊なら2行目に泊地)が合っているか確認
4. 「リセット」でその月の予定が消え、手で入れた予定は残ることを確認
5. 平/休の表示で祝日が「休」になっているか確認(祝日は Google の「日本の祝日」カレンダーから自動取得)
6. 管理画面で、利用者の一覧に自分が出ること、PIN 再設定・削除が動くことを確認

---

## 更新するとき

| 変えたもの | やること |
|---|---|
| `web/` | main にプッシュすれば自動で Pages に反映 |
| `supabase/functions/` | main にプッシュすれば自動でデプロイ |
| `supabase/migrations/` | **すでに反映したファイルは書き換えない**。変更は新しいファイル(例: `20261001000000_xxx.sql`)を足す。push すれば自動で反映 |
| マスタ | 管理画面で区所を選んで CSV を取り込み直す |

予定の組み立て(`supabase/functions/_shared/plan.js`)を変えたら、`web/js/plan.js` にも同じ内容をコピーしてください(テストで一致を確認しています)。

## テスト

Chromebook では「Linux 開発環境」をオンにすると、ターミナルでテストを動かせます(なくても使えます。テストは GitHub でも自動で動きます)。

```bash
# Deno(https://deno.com/)が必要
deno test --allow-read --allow-env supabase/functions
```

予定の組み立て、カレンダー操作(Google への通信は偽物)、ログイン・新規登録・管理者ログイン・ロック(Supabase は偽物)を確認します。

## 祝日について

- Google の公開カレンダー「日本の祝日」を、サービスアカウントで読んでデータベースに保存しています(年に1回程度しか取りに行きません。今年以降の分は30日ごとに取り直します)
- 取得できなかった年は、登録時にエラーになります(平/休を間違えたまま登録しないため)。そのときは、内閣府の「国民の祝日」の一覧を見て、Supabase の「SQL Editor」で手で入れられます

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
| 画面に「js/config.js に Supabase の URL とキーを設定してください」 | 5-1 の config.js |
| Actions の「Deploy Supabase」に警告が出て何もしない | 2 の3つの Secrets の登録 |
| 「Deploy Supabase」が赤い | ログで止まった手順を確認。`link` / `db push` なら 2 の値、`functions deploy` なら関数のエラー |
| 管理者ログインで「管理用パスワードが設定されていません」 | 4 の `ADMIN_PASSWORD`(12文字以上) |
| 管理者ログインで「パスワードが違います」/ ロックされた | `ADMIN_PASSWORD` の値。ロックは15分で解ける |
| 新規登録で「登録の受付をまだ開始していません」 | 7-2 の共通パスワードの設定 |
| 新規登録・管理者ログインで、Supabase 側のエラー(ユーザーを作れませんでした など) | 1-4 の設定(Email が有効か)。それでも直らなければ、1-4 の「Allow new users to sign up」を一度オンに戻して試す(オンでも、登録していない人は何も使えません)。関数のログ(下)も確認 |
| 利用者の PIN を忘れた | 管理画面の「利用者」で「PIN再設定」→ 仮のPINを本人に伝える |
| 設定画面で登録用アドレスが「取得できませんでした」 | 4 のシークレット `GOOGLE_SERVICE_ACCOUNT_JSON` と、関数のデプロイ |
| 接続テストで書き込めない | 使い方ページ「6. 接続テスト」の対処。Google Calendar API を有効にしたか(3-2) |
| 「○年の祝日を取得できませんでした」 | 3-2 の API 有効化。直らなければ上の「祝日について」の手動登録 |
| 関数のログを見たい | Supabase の「Edge Functions」→ 関数名 →「Logs」 |

## セキュリティ・個人情報

- 秘密の値(サービスアカウントの鍵、管理用パスワード、共通パスワード、アクセストークン)は Supabase / GitHub / Google Cloud の画面にだけ置き、リポジトリに入れない。項目名は [`.env.example`](.env.example) を参照
- すべてのテーブルで RLS を有効にしています。勤務記録と設定は本人だけ(管理者にも見えません)、区所とマスタは全員が読むだけ(書くのは管理者)
- 社員番号と名前は Supabase のデータベースにだけ保存し、リポジトリには含めません。氏名・勤務先・マスタの実データ・カレンダーIDも同様です
- ログインの失敗が5回続くと、その社員番号は15分ロックされます(管理者ログイン・新規登録の共通パスワードも同様)
- PIN は暗号化して保存されます。社員番号は職場で知られていることが多いので、PIN は他人に教えないでください
- 同じカレンダーIDは1人しか使えません。メインのカレンダー(ID=メールアドレス)は使えません
- Supabase の無料プランは、1週間ほど使われないとプロジェクトが一時停止します(8 の対策をしていれば止まりません)。停止したらダッシュボードから再開できます

## 課金について

今は課金の機能はありません。将来、有料にするときのために、利用者ごとの「プラン」の欄(`profiles.plan`、今は全員 `free`)だけ用意してあります。

## 更新してもデータが消えないために(直す人向けのメモ)

- 画面(`web/`)と関数(`supabase/functions/`)を直して push しても、データベースの中身(利用者・設定・勤務の記録・マスタ)は変わりません。自動デプロイは、コードを入れ替えるだけです
- データベースの形を変えるときは、`supabase/migrations/` に**新しいファイルを足す**だけにします。反映済みのファイル(`20260929000000_init.sql` など)は**書き換えない**(自動デプロイは、まだ反映していないファイルだけを実行するので、書き換えても反映されず、記録と食い違います)
- 列や表を消す(`drop`)・全部消す(`truncate`)ような変更は、先にマスタ CSV を書き出し、影響する範囲を確かめてから行う
- 無料プランには、自動のバックアップがありません。マスタは、管理画面の「CSVで保存」で、ときどき書き出しておくと安心です(利用者の勤務入力は、カレンダーに登録済みの予定が残るので、最悪の場合も入力し直せます)
