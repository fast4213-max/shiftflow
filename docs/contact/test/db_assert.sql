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
  foreach t in array array['notices', 'guide_links', 'profiles', 'offices', 'shift_master', 'user_settings', 'shift_records'] loop
    assert (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass), t || ' の RLS が無効';
    assert not has_table_privilege('anon', 'public.' || t, 'select'), 'anon が ' || t || ' を読める';
  end loop;
  -- 未ログイン(anon)が実行できる public の関数は、これだけ
  assert (select coalesce(string_agg(p.proname, ',' order by p.proname), '')
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute'))
         = 'contact_offices,current_guide_links,current_notices,keepalive',
         'anon が実行できる関数が想定と違う: ' || (select string_agg(p.proname, ',') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute'));
  -- サーバー専用の関数は、authenticated が実行できない
  foreach f in array array['create_inquiry(jsonb)', 'rate_limit_hit(text,integer,integer)', 'purge_old_contact()', 'purge_old_auth_attempts()',
                           'purge_old_shift_records()', 'revoke_user_sessions(uuid,uuid)', 'check_signup_password(text)', 'auth_attempt_fail(text,integer,integer)',
                           'auth_attempt_fail_window(text,integer,integer,integer)'] loop
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
  assert has_column_privilege('authenticated', 'public.user_settings', 'google_sync', 'update'), '利用者が google_sync を書けない';
  assert has_column_privilege('authenticated', 'public.user_settings', 'google_sync', 'insert'), '利用者が google_sync を入れられない';
  -- 値が付かない行(画面を更新していない人・古い登録)は「Googleにも登録する」(true)になる
  assert (select column_default from information_schema.columns
           where table_schema = 'public' and table_name = 'user_settings' and column_name = 'google_sync') = 'true',
    'google_sync の初期値が true でない';
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

  -- ログインの失敗を長い期間で数える(AD1): 前の失敗から期間内なら続けて数え、空いたら数え直す。上限でロック
  delete from public.auth_attempts where key = 'emp-day:test';
  for i in 1..2 loop
    assert public.auth_attempt_fail_window('emp-day:test', 3, 60, 1440) is null, '上限より前にロックする';
  end loop;
  update public.auth_attempts set updated_at = now() - interval '61 minutes' where key = 'emp-day:test';
  assert public.auth_attempt_fail_window('emp-day:test', 3, 60, 1440) is null, '期間が空いたのに数え直さない';
  assert (select failed_count from public.auth_attempts where key = 'emp-day:test') = 1, '期間が空いたのに数え直さない(回数)';
  perform public.auth_attempt_fail_window('emp-day:test', 3, 60, 1440);
  assert public.auth_attempt_fail_window('emp-day:test', 3, 60, 1440) > now() + interval '23 hours', '上限で長くロックしない';
  assert public.auth_attempt_locked_until('emp-day:test') is not null, 'ロック中にならない';
  delete from public.auth_attempts where key = 'emp-day:test';

  -- 使い方リンク: 表示するものだけ並び順どおり。https 以外・10件超は DB が止める。並べ替えは端で動かない
  insert into public.guide_links (label, url, sort_order, visible) values
    ('二番目', 'https://example.com/b', 2, true), ('一番目', 'https://example.com/a', 1, true), ('隠す', 'https://example.com/c', 3, false);
  assert (select string_agg(x->>'label', ',' order by ord) from jsonb_array_elements(public.current_guide_links()) with ordinality t(x, ord)) = '一番目,二番目', '使い方リンクの並び・表示が想定と違う';
  begin
    insert into public.guide_links (label, url) values ('x', 'http://example.com');
    assert false, 'http のリンクが入る';
  exception when check_violation then null; end;
  begin
    insert into public.guide_links (label, url) values ('x', 'javascript:alert(1)');
    assert false, 'javascript: のリンクが入る';
  exception when check_violation then null; end;
  begin
    insert into public.guide_links (label, url) values ('x', 'https://example.com/a b');
    assert false, '空白入りのリンクが入る';
  exception when check_violation then null; end;
  begin
    insert into public.guide_links (label, url) values ('', 'https://example.com/a');
    assert false, '空の表示名が入る';
  exception when check_violation then null; end;
  begin
    insert into public.guide_links (label, url) values (repeat('あ', 21), 'https://example.com/a');
    assert false, '21文字の表示名が入る';
  exception when check_violation then null; end;
  begin
    insert into public.guide_links (label, url, kind) values ('x', 'https://example.com/a', 'movie');
    assert false, '知らない種類が入る';
  exception when check_violation then null; end;
  insert into public.guide_links (label, url) select 'n' || g, 'https://example.com/' || g from generate_series(1, 7) g;
  begin
    insert into public.guide_links (label, url) values ('11件目', 'https://example.com/z');
    assert false, '11件目が入る';
  exception when raise_exception then null; end;
  assert not has_function_privilege('anon', 'public.move_guide_link(bigint,int)', 'execute'), 'anon が move_guide_link を実行できる';
  assert not has_table_privilege('anon', 'public.guide_links', 'select'), 'anon が guide_links を読める';
  delete from public.guide_links;

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

  -- 古い切替日の自動削除: 次の切替日が13か月前の月の1日以前なら消える
  --   2000-01-01 は次(2001-01-01)が13か月前より前なので消える。2001-01-01 は次(base)が今月なので、1年分の記録のために残す
  insert into public.master_periods (office_id, starts_on, name) values (office, date '2000-01-01', '古い'), (office, date '2001-01-01', '前');
  -- 次の切替日に行があるときだけ前を消す(AB10)
  insert into public.shift_master (office_id, period_id, code, kind)
    select office, id, '1', '泊' from public.master_periods where office_id = office and starts_on = date '2001-01-01';
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

-- 20回目のデバッグの直し(AB10〜AB13・AB16)
do $$
declare
  admin_id uuid := 'cccccccc-0000-4000-8000-000000000003';
  uid uuid := 'cccccccc-0000-4000-8000-000000000004';
  a bigint;
  c bigint;
  base bigint;
  started bigint;
  today date := (now() at time zone 'Asia/Tokyo')::date;
  first_of_month date := date_trunc('month', (now() at time zone 'Asia/Tokyo')::date)::date;
  failed boolean;
begin
  insert into auth.users (id) values (admin_id), (uid);
  insert into public.profiles (user_id, role) values (admin_id, 'admin');
  insert into public.profiles (user_id, employee_no, family_name, given_name) values (uid, '7654321', '試', '験');
  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  insert into public.offices (name, sort_order) values ('直しA区', 997) returning id into a;
  select id into base from public.master_periods where office_id = a;
  update public.master_periods set starts_on = date '2000-01-01' where id = base;
  insert into public.shift_master (office_id, period_id, code, kind) values (a, base, '1', '泊');

  -- AB10: 次の切替日が前月の1日より前でも、次の切替日に行が無ければ、前のマスタは消さない
  insert into public.master_periods (office_id, starts_on, name) values (a, date '2001-01-01', '空') returning id into started;
  perform public.purge_old_master_periods();
  assert exists (select 1 from public.master_periods where id = base), '次が空なのに、中身のある前のマスタが消えた';
  insert into public.shift_master (office_id, period_id, code, kind) values (a, started, '1', '泊');
  perform public.purge_old_master_periods();
  assert not exists (select 1 from public.master_periods where id = base), '次に行があるのに、前のマスタが消えない';

  -- AB11: 始まった切替日(いちばん古いもの以外)も、名前だけなら直せる。日付を今月より前に動かすのは断る
  insert into public.master_periods (office_id, starts_on, name) values (a, first_of_month - 20, '先月') returning id into started;
  perform public.save_master_period(a, started, first_of_month - 20, 'ダイヤ改正');
  assert (select name from public.master_periods where id = started) = 'ダイヤ改正', '名前だけ直せない';
  failed := false;
  begin
    perform public.save_master_period(a, started, first_of_month - 21, 'ダイヤ改正');
  exception when others then failed := true;
  end;
  assert failed, '始まった切替日を今月より前の日に動かせる';

  -- AB16: まとめて直す・消すで、対象が無ければエラー
  failed := false;
  begin
    perform public.save_master_period_all(today + 400, today + 401, '');
  exception when others then failed := sqlerrm like 'その切替日のマスタが見つかりません%';
  end;
  assert failed, 'まとめて直す対象が無いのに成功する';
  failed := false;
  begin
    perform public.delete_master_period_all(today + 400);
  exception when others then failed := sqlerrm like 'その切替日のマスタが見つかりません%';
  end;
  assert failed, 'まとめて消す対象が無いのに成功する';

  -- AB13: 区所を足すと、ほかの区所にあるこれからの切替日も作られる
  insert into public.master_periods (office_id, starts_on, name) values (a, today + 30, 'ダイヤ改正');
  insert into public.offices (name, sort_order) values ('直しC区', 998) returning id into c;
  assert exists (select 1 from public.master_periods where office_id = c and starts_on = today + 30 and name = 'ダイヤ改正'), '新しい区所に、これからの切替日が無い';
  assert exists (select 1 from public.master_periods where office_id = c and starts_on = today), '新しい区所に、今日からのマスタが無い';
  assert (select count(*) from public.master_periods where office_id = c) = 2, '新しい区所の切替日の数が違う';

  -- AB12: 登録し直しが要る人数(その日の前日から。区所を選ばなければ全部の区所)
  insert into public.user_settings (user_id, office_id) values (uid, a);
  insert into public.shift_records (user_id, date, code, memo) values (uid, today + 29, '1', '');
  assert public.master_affected_users(a, today + 30) = 1, '前日の勤務を数えない';
  assert public.master_affected_users(null, today + 30) >= 1, '全部の区所で数えない';
  assert public.master_affected_users(c, today + 30) = 0, 'ほかの区所の人を数える';
  assert public.master_affected_users(a, today + 31) = 0, '2日前の勤務を数える';
  assert not has_function_privilege('anon', 'public.master_affected_users(bigint,date)', 'execute'), 'anon が master_affected_users を実行できる';

  -- 使い方リンクの並べ替え(管理者): 動かす・端では動かない・同じ数字や抜けがあっても 1,2,3… に直る
  declare g1 bigint; g2 bigint; g3 bigint;
  begin
    insert into public.guide_links (label, url, sort_order) values ('g1', 'https://example.com/1', 5) returning id into g1;
    insert into public.guide_links (label, url, sort_order) values ('g2', 'https://example.com/2', 5) returning id into g2;
    insert into public.guide_links (label, url, sort_order) values ('g3', 'https://example.com/3', 9) returning id into g3;
    perform public.move_guide_link(g1, -1); -- 先頭は動かない(振り直しだけ)
    assert (select string_agg(label, ',' order by sort_order) from public.guide_links) = 'g1,g2,g3', '先頭を上へで並びが変わる';
    assert (select string_agg(sort_order::text, ',' order by sort_order) from public.guide_links) = '1,2,3', '並びが 1,2,3 に直らない';
    perform public.move_guide_link(g1, 1);
    assert (select string_agg(label, ',' order by sort_order) from public.guide_links) = 'g2,g1,g3', '下へ動かない';
    perform public.move_guide_link(g3, 1); -- 末尾は動かない
    assert (select string_agg(label, ',' order by sort_order) from public.guide_links) = 'g2,g1,g3', '末尾を下へで並びが変わる';
    begin
      perform public.move_guide_link(-1, 1);
      assert false, '無いリンクを動かせる';
    exception when raise_exception then null; end;
    delete from public.guide_links;
  end;

  delete from public.shift_records r where r.user_id = uid;
  delete from public.user_settings s where s.user_id = uid;
  delete from public.offices where id in (a, c);
  delete from public.profiles p where p.user_id in (admin_id, uid);
  delete from auth.users u where u.id in (admin_id, uid);
  perform set_config('request.jwt.claim.sub', '', true);
end
$$;

-- shiftflowカレンダーの表(cal_*)と Storage: 本人の行だけ・上限・入力の確かめ・消す日の計算・権限
do $$
declare
  u1 uuid := 'dddddddd-0000-4000-8000-000000000001';
  u2 uuid := 'dddddddd-0000-4000-8000-000000000002';
  l1 uuid;
  l2 uuid;
  e1 uuid;
  e2 uuid;
  d1 uuid;
  t text;
  n int;
  ok boolean;
begin
  -- 権限: 未ログインは触れない。利用者は決めた列だけ。RLS は全部の表で有効
  foreach t in array array['cal_labels', 'cal_events', 'cal_photos', 'cal_stamp_defs', 'cal_stamps', 'cal_todos', 'cal_importants', 'cal_gallery'] loop
    assert (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass), t || ' の RLS が無効';
    assert not has_table_privilege('anon', 'public.' || t, 'select, insert, update, delete'), 'anon が ' || t || ' を触れる';
    assert has_table_privilege('authenticated', 'public.' || t, 'select, insert, delete'), 'authenticated が ' || t || ' を使えない';
    assert has_table_privilege('service_role', 'public.' || t, 'select, insert, update, delete'), 'service_role が ' || t || ' を触れない';
  end loop;
  assert not has_column_privilege('authenticated', 'public.cal_photos', 'expires_on', 'update'), '利用者が写真の消す日を書き換えられる';
  assert not has_table_privilege('authenticated', 'public.cal_photos', 'update'), '利用者が写真の行を更新できる';
  assert not has_column_privilege('authenticated', 'public.cal_gallery', 'path', 'update'), '利用者が画像の場所を書き換えられる';
  assert has_column_privilege('authenticated', 'public.cal_gallery', 'title', 'update'), '利用者が画像の名前を直せない';
  assert not has_function_privilege('anon', 'public.cal_ensure_default_labels()', 'execute'), 'anon が cal_ensure_default_labels を実行できる';
  assert has_function_privilege('authenticated', 'public.cal_ensure_default_labels()', 'execute'), 'authenticated が cal_ensure_default_labels を実行できない';
  assert not has_function_privilege('authenticated', 'public.cal_limit()', 'execute'), 'authenticated が cal_limit を実行できる';

  -- Storage(テストの偽物): calendar バケットは非公開・1MBまで・画像だけ。自分のフォルダだけ
  assert (select count(*) from storage.buckets where id = 'calendar' and public = false and file_size_limit = 1048576) = 1, 'calendar バケットの設定が違う';
  assert (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'calendar_%') = 3, 'calendar の Storage の権限が3つではない';

  insert into auth.users (id) values (u1), (u2);
  insert into public.profiles (user_id, employee_no, family_name, given_name) values (u1, '7000001', '試', '一'), (u2, '7000002', '試', '二');

  -- ===== u1 =====
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', u1::text, true);
  perform public.cal_ensure_default_labels();
  perform public.cal_ensure_default_labels();
  assert (select count(*) from public.cal_labels) = 3, '最初のラベルが3つにならない(2回呼んでも増えない)';
  assert (select count(*) from public.cal_labels where kind in ('duty', 'off')) = 2, '勤務・休日のラベルが無い';
  select id into l1 from public.cal_labels where kind = 'custom';

  -- ラベル: 色の形・名前の長さ・勤務/休日は1つだけ・自分で作るのは10件まで
  ok := false;
  begin insert into public.cal_labels (name, color) values ('x', 'red'); exception when check_violation then ok := true; end;
  assert ok, '色が #RRGGBB でなくても入る';
  ok := false;
  begin insert into public.cal_labels (kind, name, color) values ('duty', 'もう1つ', '#112233'); exception when unique_violation then ok := true; end;
  assert ok, '勤務のラベルが2つ入る';
  for n in 1..9 loop insert into public.cal_labels (name, color, sort) values ('ラベル' || n, '#112233', n + 10); end loop;
  ok := false;
  begin insert into public.cal_labels (name, color) values ('11個目', '#112233'); exception when check_violation then ok := true; end;
  assert ok, '自分で作るラベルが10件を超えて入る';

  -- 予定: 分単位の時刻・終日でない予定には開始時刻・同じ日で終了が開始より前は不可・version は更新のたびに +1
  insert into public.cal_events (title, start_date, end_date, all_day, label_id) values ('歯医者', '2026-11-10', '2026-11-10', true, l1) returning id into e1;
  assert (select version from public.cal_events where id = e1) = 1, '予定の version が 1 でない';
  update public.cal_events set title = '歯医者2', version = 99 where id = e1;
  assert (select version from public.cal_events where id = e1) = 2, 'version を画面から決められる(更新のたびに +1 になっていない)';
  insert into public.cal_events (title, start_date, end_date, all_day, start_time, end_time, label_id)
    values ('会議', '2026-11-10', '2026-11-10', false, '09:07', '10:43', l1);
  ok := false;
  begin insert into public.cal_events (title, start_date, end_date, all_day, label_id) values ('x', '2026-11-10', '2026-11-10', false, l1); exception when check_violation then ok := true; end;
  assert ok, '終日でないのに開始時刻が無い予定が入る';
  ok := false;
  begin insert into public.cal_events (title, start_date, end_date, all_day, start_time, end_time, label_id) values ('x', '2026-11-10', '2026-11-10', false, '10:00', '09:00', l1); exception when check_violation then ok := true; end;
  assert ok, '同じ日で、終了が開始より前の予定が入る';
  ok := false;
  begin insert into public.cal_events (title, start_date, end_date, all_day, start_time, label_id) values ('x', '2026-11-10', '2026-11-10', false, '25:00', l1); exception when check_violation then ok := true; end;
  assert ok, '25:00 の予定が入る';
  -- 日をまたぐ予定(泊など)は、終了が開始より前の時刻でもよい
  insert into public.cal_events (title, start_date, end_date, all_day, start_time, end_time, label_id)
    values ('泊', '2026-11-10', '2026-11-11', false, '22:30', '08:15', l1);
  ok := false;
  begin insert into public.cal_events (title, start_date, end_date, label_id) values ('x', '2026-11-10', '2026-11-09', l1); exception when check_violation then ok := true; end;
  assert ok, '終了日が開始日より前の予定が入る';

  -- 写真: 1つの予定に3枚まで・消す日は「予定の終了日から1か月」・他人のフォルダの場所は不可
  for n in 1..3 loop insert into public.cal_photos (event_id, path, size_bytes) values (e1, u1::text || '/p' || n || '.jpg', 150000); end loop;
  assert (select count(distinct expires_on) from public.cal_photos where event_id = e1) = 1
     and (select min(expires_on) from public.cal_photos where event_id = e1) = date '2026-12-10', '写真を消す日が予定の終了日の1か月後でない';
  ok := false;
  begin insert into public.cal_photos (event_id, path) values (e1, u1::text || '/p4.jpg'); exception when check_violation then ok := true; end;
  assert ok, '1つの予定に4枚目の写真が入る';
  ok := false;
  begin insert into public.cal_photos (event_id, path) values ((select id from public.cal_events where title = '会議'), u2::text || '/x.jpg'); exception when check_violation then ok := true; end;
  assert ok, '他人のフォルダの場所の写真が入る';
  update public.cal_events set end_date = '2026-11-20' where id = e1;
  assert (select min(expires_on) from public.cal_photos where event_id = e1) = date '2026-12-20', '予定の終了日を変えても、写真を消す日が変わらない';
  update public.cal_events set repeat_rule = 'yearly' where id = e1;
  assert (select count(*) from public.cal_photos where event_id = e1 and expires_on is null) = 3, '繰り返しの予定の写真に、消す日が付く';

  -- スタンプ・TODO・重要メモ・画像
  insert into public.cal_stamp_defs (kind, emoji) values ('emoji', '🙂') returning id into d1;
  ok := false;
  begin insert into public.cal_stamp_defs (kind, emoji) values ('emoji', ''); exception when check_violation then ok := true; end;
  assert ok, '絵文字が空のスタンプの種類が入る';
  insert into public.cal_stamps (date, stamp_def_id, x, y, size) values ('2026-11-10', d1, 0.5, 0.5, 0.3);
  ok := false;
  begin insert into public.cal_stamps (date, stamp_def_id, x, y, size, notes) values ('2026-11-10', d1, 0.5, 0.5, 0.3, jsonb_build_array(1,2,3,4,5,6,7,8,9,10,11)); exception when check_violation then ok := true; end;
  assert ok, 'スタンプのメモが10件を超えて入る';
  insert into public.cal_todos (text) values ('牛乳を買う');
  ok := false;
  begin insert into public.cal_todos (text) values (''); exception when check_violation then ok := true; end;
  assert ok, '空のTODOが入る';
  insert into public.cal_importants (title, body) values ('病院', '電話 000');
  for n in 1..10 loop insert into public.cal_gallery (path, title) values (u1::text || '/g' || n || '.jpg', '日程表'); end loop;
  ok := false;
  begin insert into public.cal_gallery (path) values (u1::text || '/g11.jpg'); exception when check_violation then ok := true; end;
  assert ok, '画像の置き場に11枚目が入る';

  -- Storage の権限: 自分のフォルダには入れられ、他人のフォルダには入れられない
  insert into storage.objects (bucket_id, name, owner) values ('calendar', u1::text || '/a.jpg', u1);
  ok := false;
  begin insert into storage.objects (bucket_id, name, owner) values ('calendar', u2::text || '/a.jpg', u1); exception when insufficient_privilege then ok := true; end;
  assert ok, '他人のフォルダに写真を入れられる';

  -- ===== u2: u1 のものは見えない・触れない =====
  perform set_config('request.jwt.claim.sub', u2::text, true);
  foreach t in array array['cal_labels', 'cal_events', 'cal_photos', 'cal_stamp_defs', 'cal_stamps', 'cal_todos', 'cal_importants', 'cal_gallery'] loop
    execute format('select count(*) from public.%I', t) into n;
    assert n = 0, 'u2 に u1 の ' || t || ' が見える';
  end loop;
  assert (select count(*) from storage.objects) = 0, 'u2 に u1 の写真の置き場が見える';
  update public.cal_events set title = 'のっとり' where id = e1;
  get diagnostics n = row_count;
  assert n = 0, 'u2 が u1 の予定を書き換えられる';
  delete from public.cal_events where id = e1;
  get diagnostics n = row_count;
  assert n = 0, 'u2 が u1 の予定を消せる';
  ok := false;
  begin insert into public.cal_events (title, start_date, end_date, label_id) values ('x', '2026-11-10', '2026-11-10', l1); exception when foreign_key_violation then ok := true; end;
  assert ok, 'u2 が u1 のラベルで予定を作れる';
  ok := false;
  begin insert into public.cal_stamps (date, stamp_def_id, x, y, size) values ('2026-11-10', d1, 0.5, 0.5, 0.3); exception when foreign_key_violation then ok := true; end;
  assert ok, 'u2 が u1 のスタンプの種類を使える';
  ok := false;
  begin insert into public.cal_photos (event_id, path) values (e1, u2::text || '/x.jpg'); exception when foreign_key_violation then ok := true; end;
  assert ok, 'u2 が u1 の予定に写真を付けられる';

  -- ログインしていない人(プロフィールが無い人)は、自分の行でも作れない
  perform set_config('request.jwt.claim.sub', 'dddddddd-0000-4000-8000-0000000000ff', true);
  ok := false;
  begin insert into public.cal_todos (text) values ('x'); exception when insufficient_privilege then ok := true; end;
  assert ok, 'プロフィールの無い人が作れる';

  reset role;
  perform set_config('request.jwt.claim.sub', '', true);
  -- 利用者を消すと、カレンダーの行も全部消える
  delete from storage.objects where bucket_id = 'calendar';
  delete from auth.users where id in (u1, u2);
  delete from public.profiles where user_id in (u1, u2);
  assert (select count(*) from public.cal_labels) = 0 and (select count(*) from public.cal_events) = 0
     and (select count(*) from public.cal_photos) = 0 and (select count(*) from public.cal_gallery) = 0, '利用者を消しても、カレンダーの行が残る';
end
$$;

-- 保存期間: 勤務の記録は13か月・カレンダーの予定とスタンプは12か月。写真が残っている予定と、終わりの無い繰り返しは消さない
do $$
declare
  u uuid := 'eeeeeeee-0000-4000-8000-000000000001';
  first_this date := date_trunc('month', (now() at time zone 'Asia/Tokyo')::date)::date;
  l uuid;
  d uuid;
  e_old uuid;
  e_photo uuid;
  e_rep uuid;
  e_rep_end uuid;
  e_keep uuid;
begin
  assert not has_function_privilege('anon', 'public.purge_old_calendar()', 'execute'), 'anon が purge_old_calendar を実行できる';
  assert not has_function_privilege('authenticated', 'public.purge_old_calendar()', 'execute'), 'authenticated が purge_old_calendar を実行できる';
  insert into auth.users (id) values (u);
  insert into public.profiles (user_id, employee_no, family_name, given_name) values (u, '7000009', '試', '九');
  -- 勤務の記録: 14か月前・13か月前の月初の前日は消え、13か月前の月初・12か月前は残る
  insert into public.shift_records (user_id, date, code, memo) values
    (u, (first_this - interval '13 months')::date - 1, '1', ''),
    (u, (first_this - interval '14 months')::date, '1', ''),
    (u, (first_this - interval '13 months')::date, '1', ''),
    (u, (first_this - interval '12 months')::date, '1', '');
  assert public.count_old_shift_records() = 2, '消える勤務の記録の数が違う(13か月)';
  insert into public.cal_labels (user_id, name, color) values (u, '試', '#112233') returning id into l;
  -- 予定: 古い単発・古い単発(写真あり)・終わりの無い繰り返し・終わりが古い繰り返し・12か月前の月初の予定
  insert into public.cal_events (user_id, title, start_date, end_date, label_id) values (u, '古い', (first_this - interval '12 months')::date - 1, (first_this - interval '12 months')::date - 1, l) returning id into e_old;
  insert into public.cal_events (user_id, title, start_date, end_date, label_id) values (u, '写真あり', (first_this - interval '13 months')::date, (first_this - interval '13 months')::date, l) returning id into e_photo;
  insert into public.cal_photos (user_id, event_id, path) values (u, e_photo, u::text || '/x.jpg');
  insert into public.cal_events (user_id, title, start_date, end_date, label_id, repeat_rule) values (u, '誕生日', (first_this - interval '5 years')::date, (first_this - interval '5 years')::date, l, 'yearly') returning id into e_rep;
  insert into public.cal_events (user_id, title, start_date, end_date, label_id, repeat_rule, repeat_until) values (u, '終わった繰り返し', (first_this - interval '3 years')::date, (first_this - interval '3 years')::date, l, 'weekly', (first_this - interval '2 years')::date) returning id into e_rep_end;
  insert into public.cal_events (user_id, title, start_date, end_date, label_id) values (u, '残る', (first_this - interval '12 months')::date, (first_this - interval '12 months')::date, l) returning id into e_keep;
  insert into public.cal_stamp_defs (user_id, kind, emoji) values (u, 'emoji', '🙂') returning id into d;
  insert into public.cal_stamps (user_id, date, stamp_def_id, x, y, size) values (u, (first_this - interval '12 months')::date - 1, d, .5, .5, .3), (u, (first_this - interval '12 months')::date, d, .5, .5, .3);
  perform public.purge_old_shift_records();
  assert (select count(*) from public.shift_records where user_id = u) = 2, '勤務の記録の消え方が違う';
  assert not exists (select 1 from public.cal_events where id = e_old), '古い予定が消えない';
  assert exists (select 1 from public.cal_events where id = e_photo), '写真が残っている予定が消えた';
  assert exists (select 1 from public.cal_events where id = e_rep), '終わりの無い繰り返しが消えた';
  assert not exists (select 1 from public.cal_events where id = e_rep_end), '終わりが古い繰り返しが消えない';
  assert exists (select 1 from public.cal_events where id = e_keep), '12か月前の月初の予定が消えた';
  assert (select count(*) from public.cal_stamps where user_id = u) = 1, '古いスタンプの消え方が違う';
  -- 写真が消えたあとの翌日には、予定も消える
  delete from public.cal_photos where event_id = e_photo;
  perform public.purge_old_shift_records();
  assert not exists (select 1 from public.cal_events where id = e_photo), '写真が無くなった古い予定が消えない';
  delete from auth.users where id = u;
  delete from public.profiles where user_id = u;
end
$$;

-- 無料枠の使用量(管理者だけ)
do $$
declare
  admin_id uuid := 'ffffffff-0000-4000-8000-000000000001';
  u uuid := 'ffffffff-0000-4000-8000-000000000002';
  l uuid;
  e uuid;
  r jsonb;
  failed boolean := false;
begin
  assert not has_function_privilege('anon', 'public.admin_usage()', 'execute'), 'anon が admin_usage を実行できる';
  insert into auth.users (id) values (admin_id), (u);
  insert into public.profiles (user_id, role) values (admin_id, 'admin');
  insert into public.profiles (user_id, employee_no, family_name, given_name) values (u, '7000011', '使', '用');
  insert into public.cal_labels (user_id, name, color) values (u, '試', '#112233') returning id into l;
  insert into public.cal_events (user_id, title, start_date, end_date, label_id) values (u, 'x', current_date, current_date, l) returning id into e;
  insert into public.cal_photos (user_id, event_id, path, size_bytes) values (u, e, u::text || '/a.jpg', 150000), (u, e, u::text || '/b.jpg', 50000);
  insert into public.cal_gallery (user_id, path, size_bytes) values (u, u::text || '/g.jpg', 300000);
  insert into storage.objects (bucket_id, name, owner, metadata) values ('calendar', u::text || '/a.jpg', u, '{"size": 150000}'), ('calendar', u::text || '/b.jpg', u, '{"size": 50000}');
  -- 管理者でないと呼べない
  perform set_config('request.jwt.claim.sub', u::text, true);
  begin
    perform public.admin_usage();
  exception when others then failed := sqlerrm like '管理者だけ%';
  end;
  assert failed, '管理者でなくても使用量を見られる';
  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  r := public.admin_usage();
  assert (r ->> 'db_limit_bytes')::bigint = 524288000 and (r ->> 'storage_limit_bytes')::bigint = 1073741824, '無料枠の上限が違う';
  assert (r ->> 'db_bytes')::bigint > 0, 'データベースの大きさが取れない';
  assert (r ->> 'storage_bytes')::bigint = 200000 and (r ->> 'storage_files')::int = 2, 'Storage の使用量が違う';
  assert (r ->> 'photos')::int = 2 and (r ->> 'photo_bytes')::bigint = 200000, '予定の写真の数・大きさが違う';
  assert (r ->> 'gallery')::int = 1 and (r ->> 'gallery_bytes')::bigint = 300000, '画像の数・大きさが違う';
  assert (r #>> '{top_users,0,employee_no}') = '7000011' and (r #>> '{top_users,0,bytes}')::bigint = 500000, '使用量の多い人が違う';
  delete from storage.objects where bucket_id = 'calendar';
  delete from auth.users where id in (admin_id, u);
  delete from public.profiles where user_id in (admin_id, u);
  perform set_config('request.jwt.claim.sub', '', true);
end
$$;

select 'db_assert: all ok' as result;
