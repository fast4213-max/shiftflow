-- migration を全部当てたあとの確認(CI でも動かす。失敗すると、どこがおかしいかを出して止まる)
--   psql -v ON_ERROR_STOP=1 -f docs/contact/test/db_assert.sql
-- 権限・RLS の設計(問い合わせは画面から直接読めない。未ログインで呼べる関数は決まったものだけ)が、
-- あとから足した migration で崩れていないかを確かめる。

do $$
declare
  t text;
  f text;
begin
  -- 問い合わせまわりの表: 未ログイン・利用者(authenticated)は一切読めない・書けない
  foreach t in array array['inquiries', 'inquiry_messages', 'discord_posts', 'rate_limits', 'app_status', 'app_secrets', 'auth_attempts'] loop
    assert not has_table_privilege('anon', 'public.' || t, 'select, insert, update, delete'), 'anon が ' || t || ' を触れる';
    assert not has_table_privilege('authenticated', 'public.' || t, 'select, insert, update, delete'), 'authenticated が ' || t || ' を触れる';
    assert has_table_privilege('service_role', 'public.' || t, 'select, insert, update, delete'), 'service_role が ' || t || ' を触れない';
    assert (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass), t || ' の RLS が無効';
  end loop;
  -- お知らせ・その他の表: RLS が有効で、未ログインは読めない
  foreach t in array array['notices', 'profiles', 'offices', 'shift_master', 'user_settings', 'shift_records'] loop
    assert (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass), t || ' の RLS が無効';
    assert not has_table_privilege('anon', 'public.' || t, 'select'), 'anon が ' || t || ' を読める';
  end loop;
  -- 未ログイン(anon)が実行できる public の関数は、これだけ
  assert (select coalesce(string_agg(p.proname, ',' order by p.proname), '')
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute'))
         = 'contact_offices,current_notices,keepalive',
         'anon が実行できる関数が想定と違う: ' || (select string_agg(p.proname, ',') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute'));
  -- サーバー専用の関数は、authenticated が実行できない
  foreach f in array array['create_inquiry(jsonb)', 'rate_limit_hit(text,integer,integer)', 'purge_old_contact()', 'purge_old_auth_attempts()',
                           'purge_old_shift_records()', 'revoke_user_sessions(uuid,uuid)', 'check_signup_password(text)', 'auth_attempt_fail(text,integer,integer)'] loop
    assert not has_function_privilege('authenticated', ('public.' || f)::regprocedure, 'execute'), 'authenticated が ' || f || ' を実行できる';
    assert not has_function_privilege('anon', ('public.' || f)::regprocedure, 'execute'), 'anon が ' || f || ' を実行できる';
    assert has_function_privilege('service_role', ('public.' || f)::regprocedure, 'execute') or f in ('purge_old_auth_attempts()', 'purge_old_shift_records()'),
           'service_role が ' || f || ' を実行できない';
  end loop;
  -- 利用者が書ける user_settings の列は、決めたものだけ(登録の途中の印 next_first_pending・検証済みは書けない)
  assert not has_column_privilege('authenticated', 'public.user_settings', 'next_first_pending', 'update'), '利用者が next_first_pending を書ける';
  assert not has_column_privilege('authenticated', 'public.user_settings', 'verified_at', 'update'), '利用者が verified_at を書ける';
  assert has_column_privilege('authenticated', 'public.user_settings', 'work_calendar_id', 'update'), '利用者が work_calendar_id を書けない';
end
$$;

-- 動き: お知らせの期間(日本時間)・二重送信・回数制限・古いものの削除
do $$
declare
  today date := (now() at time zone 'Asia/Tokyo')::date;
  r jsonb;
  ok boolean;
begin
  insert into public.notices (title, starts_on, ends_on) values
    ('今日まで', today - 2, today), ('昨日まで', today - 2, today - 1), ('明日から', today + 1, null), ('ずっと', today - 5, null);
  assert (select count(*) from jsonb_array_elements(public.current_notices())) = 2, 'お知らせの期間が想定と違う';
  assert not exists (select 1 from jsonb_array_elements(public.current_notices()) x where x->>'title' in ('昨日まで', '明日から')), '期間外のお知らせが出る';

  r := public.create_inquiry('{"request_key":"aaaaaaaa-0000-4000-8000-000000000001","logged_in":false,"employee_no":"1234567","name":"x","office_name":"y","kind":"login","reply_via":"screen","body":"b"}');
  assert (r->>'duplicate')::boolean = false, '最初の送信が重複扱い';
  r := public.create_inquiry('{"request_key":"aaaaaaaa-0000-4000-8000-000000000001","logged_in":false,"employee_no":"1234567","name":"x","office_name":"y","kind":"login","reply_via":"screen","body":"b"}');
  assert (r->>'duplicate')::boolean = true, '同じ request_key が重複扱いにならない';
  assert (select count(*) from public.inquiries) = 1 and (select count(*) from public.inquiry_messages) = 1, '二重に作られた';

  ok := true;
  for i in 1..5 loop ok := public.rate_limit_hit('ci-test', 3, 60); end loop;
  assert ok = false, '回数制限が効かない';

  update public.inquiries set last_activity_at = now() - interval '91 days';
  perform public.purge_old_contact();
  assert (select count(*) from public.inquiries) = 0, '90日たった問い合わせが消えない';
end
$$;

select 'db_assert: all ok' as result;
