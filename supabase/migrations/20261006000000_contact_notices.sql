-- お知らせ・お問い合わせ(設計: docs/contact/DESIGN.md)
--
-- テーブル
--   notices            お知らせ。読むのは関数 current_notices() 経由(未ログインでも可)。書くのは管理者(RLS)
--   inquiries          お問い合わせ(受付番号 = id)。Edge Function(service_role)だけが読み書きする
--   inquiry_messages   やり取り1件ずつ(画面・メール送信・メール受信)。inquiry_id が null は、どの問い合わせにも当てはまらない受信メール
--   discord_posts      Discord に送った通知のID(90日たったら消すため)
--   rate_limits        お問い合わせの回数制限(決まった時間の中の回数)
--   app_status         GAS の最終確認時刻など、管理画面に出す状態
--
-- 問い合わせには社員番号・氏名・メールアドレスが入るので、anon / authenticated には一切の権限を渡さない
-- (Supabase は新しく作った表に権限を自動で付けることがあるので、明示的に外す)。

-- ============================================================
-- お知らせ
-- ============================================================

create table public.notices (
  id         bigint generated always as identity primary key,
  title      text not null check (char_length(btrim(title)) between 1 and 100),
  body       text not null default '' check (char_length(body) <= 1000),
  level      text not null default 'info' check (level in ('info', 'important')),
  -- 表示する期間(日本時間の日付。終了日はその日いっぱい。null は終わりなし)
  starts_on  date not null default ((now() at time zone 'Asia/Tokyo')::date),
  ends_on    date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_on is null or ends_on >= starts_on)
);

comment on table public.notices is 'お知らせ。ログイン画面(利用者タブ)とログイン後の「お知らせ」に出す';

create trigger notices_updated_at before update on public.notices
  for each row execute function public.set_updated_at();

alter table public.notices enable row level security;

create policy notices_admin_select on public.notices for select to authenticated using (public.is_admin());
create policy notices_admin_insert on public.notices for insert to authenticated with check (public.is_admin());
create policy notices_admin_update on public.notices for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy notices_admin_delete on public.notices for delete to authenticated using (public.is_admin());

-- いま表示するお知らせ(重要を先に、その中で新しい順。最大20件)。未ログインでも呼べる
create or replace function public.current_notices()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', n.id, 'title', n.title, 'body', n.body, 'level', n.level,
           'starts_on', n.starts_on, 'updated_at', n.updated_at
         ) order by (n.level = 'important') desc, n.starts_on desc, n.id desc), '[]'::jsonb)
    from (
      select * from public.notices
       where starts_on <= (now() at time zone 'Asia/Tokyo')::date
         and (ends_on is null or ends_on >= (now() at time zone 'Asia/Tokyo')::date)
       order by (level = 'important') desc, starts_on desc, id desc
       limit 20
    ) n
$$;

-- お問い合わせ(ログイン前)の所属の選択肢。区所の名前だけを返す。未ログインでも呼べる
create or replace function public.contact_offices()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(o.name order by o.sort_order, o.id), '[]'::jsonb) from public.offices o
$$;

-- ============================================================
-- お問い合わせ
-- ============================================================

create table public.inquiries (
  id               bigint generated always as identity primary key,   -- 受付番号
  request_key      uuid not null unique,                               -- 二度押し・送り直しで2件にしないための、画面が作るキー
  user_id          uuid references auth.users (id) on delete set null, -- ログイン後の問い合わせ(利用者を消しても問い合わせは残す)
  logged_in        boolean not null,
  employee_no      text not null check (employee_no ~ '^\d{7}$'),
  name             text not null check (char_length(name) between 1 and 61),
  office_name      text not null check (char_length(office_name) between 1 and 60),
  kind             text not null check (kind in ('login', 'howto', 'bug', 'other')),
  reply_via        text not null check (reply_via in ('screen', 'mail')),
  email            text check (email is null or char_length(email) <= 254),
  code_hash        text,                                               -- ログイン前で「画面で見る」のときの確認コード(ハッシュ)
  status           text not null default 'open' check (status in ('open', 'replied', 'done')),
  has_new_mail     boolean not null default false,                     -- 管理者がまだ見ていない受信メールがある
  image_count      int not null default 0 check (image_count between 0 and 3),
  discord_status   text not null default 'pending' check (discord_status in ('pending', 'sent', 'failed', 'skipped')),
  receipt_status   text not null default 'none' check (receipt_status in ('none', 'sent', 'failed', 'unknown', 'skipped')),
  receipt_message_id text,                                             -- Gmail の受付メール(画像つき)
  last_activity_at timestamptz not null default now(),
  done_at          timestamptz,
  created_at       timestamptz not null default now()
);

comment on table public.inquiries is 'お問い合わせ。Edge Function(service_role)だけが読み書きする。最後のやり取りから90日で消す';

create index inquiries_last_activity on public.inquiries (last_activity_at desc);
create index inquiries_user on public.inquiries (user_id) where user_id is not null;

create table public.inquiry_messages (
  id               bigint generated always as identity primary key,
  inquiry_id       bigint references public.inquiries (id) on delete cascade, -- null = どの問い合わせにも当てはまらない受信メール
  request_key      uuid unique,                    -- 管理者の返事の二度押し対策
  sender           text not null check (sender in ('user', 'admin', 'mail')),
  channel          text not null check (channel in ('web', 'mail')),
  body             text not null check (char_length(body) <= 5000),
  body_full        text check (body_full is null or char_length(body_full) <= 20000), -- 受信メールの全文(引用つき)
  from_email       text check (from_email is null or char_length(from_email) <= 320),
  subject          text check (subject is null or char_length(subject) <= 300),
  attachment_names text check (attachment_names is null or char_length(attachment_names) <= 1000),
  bounce           boolean not null default false, -- 届かなかった知らせ(Mail Delivery Subsystem など)
  gmail_message_id text unique,
  gmail_thread_id  text,
  mail_status      text check (mail_status is null or mail_status in ('sending', 'sent', 'failed', 'unknown')),
  mail_error       text check (mail_error is null or char_length(mail_error) <= 500),
  created_at       timestamptz not null default now()
);

create index inquiry_messages_inquiry on public.inquiry_messages (inquiry_id, id);
create index inquiry_messages_thread on public.inquiry_messages (gmail_thread_id) where gmail_thread_id is not null;
create index inquiry_messages_unmatched on public.inquiry_messages (created_at desc) where inquiry_id is null;

create table public.discord_posts (
  message_id text primary key,
  inquiry_id bigint,
  created_at timestamptz not null default now()
);

create table public.rate_limits (
  key          text primary key,
  window_start timestamptz not null default now(),
  hits         int not null default 0
);

create table public.app_status (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.inquiries enable row level security;
alter table public.inquiry_messages enable row level security;
alter table public.discord_posts enable row level security;
alter table public.rate_limits enable row level security;
alter table public.app_status enable row level security;
-- ポリシーは作らない(service_role だけが RLS を越えて触る)

-- 問い合わせと最初のメッセージを1回で作る。同じ request_key で2回目に呼ばれたら、作らずに前の受付番号を返す
-- 戻り値: {"id": 受付番号, "duplicate": true/false}
create or replace function public.create_inquiry(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_id bigint;
  old_id bigint;
begin
  select id into old_id from public.inquiries where request_key = (p->>'request_key')::uuid;
  if old_id is not null then
    return jsonb_build_object('id', old_id, 'duplicate', true);
  end if;
  begin
    insert into public.inquiries (request_key, user_id, logged_in, employee_no, name, office_name, kind,
                                  reply_via, email, code_hash, image_count)
    values ((p->>'request_key')::uuid, nullif(p->>'user_id', '')::uuid, (p->>'logged_in')::boolean,
            p->>'employee_no', p->>'name', p->>'office_name', p->>'kind',
            p->>'reply_via', nullif(p->>'email', ''), nullif(p->>'code_hash', ''), coalesce((p->>'image_count')::int, 0))
    returning id into new_id;
  exception when unique_violation then
    -- 同じキーの送信が同時に届いた
    select id into old_id from public.inquiries where request_key = (p->>'request_key')::uuid;
    return jsonb_build_object('id', old_id, 'duplicate', true);
  end;
  insert into public.inquiry_messages (inquiry_id, sender, channel, body)
    values (new_id, 'user', 'web', p->>'body');
  return jsonb_build_object('id', new_id, 'duplicate', false);
end;
$$;

-- 回数制限: p_key の回数を1増やし、p_minutes 分の枠の中で p_max 回以内なら true。
-- 1回の文で数えるので、同時に来たリクエストも正しく数える
create or replace function public.rate_limit_hit(p_key text, p_max int, p_minutes int)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  n int;
begin
  insert into public.rate_limits as r (key, window_start, hits) values (p_key, now(), 1)
    on conflict (key) do update
      set hits = case when r.window_start < now() - make_interval(mins => p_minutes) then 1 else r.hits + 1 end,
          window_start = case when r.window_start < now() - make_interval(mins => p_minutes) then now() else r.window_start end
    returning hits into n;
  return n <= p_max;
end;
$$;

-- 古いものを消す(毎日)。
--   最後のやり取りから90日たった問い合わせ(やり取りも一緒に消える)
--   どの問い合わせにも当てはまらない受信メールで90日たったもの
--   対応済みで30日やり取りが無い問い合わせのメールアドレス
--   回数制限の古い行、消せないまま120日たった Discord の通知の記録
create or replace function public.purge_old_contact()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  n_inq bigint;
  n_mail bigint;
  n_email bigint;
begin
  delete from public.inquiries where last_activity_at < now() - interval '90 days';
  get diagnostics n_inq = row_count;
  delete from public.inquiry_messages where inquiry_id is null and created_at < now() - interval '90 days';
  get diagnostics n_mail = row_count;
  update public.inquiries set email = null
   where email is not null and status = 'done'
     and done_at < now() - interval '30 days' and last_activity_at < now() - interval '30 days';
  get diagnostics n_email = row_count;
  delete from public.rate_limits where window_start < now() - interval '1 day';
  delete from public.discord_posts where created_at < now() - interval '120 days';
  insert into public.app_status (key, value, updated_at)
    values ('purge', jsonb_build_object('inquiries', n_inq, 'unmatched_mails', n_mail, 'emails', n_email), now())
    on conflict (key) do update set value = excluded.value, updated_at = now();
  return jsonb_build_object('inquiries', n_inq, 'unmatched_mails', n_mail, 'emails', n_email);
end;
$$;

-- ============================================================
-- 権限
-- ============================================================

revoke all on public.notices, public.inquiries, public.inquiry_messages, public.discord_posts,
  public.rate_limits, public.app_status from anon, authenticated;
grant select, insert, update, delete on public.notices to authenticated;  -- 実際に触れるのは管理者だけ(RLS)
grant all on public.notices, public.inquiries, public.inquiry_messages, public.discord_posts,
  public.rate_limits, public.app_status to service_role;

revoke execute on function public.current_notices() from public, anon, authenticated;
revoke execute on function public.contact_offices() from public, anon, authenticated;
revoke execute on function public.create_inquiry(jsonb) from public, anon, authenticated;
revoke execute on function public.rate_limit_hit(text, int, int) from public, anon, authenticated;
revoke execute on function public.purge_old_contact() from public, anon, authenticated;

grant execute on function public.current_notices() to anon, authenticated;
grant execute on function public.contact_offices() to anon, authenticated;
grant execute on function public.create_inquiry(jsonb) to service_role;
grant execute on function public.rate_limit_hit(text, int, int) to service_role;
grant execute on function public.purge_old_contact() to service_role;

-- 毎日 日本時間の午前3時20分(UTC 18:20)に古いものを消す。pg_cron を設定できなくても migration 全体は失敗させない
-- (GAS の1日1回の処理からも同じ関数を呼ぶので、片方が止まっても消える)
do $$
begin
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname = 'purge-old-contact';
  perform cron.schedule('purge-old-contact', '20 18 * * *', 'select public.purge_old_contact()');
exception when others then
  raise notice 'pg_cron を設定できませんでした(%)。GAS の1日1回の処理で消します', sqlerrm;
end
$$;
