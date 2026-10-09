\set ON_ERROR_STOP 0
\pset format unaligned
\pset tuples_only on
-- 利用者と管理者
insert into auth.users (id, email) values
 ('11111111-1111-1111-1111-111111111111', 'u@x'), ('22222222-2222-2222-2222-222222222222', 'a@x');
insert into public.profiles (user_id, employee_no, family_name, given_name) values ('11111111-1111-1111-1111-111111111111', '1234567', '山田', '太郎');
insert into public.profiles (user_id, role) values ('22222222-2222-2222-2222-222222222222', 'admin');
insert into public.offices (name, sort_order) values ('B区所', 2), ('A区所', 1);

-- お知らせ: 今日(日本時間)・昨日まで・明日から・終わりなし
insert into public.notices (title, level, starts_on, ends_on) values
 ('today-end', 'info', (now() at time zone 'Asia/Tokyo')::date - 3, (now() at time zone 'Asia/Tokyo')::date),
 ('ended', 'info', (now() at time zone 'Asia/Tokyo')::date - 3, (now() at time zone 'Asia/Tokyo')::date - 1),
 ('future', 'info', (now() at time zone 'Asia/Tokyo')::date + 1, null),
 ('important', 'important', (now() at time zone 'Asia/Tokyo')::date - 5, null);
select 'notices(service): ' || (select string_agg(x->>'title', ',') from jsonb_array_elements(public.current_notices()) x);

-- anon
set role anon;
select 'anon notices: ' || (select string_agg(x->>'title', ',') from jsonb_array_elements(public.current_notices()) x);
select 'anon offices: ' || public.contact_offices()::text;
select 'anon read notices table (should fail)' from public.notices limit 1;
select 'anon read inquiries (should fail)' from public.inquiries limit 1;
select public.create_inquiry('{}'::jsonb)::text;
select public.rate_limit_hit('x', 1, 1);
select public.purge_old_contact()::text;
reset role;

-- 利用者(authenticated・管理者でない)
set role authenticated; set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select 'user notices rows (expect 0): ' || count(*) from public.notices;
insert into public.notices (title) values ('hack');
select 'user read inquiries (should fail)' from public.inquiries limit 1;
select 'user read messages (should fail)' from public.inquiry_messages limit 1;
select 'user read app_status (should fail)' from public.app_status limit 1;
select 'user notices fn: ' || jsonb_array_length(public.current_notices());
reset role;

-- 管理者
set role authenticated; set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select 'admin notices rows (expect 4): ' || count(*) from public.notices;
insert into public.notices (title, body) values ('admin-new', 'line1' || chr(10) || 'line2');
update public.notices set title = 'admin-edited' where title = 'admin-new';
select 'admin edited updated_at > created_at: ' || (updated_at >= created_at) from public.notices where title = 'admin-edited';
insert into public.notices (title, starts_on, ends_on) values ('bad-range', '2026-10-10', '2026-10-01');
insert into public.notices (title) values ('   ');
delete from public.notices where title = 'admin-edited';
select 'admin read inquiries (should fail)' from public.inquiries limit 1;
reset role;

-- create_inquiry(service_role)
set role service_role;
select 'create1: ' || public.create_inquiry('{"request_key":"aaaaaaaa-0000-0000-0000-000000000001","user_id":"11111111-1111-1111-1111-111111111111","logged_in":true,"employee_no":"1234567","name":"山田 太郎","office_name":"A区所","kind":"login","reply_via":"screen","body":"hello"}')::text;
select 'create dup: ' || public.create_inquiry('{"request_key":"aaaaaaaa-0000-0000-0000-000000000001","logged_in":true,"employee_no":"1234567","name":"x","office_name":"A区所","kind":"login","reply_via":"screen","body":"other"}')::text;
select 'messages for 1: ' || count(*) from public.inquiry_messages where inquiry_id = 1;
select 'create guest mail: ' || public.create_inquiry('{"request_key":"aaaaaaaa-0000-0000-0000-000000000002","logged_in":false,"employee_no":"7654321","name":"佐藤","office_name":"わからない","kind":"bug","reply_via":"mail","email":"s@example.com","body":"b","image_count":2}')::text;
select 'bad kind: ' || public.create_inquiry('{"request_key":"aaaaaaaa-0000-0000-0000-000000000003","logged_in":false,"employee_no":"7654321","name":"佐藤","office_name":"x","kind":"hack","reply_via":"mail","body":"b"}')::text;
select 'after bad kind, rows with key3 (expect 0): ' || count(*) from public.inquiries where request_key = 'aaaaaaaa-0000-0000-0000-000000000003';
select 'long body: ' || public.create_inquiry(jsonb_build_object('request_key','aaaaaaaa-0000-0000-0000-000000000004','logged_in',false,'employee_no','7654321','name','佐藤','office_name','x','kind','bug','reply_via','screen','body', repeat('あ', 5001)))::text;
select 'after long body, inquiry 4 kept? (expect 0): ' || count(*) from public.inquiries where request_key = 'aaaaaaaa-0000-0000-0000-000000000004';

-- rate limit
select 'rl: ' || string_agg(public.rate_limit_hit('k1', 3, 60)::text, ',') from generate_series(1,5);
update public.rate_limits set window_start = now() - interval '61 minutes' where key = 'k1';
select 'rl after window: ' || public.rate_limit_hit('k1', 3, 60);
reset role;

-- 利用者を消しても問い合わせは残る(X7)
delete from auth.users where id = '11111111-1111-1111-1111-111111111111';
select 'after user delete, inquiry 1 user_id null: ' || (user_id is null) from public.inquiries where id = 1;

-- 古いものの削除
insert into public.inquiry_messages (inquiry_id, sender, channel, body, created_at) values (null, 'mail', 'mail', 'old unmatched', now() - interval '91 days');
insert into public.inquiry_messages (inquiry_id, sender, channel, body) values (null, 'mail', 'mail', 'new unmatched');
update public.inquiries set last_activity_at = now() - interval '91 days' where id = 1;
update public.inquiries set status='done', done_at = now() - interval '31 days', last_activity_at = now() - interval '31 days' where request_key = 'aaaaaaaa-0000-0000-0000-000000000002';
insert into public.inquiry_messages (inquiry_id, sender, channel, body, from_email) values
 (2, 'admin', 'mail', 'reply', 's@example.com'), (2, 'mail', 'mail', 'incoming', 's@example.com');
insert into public.rate_limits values ('old', now() - interval '2 days', 1);
insert into public.discord_posts values ('d1', 1, now() - interval '121 days'), ('d2', 1, now() - interval '100 days');
set role service_role;
select 'purge: ' || public.purge_old_contact()::text;
reset role;
select 'remaining inquiries: ' || string_agg(id::text || ':' || coalesce(email, 'null'), ',') from public.inquiries;
select 'inquiry 2 message from_email (admin erased, mail kept): ' || string_agg(sender || '=' || coalesce(from_email, 'null'), ',' order by sender) from public.inquiry_messages where inquiry_id = 2 and sender in ('admin', 'mail');
select 'remaining unmatched: ' || string_agg(body, ',') from public.inquiry_messages where inquiry_id is null;
select 'remaining discord: ' || string_agg(message_id, ',') from public.discord_posts;
select 'rate old gone: ' || (not exists (select 1 from public.rate_limits where key = 'old'));
select 'app_status purge: ' || (value is not null) from public.app_status where key = 'purge';
-- 関数の権限の一覧(anon / authenticated が実行できる public の関数)
select 'anon exec: ' || string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute');
select 'auth exec: ' || string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'execute');
select 'anon table privs: ' || coalesce(string_agg(c.relname, ','), 'none') from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relkind='r' and has_table_privilege('anon', c.oid, 'select');
