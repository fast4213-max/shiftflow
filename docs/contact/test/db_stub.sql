-- ローカル・CI の PostgreSQL に、Supabase 風の土台(役割・auth スキーマ)を作る。migration を当てる前に流す
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key, email text, last_sign_in_at timestamptz);
create table auth.sessions (id uuid primary key, user_id uuid references auth.users(id) on delete cascade);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
-- Supabase の初期設定と同じく、新しい表・関数に自動で権限が付くようにしておく(外し忘れを見つけるため)
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
