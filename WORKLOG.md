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
