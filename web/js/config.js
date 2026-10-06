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
