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
$P -d t -f "$(dirname "$0")/db_stub.sql"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
for f in "$ROOT"/supabase/migrations/*.sql; do
  $P -d t -f "$f" 2>&1 | grep -v "^NOTICE\|^psql.*NOTICE" || true
  echo "applied $(basename $f)"
done
