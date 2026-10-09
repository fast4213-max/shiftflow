// Supabase の接続先。
// URL と anon(publishable)キーは公開してよい値(データは RLS で守られる)なので、ここに書いてコミットしてよい。
// service_role キー / secret キーは絶対にここに書かない。
//
// 値は Supabase ダッシュボードの Project Settings → API Keys(または Data API)で確認できる。
export const SUPABASE_URL = "https://owotkyocoslifbgwwafm.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_lXsY5lPSX-OIS1BTyGdn3Q_EaIE81vi";

// Supabase のアクセストークン(GitHub の自動デプロイ用)の期限。管理画面の「設定」に出す。
// 期限が切れるとデプロイだけ止まる(動いているアプリは止まらない)。新しく作ったら日付を書き換える。
// 日付だけで秘密ではないので、書いてコミットしてよい。
export const TOKEN_EXPIRES = "2027-09-29";

// お問い合わせの返事を送る専用の Gmail(迷惑メールの注意に表示する。利用者に見せるアドレスなので秘密ではない)
export const CONTACT_EMAIL = "shiftflow.kinmu@gmail.com";

// 「Googleでカレンダーを自動で作る」(設定画面)の OAuth クライアント ID(ウェブアプリ用)。
// 公開してよい値(秘密のクライアントシークレットは使わない)。空なら、設定画面にこの機能は出ない。
// 試験のあいだは、設定画面の URL の最後に ?beta=1 を付けた人にだけ出す(calendar-setup.js)。
// Google Cloud の「Google Auth Platform」→「クライアント」で作る。承認済みの JavaScript の生成元に
// このサイトの URL(https://fast4213-max.github.io)を入れる。権限は calendar.app.created だけ。
export const GOOGLE_CLIENT_ID = "3902891064-58j74ft9p5uceierkfopksumfdp34l3v.apps.googleusercontent.com";
