-- shiftflow 初期スキーマ
--
-- テーブル
--   members        利用を許可する Google アカウント(許可リスト)と管理者フラグ
--   shift_master   勤務コードマスタ(全員が読む。書くのは管理者だけ)
--   user_settings  カレンダーIDと検証状態(本人だけ)
--   shift_records  勤務記録(本人だけ)
--   holidays       祝日のキャッシュ(全員が読む。書くのは Edge Function だけ)
--
-- すべて RLS を有効にする。anon(未ログイン)には何も見せない。
-- Edge Function は service_role で動く部分(検証済みフラグ・ロック・祝日)だけ RLS を越える。

-- ============================================================
-- 共通関数
-- ============================================================

-- ログイン中のメールアドレス(小文字)
create or replace function public.current_email()
returns text
language sql
stable
set search_path = ''
as $$
  select lower(coalesce(auth.jwt() ->> 'email', ''))
$$;

-- "09:01:00" や "(9:01)" などを "9:01" にそろえる。時刻が無ければ ''
create or replace function public.normalize_time(value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    (select (r.m[1])::int::text || ':' || r.m[2]
       from regexp_match(coalesce(value, ''), '(\d{1,2}):(\d{2})') as r(m)),
    ''
  )
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ============================================================
-- members(許可リスト)
-- ============================================================

create table public.members (
  email      text primary key check (email <> '' and email = lower(email)),
  is_admin   boolean not null default false,
  plan       text not null default 'free',   -- 将来の課金用。今は使わない
  note       text not null default '',       -- 管理用メモ(誰か分かる程度)
  created_at timestamptz not null default now()
);

comment on table public.members is '利用を許可する Google アカウント。ここに無いメールでログインしても何もできない';

create or replace function public.members_normalize_email()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.email := lower(trim(new.email));
  return new;
end;
$$;

create trigger members_normalize_email
  before insert or update on public.members
  for each row execute function public.members_normalize_email();

-- RLS から呼ぶので security definer(members 自身の RLS を越えて判定する)
create or replace function public.is_member()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.members where email = public.current_email())
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.members where email = public.current_email() and is_admin)
$$;

alter table public.members enable row level security;

-- 本人の行(自分が許可されているかの確認)と、管理者は全行を読める
create policy members_select on public.members
  for select to authenticated
  using (email = public.current_email() or public.is_admin());

create policy members_insert on public.members
  for insert to authenticated
  with check (public.is_admin());

-- 管理者は自分自身の管理者権限を外せない(管理者がいなくなるのを防ぐ)
create policy members_update on public.members
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin() and (email <> public.current_email() or is_admin));

-- 管理者は自分自身を削除できない
create policy members_delete on public.members
  for delete to authenticated
  using (public.is_admin() and email <> public.current_email());

-- ============================================================
-- shift_master(勤務コードマスタ)
-- ============================================================

create table public.shift_master (
  code          text primary key check (code <> ''),       -- 番号(行路番号)
  kind          text not null check (kind in ('泊', '日勤', '休日')),  -- 種別
  weekday_start text not null default '',                  -- 平日出勤 (H:MM)
  weekday_end   text not null default '',                  -- 平日退勤
  holiday_start text not null default '',                  -- 休日出勤
  holiday_end   text not null default '',                  -- 休日退勤
  stay          text not null default '',                  -- 泊(泊地)
  sort_order    int  not null default 0,                   -- 一覧の並び順(CSVの行順)
  updated_at    timestamptz not null default now()
);

comment on table public.shift_master is '勤務コードマスタ。管理画面の CSV 取り込みで入れ替える';

alter table public.shift_master enable row level security;

create policy shift_master_select on public.shift_master
  for select to authenticated
  using (public.is_member());

create policy shift_master_admin_write on public.shift_master
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- マスタを丸ごと入れ替える(管理画面の CSV 取り込み)
-- rows: [{code, kind, weekday_start, weekday_end, holiday_start, holiday_end, stay}, ...] (並び順どおり)
create or replace function public.replace_shift_master(rows jsonb)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  n int;
  bad text;
begin
  if not public.is_admin() then
    raise exception '管理者だけが実行できます' using errcode = '42501';
  end if;
  if jsonb_typeof(rows) <> 'array' or jsonb_array_length(rows) = 0 then
    raise exception 'マスタが空です';
  end if;

  create temp table incoming on commit drop as
  select
    trim(r ->> 'code')                              as code,
    trim(r ->> 'kind')                              as kind,
    public.normalize_time(r ->> 'weekday_start')    as weekday_start,
    public.normalize_time(r ->> 'weekday_end')      as weekday_end,
    public.normalize_time(r ->> 'holiday_start')    as holiday_start,
    public.normalize_time(r ->> 'holiday_end')      as holiday_end,
    coalesce(trim(r ->> 'stay'), '')                as stay,
    ord::int                                        as sort_order
  from jsonb_array_elements(rows) with ordinality as t(r, ord)
  where coalesce(trim(r ->> 'code'), '') <> '';

  select string_agg(code, ', ') into bad
    from incoming where kind is null or kind not in ('泊', '日勤', '休日');
  if bad is not null then
    raise exception '種別は「泊」「日勤」「休日」のどれかにしてください: %', bad;
  end if;

  select string_agg(code, ', ') into bad
    from (select code from incoming group by code having count(*) > 1) d;
  if bad is not null then
    raise exception '番号が重複しています: %', bad;
  end if;

  delete from public.shift_master where true;
  insert into public.shift_master
    (code, kind, weekday_start, weekday_end, holiday_start, holiday_end, stay, sort_order)
  select code, kind, weekday_start, weekday_end, holiday_start, holiday_end, stay, sort_order
    from incoming;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ============================================================
-- user_settings
-- ============================================================

create table public.user_settings (
  user_id             uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  work_calendar_id    text not null default '',
  holiday_calendar_id text not null default '',
  verified_at         timestamptz,   -- 接続テストに成功した日時(= 検証済みフラグ)。Edge Function だけが書く
  busy_until          timestamptz,   -- 登録・削除の二重実行防止。Edge Function だけが書く
  last_registered_at  timestamptz,   -- 最後に登録した日時(管理画面の利用状況用)。Edge Function だけが書く
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- カレンダーIDを変えたら検証済みを外す
create or replace function public.user_settings_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.work_calendar_id := trim(new.work_calendar_id);
  new.holiday_calendar_id := trim(new.holiday_calendar_id);
  if tg_op = 'UPDATE' then
    if new.work_calendar_id is distinct from old.work_calendar_id
       or new.holiday_calendar_id is distinct from old.holiday_calendar_id then
      new.verified_at := null;
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger user_settings_before_write
  before insert or update on public.user_settings
  for each row execute function public.user_settings_before_write();

alter table public.user_settings enable row level security;

create policy user_settings_select on public.user_settings
  for select to authenticated
  using (user_id = auth.uid() and public.is_member());

create policy user_settings_insert on public.user_settings
  for insert to authenticated
  with check (user_id = auth.uid() and public.is_member());

create policy user_settings_update on public.user_settings
  for update to authenticated
  using (user_id = auth.uid() and public.is_member())
  with check (user_id = auth.uid() and public.is_member());

-- 利用者が書けるのはカレンダーIDだけ(検証済みフラグなどは書けない)
revoke insert, update, delete on public.user_settings from authenticated;
grant insert (user_id, work_calendar_id, holiday_calendar_id) on public.user_settings to authenticated;
grant update (work_calendar_id, holiday_calendar_id) on public.user_settings to authenticated;

-- 二重実行防止のロック(Edge Function から service_role で呼ぶ)
create or replace function public.acquire_user_lock(p_user_id uuid, p_seconds int default 120)
returns boolean
language sql
set search_path = ''
as $$
  with locked as (
    update public.user_settings
       set busy_until = now() + make_interval(secs => p_seconds)
     where user_id = p_user_id
       and (busy_until is null or busy_until < now())
    returning 1
  )
  select exists (select 1 from locked)
$$;

create or replace function public.release_user_lock(p_user_id uuid)
returns void
language sql
set search_path = ''
as $$
  update public.user_settings set busy_until = null where user_id = p_user_id
$$;

-- ============================================================
-- shift_records(勤務記録)
-- ============================================================

create table public.shift_records (
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  date       date not null,
  code       text not null default '',   -- 番号 or 手入力の文字。非番の日は ''
  memo       text not null default '',   -- 手修正したときだけ
  updated_at timestamptz not null default now(),
  primary key (user_id, date),
  check (code <> '' or memo <> '')
);

create trigger shift_records_updated_at
  before update on public.shift_records
  for each row execute function public.set_updated_at();

alter table public.shift_records enable row level security;

create policy shift_records_all on public.shift_records
  for all to authenticated
  using (user_id = auth.uid() and public.is_member())
  with check (user_id = auth.uid() and public.is_member());

-- 1か月分を入れ替える(削除+挿入を1トランザクションで)。
-- security invoker なので RLS がそのまま効く(本人の行しか触れない)。
-- entries: {"yyyy-MM-dd": {"code": "...", "memo": "..."}, ...}  月外の日付は無視する
create or replace function public.save_month_records(p_year int, p_month int, p_entries jsonb)
returns int
language plpgsql
security invoker
set search_path = ''
as $$
declare
  first_day date := make_date(p_year, p_month, 1);
  next_first date := (make_date(p_year, p_month, 1) + interval '1 month')::date;
  n int;
begin
  delete from public.shift_records
   where user_id = auth.uid() and date >= first_day and date < next_first;

  insert into public.shift_records (user_id, date, code, memo)
  select auth.uid(), k::date, trim(coalesce(v ->> 'code', '')), trim(coalesce(v ->> 'memo', ''))
    from jsonb_each(coalesce(p_entries, '{}'::jsonb)) as e(k, v)
   where k ~ '^\d{4}-\d{2}-\d{2}$'
     and k::date >= first_day and k::date < next_first
     and (trim(coalesce(v ->> 'code', '')) <> '' or trim(coalesce(v ->> 'memo', '')) <> '');
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ============================================================
-- holidays(祝日キャッシュ)
-- ============================================================

create table public.holidays (
  date date primary key,
  name text not null default ''
);

create table public.holiday_years (
  year       int primary key,
  source     text not null default 'google',   -- google / manual
  fetched_at timestamptz not null default now()
);

alter table public.holidays enable row level security;
alter table public.holiday_years enable row level security;

create policy holidays_select on public.holidays
  for select to authenticated using (public.is_member());
create policy holiday_years_select on public.holiday_years
  for select to authenticated using (public.is_member());

-- ============================================================
-- 管理画面の利用状況
-- ============================================================

create or replace function public.admin_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if not public.is_admin() then
    raise exception '管理者だけが実行できます' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'members', (select count(*) from public.members),
    'signed_in', (select count(*) from auth.users u
                   join public.members m on m.email = lower(u.email)),
    'verified', (select count(*) from public.user_settings s
                   join auth.users u on u.id = s.user_id
                   join public.members m on m.email = lower(u.email)
                  where s.verified_at is not null),
    'active_30d', (select count(*) from public.user_settings s
                   join auth.users u on u.id = s.user_id
                   join public.members m on m.email = lower(u.email)
                  where s.last_registered_at > now() - interval '30 days'),
    'users', coalesce((
      select jsonb_agg(jsonb_build_object(
               'email', m.email,
               'note', m.note,
               'is_admin', m.is_admin,
               'plan', m.plan,
               'added_at', m.created_at,
               'last_sign_in_at', u.last_sign_in_at,
               'verified', s.verified_at is not null,
               'last_registered_at', s.last_registered_at,
               'record_days', (select count(*) from public.shift_records r where r.user_id = u.id)
             ) order by m.is_admin desc, m.created_at)
        from public.members m
        left join auth.users u on lower(u.email) = m.email
        left join public.user_settings s on s.user_id = u.id
    ), '[]'::jsonb),
    -- ログインしたが許可リストに無い人(許可する候補)
    'pending', coalesce((
      select jsonb_agg(jsonb_build_object(
               'email', lower(u.email),
               'last_sign_in_at', u.last_sign_in_at
             ) order by u.last_sign_in_at desc nulls last)
        from auth.users u
       where u.email is not null
         and not exists (select 1 from public.members m where m.email = lower(u.email))
    ), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

-- ============================================================
-- 権限
-- ============================================================

-- 新しいプロジェクトでは表の権限が自動で付かない場合があるので明示する(実際に触れる行は RLS で絞る)
grant usage on schema public to authenticated, service_role;
grant select, insert, update, delete on public.members, public.shift_master, public.shift_records to authenticated;
grant select on public.user_settings to authenticated;
grant all on all tables in schema public to service_role;

-- 未ログイン(anon)には何も触らせない
revoke all on all tables in schema public from anon;
revoke execute on all functions in schema public from public, anon;

grant execute on function public.current_email() to authenticated;
grant execute on function public.normalize_time(text) to authenticated;
grant execute on function public.is_member() to authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.replace_shift_master(jsonb) to authenticated;
grant execute on function public.save_month_records(int, int, jsonb) to authenticated;
grant execute on function public.admin_stats() to authenticated;

-- ロックと祝日の書き込みは Edge Function(service_role)だけ
revoke all on public.holidays, public.holiday_years from authenticated;
grant select on public.holidays, public.holiday_years to authenticated;
grant execute on function public.acquire_user_lock(uuid, int) to service_role;
grant execute on function public.release_user_lock(uuid) to service_role;
