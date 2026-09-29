// Supabase の接続先。
// URL と anon(publishable)キーは公開してよい値(データは RLS で守られる)なので、ここに書いてコミットしてよい。
// service_role キー / secret キーは絶対にここに書かない。
//
// 値は Supabase ダッシュボードの Project Settings → API Keys(または Data API)で確認できる。
export const SUPABASE_URL = "https://YOUR-PROJECT-REF.supabase.co";
export const SUPABASE_ANON_KEY = "YOUR-ANON-OR-PUBLISHABLE-KEY";
