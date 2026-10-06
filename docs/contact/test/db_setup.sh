#!/bin/bash
# ローカル PostgreSQL 16 を作り直して、Supabase 風の土台(役割・auth スキーマ)と全 migration を当てる
# 使い方: sudo bash docs/contact/test/db_setup.sh → psql -h /tmp/sfpg/sock -p 54329 -U postgres -d t -f docs/contact/test/db_test.sql
set -e
SP=/tmp/sfpg
BIN=/usr/lib/postgresql/16/bin
pkill -f "$SP/data" 2>/dev/null || true; sleep 1
rm -rf $SP/data; mkdir -p $SP/data $SP/sock; chown -R postgres $SP
su postgres -c "$BIN/initdb -D $SP/data -A trust -U postgres >/dev/null"
su postgres -c "$BIN/pg_ctl -D $SP/data -o '-k $SP/sock -p 54329 -c listen_addresses=' -l $SP/log.txt start >/dev/null"
sleep 2
P="psql -h $SP/sock -p 54329 -U postgres -v ON_ERROR_STOP=1 -q"
$P -d postgres -c "create database t"
$P -d t <<'SQL'
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
SQL
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
for f in "$ROOT"/supabase/migrations/*.sql; do
  $P -d t -f "$f" 2>&1 | grep -v "^NOTICE\|^psql.*NOTICE" || true
  echo "applied $(basename $f)"
done
