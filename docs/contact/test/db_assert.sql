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
  assert has_column_privilege('authenticated', 'public.user_settings', 'offduty_calendar_id', 'update'), '利用者が offduty_calendar_id を書けない';
  assert has_column_privilege('authenticated', 'public.user_settings', 'split_offduty_events', 'update'), '利用者が split_offduty_events を書けない';
  assert has_column_privilege('authenticated', 'public.user_settings', 'title_day_time', 'update'), '利用者が title_day_time を書けない';
  assert has_column_privilege('authenticated', 'public.user_settings', 'title_offduty_time', 'update'), '利用者が title_offduty_time を書けない';
  assert has_column_privilege('authenticated', 'public.user_settings', 'timed_events', 'update'), '利用者が timed_events を書けない';
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

-- 動き: アドレスを消すとき(対応済みから30日)、こちらの返事の行の送り先(from_email)も消える。
-- 受信メール(sender = mail)の差出人は、アドレスを消したあとの返信に使うので残る(DESIGN.md A4)。mismatch 列がある(W11・W12)
do $$
declare
  a bigint;
  b bigint;
begin
  assert exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'inquiry_messages' and column_name = 'mismatch'),
         'inquiry_messages.mismatch が無い';
  -- 30日以上前に対応済み(消える) / 29日前に対応済み(まだ残る)
  insert into public.inquiries (request_key, logged_in, employee_no, name, office_name, kind, reply_via, email, status, done_at, last_activity_at)
    values ('bbbbbbbb-0000-4000-8000-000000000001', false, '1234567', 'x', 'y', 'login', 'mail', 'old@example.com', 'done', now() - interval '31 days', now() - interval '31 days')
    returning id into a;
  insert into public.inquiries (request_key, logged_in, employee_no, name, office_name, kind, reply_via, email, status, done_at, last_activity_at)
    values ('bbbbbbbb-0000-4000-8000-000000000002', false, '1234567', 'x', 'y', 'login', 'mail', 'new@example.com', 'done', now() - interval '29 days', now() - interval '29 days')
    returning id into b;
  insert into public.inquiry_messages (inquiry_id, sender, channel, body, from_email) values
    (a, 'admin', 'mail', 'r', 'old@example.com'), (a, 'mail', 'mail', 'm', 'old@example.com'),
    (b, 'admin', 'mail', 'r', 'new@example.com');
  perform public.purge_old_contact();
  assert (select email from public.inquiries where id = a) is null, '30日たったアドレスが消えない';
  assert (select from_email from public.inquiry_messages where inquiry_id = a and sender = 'admin') is null, '返事の行の送り先が消えない';
  assert (select from_email from public.inquiry_messages where inquiry_id = a and sender = 'mail') = 'old@example.com', '受信メールの差出人まで消えた';
  assert (select email from public.inquiries where id = b) = 'new@example.com', '29日のアドレスが消えた';
  assert (select from_email from public.inquiry_messages where inquiry_id = b and sender = 'admin') = 'new@example.com', '29日の返事の送り先が消えた';
  -- アドレスを消したあとに送った返事の行も、次の回に消える
  insert into public.inquiry_messages (inquiry_id, sender, channel, body, from_email) values (a, 'admin', 'mail', 'late', 'thread@example.com');
  perform public.purge_old_contact();
  assert (select count(*) from public.inquiry_messages where inquiry_id = a and sender = 'admin' and from_email is not null) = 0, 'あとの返事の送り先が消えない';
  -- 関数の権限は作り直したあとも元のまま
  assert not has_function_privilege('authenticated', 'public.purge_old_contact()', 'execute'), 'purge_old_contact を authenticated が実行できる';
  assert not has_function_privilege('anon', 'public.purge_old_contact()', 'execute'), 'purge_old_contact を anon が実行できる';
  delete from public.inquiries where id in (a, b);
end
$$;

-- マスタの切替(ダイヤ改正・ダイヤ修正): 切替日の表の権限、管理者の関数(作る・変える・消す・CSV の入れ替え)、区所の追加
do $$
declare
  admin_id uuid := 'cccccccc-0000-4000-8000-000000000001';
  office bigint;
  base bigint;
  nxt bigint;
  today date := (now() at time zone 'Asia/Tokyo')::date;
  failed boolean;
begin
  assert (select relrowsecurity from pg_class where oid = 'public.master_periods'::regclass), 'master_periods の RLS が無効';
  assert not has_table_privilege('anon', 'public.master_periods', 'select'), 'anon が master_periods を読める';
  assert not has_table_privilege('authenticated', 'public.master_periods', 'insert, update, delete'), 'authenticated が master_periods を書ける';
  assert has_table_privilege('authenticated', 'public.master_periods', 'select'), 'authenticated が master_periods を読めない';
  assert not has_function_privilege('authenticated', 'public.purge_old_master_periods()', 'execute'), 'authenticated が purge_old_master_periods を実行できる';
  assert has_function_privilege('authenticated', 'public.save_master_period(bigint,bigint,date,text)', 'execute'), 'save_master_period を実行できない';

  -- 区所を足すと、切替日が1つできる
  insert into public.offices (name, sort_order) values ('切替テスト区', 999) returning id into office;
  select id into base from public.master_periods where office_id = office;
  assert base is not null, '区所を足しても切替日ができない';
  -- 管理者でないと作れない
  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  failed := false;
  begin
    perform public.save_master_period(office, null, today + 30, 'ダイヤ改正');
  exception when others then failed := true;
  end;
  assert failed, '管理者でなくても切替日を作れる';
  insert into auth.users (id) values (admin_id);
  insert into public.profiles (user_id, role) values (admin_id, 'admin');
  -- いちばん古いマスタより前・今月より前の切替日は作れない。同じ日も作れない
  failed := false;
  begin
    perform public.save_master_period(office, null, (date_trunc('month', today) - interval '1 day')::date, '');
  exception when others then failed := true;
  end;
  assert failed, '今月より前の切替日を作れる';
  nxt := public.save_master_period(office, null, today + 30, 'ダイヤ改正');
  failed := false;
  begin
    perform public.save_master_period(office, null, today + 30, '');
  exception when others then failed := true;
  end;
  assert failed, '同じ日の切替日を2つ作れる';
  -- いちばん古いマスタの日は、次の切替日より前にだけ変えられる
  failed := false;
  begin
    perform public.save_master_period(office, base, today + 40, '');
  exception when others then failed := true;
  end;
  assert failed, 'いちばん古いマスタの日を、次の切替日より後にできる';
  perform public.save_master_period(office, base, date '2026-10-03', 'ダイヤ修正');
  -- CSV の入れ替えは切替日ごと。前のマスタは消えない
  perform public.replace_shift_master(office, base, '[{"code":"1","kind":"泊","weekday_start":"9:00"}]'::jsonb);
  perform public.replace_shift_master(office, nxt, '[{"code":"1","kind":"泊","weekday_start":"10:00"},{"code":"2","kind":"日勤","weekday_start":"8:00"}]'::jsonb);
  assert (select count(*) from public.shift_master where period_id = base) = 1, '前のマスタが消えた';
  assert (select count(*) from public.shift_master where period_id = nxt) = 2, '次のマスタが入らない';
  assert public.master_period_on(office, today) = base, '今日のマスタが違う';
  assert public.master_period_on(office, today + 30) = nxt, '切替日のマスタが違う';
  assert public.master_period_on(office, date '2000-01-01') = base, '切替日より前の日に、いちばん古いマスタを使わない';
  assert (select (o ->> 'master_count')::int from jsonb_array_elements(public.admin_stats() -> 'offices') o where (o ->> 'id')::bigint = office) = 1,
         '概要の件数が今日のマスタの件数でない';
  -- もう使っている(いちばん古い)マスタは消せない。まだ始まっていないものは消せて、行も消える
  failed := false;
  begin
    perform public.delete_master_period(base);
  exception when others then failed := true;
  end;
  assert failed, '使っているマスタを消せる';
  perform public.delete_master_period(nxt);
  assert not exists (select 1 from public.shift_master where period_id = nxt), '消した切替日の行が残る';

  -- 古い切替日の自動削除: 次の切替日が前月の1日より前なら消える
  --   2000-01-01 は次(2001-01-01)が前月の1日より前なので消える。2001-01-01 は次(base)が今月なので、前月の記録のために残す
  insert into public.master_periods (office_id, starts_on, name) values (office, date '2000-01-01', '古い'), (office, date '2001-01-01', '前');
  update public.master_periods set starts_on = date_trunc('month', today)::date where id = base;
  perform public.purge_old_master_periods();
  assert not exists (select 1 from public.master_periods where office_id = office and starts_on = date '2000-01-01'), '古い切替日が消えない';
  assert exists (select 1 from public.master_periods where office_id = office and starts_on = date '2001-01-01'), '前月に使う切替日が消えた';
  assert exists (select 1 from public.master_periods where id = base), '使っている切替日が消えた';

  delete from public.offices where id = office;
  delete from public.profiles where user_id = admin_id;
  delete from auth.users where id = admin_id;
  perform set_config('request.jwt.claim.sub', '', true);
end
$$;

-- マスタの切替日を全部の区所にまとめて作る・直す・消す。1つの区所で失敗したら、どの区所も変えない
do $$
declare
  admin_id uuid := 'cccccccc-0000-4000-8000-000000000002';
  a bigint;
  b bigint;
  today date := (now() at time zone 'Asia/Tokyo')::date;
  d1 date := (now() at time zone 'Asia/Tokyo')::date + 40;
  d2 date := (now() at time zone 'Asia/Tokyo')::date + 41;
  failed boolean;
  n int;
begin
  assert not has_function_privilege('anon', 'public.save_master_period_all(date,date,text)', 'execute'), 'anon が save_master_period_all を実行できる';
  insert into public.offices (name, sort_order) values ('まとめA区', 998) returning id into a;
  insert into public.offices (name, sort_order) values ('まとめB区', 999) returning id into b;
  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  failed := false;
  begin
    perform public.save_master_period_all(null, d1, 'ダイヤ改正');
  exception when others then failed := true;
  end;
  assert failed, '管理者でなくても、まとめて作れる';
  insert into auth.users (id) values (admin_id);
  insert into public.profiles (user_id, role) values (admin_id, 'admin');
  -- ほかのテストの区所が残っていてもよいよう、数は2つ以上で見る
  n := public.save_master_period_all(null, d1, 'ダイヤ改正');
  assert n >= 2, 'まとめて作った区所の数が違う';
  assert (select count(*) from public.master_periods where office_id in (a, b) and starts_on = d1 and name = 'ダイヤ改正') = 2, 'まとめて作れない';
  -- もうある区所は、名前だけ直す(2つにならない)
  perform public.save_master_period_all(null, d1, 'ダイヤ修正');
  assert (select count(*) from public.master_periods where office_id = a and starts_on = d1) = 1, '同じ日の切替日が2つになった';
  assert (select name from public.master_periods where office_id = b and starts_on = d1) = 'ダイヤ修正', '名前が直らない';
  -- まとめて直す
  perform public.save_master_period_all(d1, d2, 'ダイヤ改正');
  assert (select count(*) from public.master_periods where office_id in (a, b) and starts_on = d2) = 2, 'まとめて直せない';
  assert not exists (select 1 from public.master_periods where office_id in (a, b) and starts_on = d1), '前の切替日が残る';
  -- B区だけ、いちばん古いマスタを d2 より後にする → 全部の区所に d1 を作ろうとすると B区で失敗し、A区にも作られない
  delete from public.master_periods where office_id = b and starts_on = d2;
  update public.master_periods set starts_on = today + 60 where office_id = b;
  failed := false;
  begin
    perform public.save_master_period_all(null, d1, 'ダイヤ改正');
  exception when others then
    failed := true;
    assert sqlerrm like 'まとめB区: %', '失敗した区所の名前が出ない: ' || sqlerrm;
  end;
  assert failed, 'B区で失敗しない';
  assert not exists (select 1 from public.master_periods where office_id = a and starts_on = d1), '失敗したのに A区に作られた';
  -- まとめて消す(まだ始まっていないものだけ)
  n := public.delete_master_period_all(d2);
  assert n = 1 and not exists (select 1 from public.master_periods where starts_on = d2 and office_id in (a, b)), 'まとめて消せない';
  assert (select count(*) from public.master_periods where office_id in (a, b)) = 2, 'いちばん古いマスタまで消えた';

  delete from public.offices where id in (a, b);
  delete from public.profiles where user_id = admin_id;
  delete from auth.users where id = admin_id;
  perform set_config('request.jwt.claim.sub', '', true);
end
$$;

select 'db_assert: all ok' as result;
