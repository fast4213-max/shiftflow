-- shiftflow 初期スキーマ(設計書 第2版)
--
-- ログインは「社員番号(7桁)+ PIN(6桁)」。内部では Supabase Auth のユーザー
-- (メール = <社員番号>@users.shiftflow.invalid)として扱い、利用者にメールは見せない。
-- ユーザーは Edge Function(sign-up / admin-login)だけが作る。
--
-- テーブル
--   profiles       利用者(社員番号・名前・権限・プラン)
--   offices        区所(区所ごとに勤務コードマスタを持つ)
--   shift_master   勤務コードマスタ(全員が読む。書くのは管理者だけ)
--   user_settings  区所・カレンダーID・検証状態(本人だけ)
--   shift_records  勤務記録(本人だけ)
--   holidays       祝日のキャッシュ(全員が読む。書くのは Edge Function だけ)
--   app_secrets    新規登録用の共通パスワード(ハッシュだけ。誰も直接読めない)
--   auth_attempts  ログイン・登録の失敗回数(ロック用。Edge Function だけ)
--
-- すべて RLS を有効にする。anon(未ログイン)には keepalive() 以外を見せない。
-- Edge Function は service_role で動く部分(ユーザー作成・検証済みフラグ・ロック・祝日)だけ RLS を越える。

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ============================================================
-- 共通関数
-- ============================================================

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
-- profiles(利用者)
-- ============================================================

create table public.profiles (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  employee_no text unique check (employee_no ~ '^\d{7}$'),   -- 社員番号(管理者は null)
  family_name text not null default '' check (char_length(family_name) <= 30),
  given_name  text not null default '' check (char_length(given_name) <= 30),
  role        text not null default 'user' check (role in ('user', 'admin')),
  plan        text not null default 'free',   -- 将来の課金用。今は全員 free
  created_at  timestamptz not null default now(),
  check (role = 'admin' or (employee_no is not null and btrim(family_name) <> '' and btrim(given_name) <> ''))
);

comment on table public.profiles is '利用者。社員番号と名前は Supabase の中にだけ保存する(リポジトリには入れない)';
comment on column public.profiles.plan is '将来の課金用。今は全員 free';

-- 判定用の関数(RLS から呼ぶので security definer)
create or replace function public.is_member()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.profiles where user_id = auth.uid())
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.profiles where user_id = auth.uid() and role = 'admin')
$$;

alter table public.profiles enable row level security;

-- 本人の行と、管理者は全員分を読める。作成・更新・削除は Edge Function(service_role)だけ
create policy profiles_select on public.profiles
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- ============================================================
-- offices(区所)
-- ============================================================

create table public.offices (
  id         bigint generated always as identity primary key,
  name       text not null unique check (btrim(name) <> ''),
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

comment on table public.offices is '区所。区所ごとに勤務コードマスタを持つ';

alter table public.offices enable row level security;

create policy offices_select on public.offices
  for select to authenticated
  using (public.is_member());

create policy offices_admin_write on public.offices
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ============================================================
-- shift_master(勤務コードマスタ。区所ごと)
-- ============================================================

create table public.shift_master (
  office_id     bigint not null references public.offices (id) on delete cascade,
  code          text not null check (code <> ''),          -- 番号(行路番号)
  kind          text not null check (kind in ('泊', '日勤', '休日')),  -- 種別
  weekday_start text not null default '',                  -- 平日出勤 (H:MM)
  weekday_end   text not null default '',                  -- 平日退勤
  holiday_start text not null default '',                  -- 休日出勤
  holiday_end   text not null default '',                  -- 休日退勤
  stay          text not null default '',                  -- 泊(泊地)
  sort_order    int  not null default 0,                   -- 一覧の並び順(CSVの行順)
  updated_at    timestamptz not null default now(),
  primary key (office_id, code)
);

comment on table public.shift_master is '勤務コードマスタ。管理画面で区所を選んで CSV を取り込み、丸ごと入れ替える';

alter table public.shift_master enable row level security;

create policy shift_master_select on public.shift_master
  for select to authenticated
  using (public.is_member());

create policy shift_master_admin_write on public.shift_master
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- 区所のマスタを丸ごと入れ替える(管理画面の CSV 取り込み)
-- rows: [{code, kind, weekday_start, weekday_end, holiday_start, holiday_end, stay}, ...] (並び順どおり)
create or replace function public.replace_shift_master(p_office_id bigint, rows jsonb)
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
  if not exists (select 1 from public.offices where id = p_office_id) then
    raise exception '区所が見つかりません';
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

  delete from public.shift_master where office_id = p_office_id;
  insert into public.shift_master
    (office_id, code, kind, weekday_start, weekday_end, holiday_start, holiday_end, stay, sort_order)
  select p_office_id, code, kind, weekday_start, weekday_end, holiday_start, holiday_end, stay, sort_order
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
  office_id           bigint references public.offices (id) on delete set null,  -- 自分の区所
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
-- 新規登録用の共通パスワード / ログイン失敗のロック
-- ============================================================

-- 共通パスワードのハッシュ(1行だけ)。RLS 有効・ポリシーなし・権限なしで誰にも読ませない
create table public.app_secrets (
  id                   int primary key default 1 check (id = 1),
  signup_password_hash text,
  updated_at           timestamptz not null default now()
);

alter table public.app_secrets enable row level security;

-- ログイン・登録の失敗回数。key は 'emp:<社員番号>' / 'admin' / 'signup:<IP>'
create table public.auth_attempts (
  key          text primary key,
  failed_count int not null default 0,
  locked_until timestamptz,
  updated_at   timestamptz not null default now()
);

alter table public.auth_attempts enable row level security;

-- 管理画面から共通パスワードを設定・変更する(管理者だけ)
create or replace function public.set_signup_password(new_password text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception '管理者だけが実行できます' using errcode = '42501';
  end if;
  if char_length(coalesce(new_password, '')) < 8 then
    raise exception '共通パスワードは8文字以上にしてください';
  end if;
  insert into public.app_secrets (id, signup_password_hash)
    values (1, extensions.crypt(new_password, extensions.gen_salt('bf', 10)))
    on conflict (id) do update set signup_password_hash = excluded.signup_password_hash, updated_at = now();
end;
$$;

-- 共通パスワードが設定済みか(管理画面の表示用)
create or replace function public.signup_password_is_set()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception '管理者だけが実行できます' using errcode = '42501';
  end if;
  return exists (select 1 from public.app_secrets where id = 1 and signup_password_hash is not null);
end;
$$;

-- 共通パスワードの照合(Edge Function から service_role で呼ぶ)
-- 戻り値: 'ok' / 'wrong' / 'not_set'
create or replace function public.check_signup_password(p_password text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  h text;
begin
  select signup_password_hash into h from public.app_secrets where id = 1;
  if h is null then
    return 'not_set';
  end if;
  return case when extensions.crypt(coalesce(p_password, ''), h) = h then 'ok' else 'wrong' end;
end;
$$;

-- ロック中なら解除時刻を返す(ロックされていなければ null)
create or replace function public.auth_attempt_locked_until(p_key text)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select locked_until from public.auth_attempts where key = p_key and locked_until > now()
$$;

-- 失敗を1回記録する。p_max 回に達したら p_minutes 分ロックして回数を0に戻す。ロック解除時刻(無ければ null)を返す
create or replace function public.auth_attempt_fail(p_key text, p_max int default 5, p_minutes int default 15)
returns timestamptz
language plpgsql
set search_path = ''
as $$
declare
  rec public.auth_attempts;
begin
  insert into public.auth_attempts (key, failed_count) values (p_key, 1)
    on conflict (key) do update
      set failed_count = case when public.auth_attempts.locked_until is not null and public.auth_attempts.locked_until <= now()
                              then 1 else public.auth_attempts.failed_count + 1 end,
          -- ロックが終わっていたら解除の印も消す(消さないと、次のロックの数え直しが毎回1に戻ってしまう)
          locked_until = case when public.auth_attempts.locked_until <= now() then null
                              else public.auth_attempts.locked_until end,
          updated_at = now()
    returning * into rec;
  if rec.failed_count >= p_max then
    update public.auth_attempts
       set failed_count = 0, locked_until = now() + make_interval(mins => p_minutes)
     where key = p_key
    returning locked_until into rec.locked_until;
    return rec.locked_until;
  end if;
  return null;
end;
$$;

create or replace function public.auth_attempt_reset(p_key text)
returns void
language sql
set search_path = ''
as $$
  delete from public.auth_attempts where key = p_key
$$;

-- ============================================================
-- keepalive(無料プランの一時停止対策。cron-job.org から定期的に呼ぶ)
-- ============================================================

-- データベースを実際に読んで、時刻だけを返す。個人のデータは返さない。未ログインでも呼べる
create or replace function public.keepalive()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('ok', true, 'at', now(), 'offices', (select count(*) from public.offices))
$$;

-- ============================================================
-- 管理画面のダッシュボード
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
    'users', (select count(*) from public.profiles where role = 'user'),
    'verified', (select count(*) from public.user_settings s
                   join public.profiles p on p.user_id = s.user_id and p.role = 'user'
                  where s.verified_at is not null),
    'active_30d', (select count(*) from public.user_settings s
                   join public.profiles p on p.user_id = s.user_id and p.role = 'user'
                  where s.last_registered_at > now() - interval '30 days'),
    'signups_7d', (select count(*) from public.profiles
                    where role = 'user' and created_at > now() - interval '7 days'),
    'signup_password_set', exists (select 1 from public.app_secrets where id = 1 and signup_password_hash is not null),
    'offices', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', o.id,
               'name', o.name,
               'master_count', (select count(*) from public.shift_master sm where sm.office_id = o.id),
               'user_count', (select count(*) from public.user_settings s
                                join public.profiles p on p.user_id = s.user_id and p.role = 'user'
                               where s.office_id = o.id)
             ) order by o.sort_order, o.id)
        from public.offices o
    ), '[]'::jsonb),
    'no_office', (select count(*) from public.profiles p
                   left join public.user_settings s on s.user_id = p.user_id
                  where p.role = 'user' and s.office_id is null),
    'users_list', coalesce((
      select jsonb_agg(jsonb_build_object(
               'user_id', p.user_id,
               'employee_no', p.employee_no,
               'family_name', p.family_name,
               'given_name', p.given_name,
               'plan', p.plan,
               'created_at', p.created_at,
               'last_sign_in_at', u.last_sign_in_at,
               'office', o.name,
               'verified', s.verified_at is not null,
               'last_registered_at', s.last_registered_at,
               'record_days', (select count(*) from public.shift_records r where r.user_id = p.user_id)
             ) order by p.created_at desc)
        from public.profiles p
        left join auth.users u on u.id = p.user_id
        left join public.user_settings s on s.user_id = p.user_id
        left join public.offices o on o.id = s.office_id
       where p.role = 'user'
    ), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

-- ============================================================
-- 権限
-- ============================================================

-- 表: 新しいプロジェクトでは権限が自動で付かない場合があるので明示する(実際に触れる行は RLS で絞る)
grant usage on schema public to anon, authenticated, service_role;
revoke all on all tables in schema public from anon, authenticated;
grant select on public.profiles, public.holidays, public.holiday_years to authenticated;
grant select, insert, update, delete on public.offices, public.shift_master, public.shift_records to authenticated;
grant select on public.user_settings to authenticated;
-- 利用者が書けるのは区所とカレンダーIDだけ(検証済みフラグなどは書けない)
grant insert (user_id, office_id, work_calendar_id, holiday_calendar_id) on public.user_settings to authenticated;
grant update (office_id, work_calendar_id, holiday_calendar_id) on public.user_settings to authenticated;
-- app_secrets / auth_attempts は authenticated に一切渡さない(関数経由だけ)
grant all on all tables in schema public to service_role;

-- 関数: Supabase は新しい関数に anon / authenticated の実行権限を自動で付けるので、
-- いったん全部外してから必要なものだけ付ける
revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function public.normalize_time(text) to authenticated;
grant execute on function public.is_member() to authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.replace_shift_master(bigint, jsonb) to authenticated;
grant execute on function public.save_month_records(int, int, jsonb) to authenticated;
grant execute on function public.set_signup_password(text) to authenticated;
grant execute on function public.signup_password_is_set() to authenticated;
grant execute on function public.admin_stats() to authenticated;

-- 未ログインで呼べるのは keepalive だけ(cron-job.org 用)
grant execute on function public.keepalive() to anon, authenticated;

-- Edge Function(service_role)だけ
grant execute on function public.check_signup_password(text) to service_role;
grant execute on function public.auth_attempt_locked_until(text) to service_role;
grant execute on function public.auth_attempt_fail(text, int, int) to service_role;
grant execute on function public.auth_attempt_reset(text) to service_role;
grant execute on function public.acquire_user_lock(uuid, int) to service_role;
grant execute on function public.release_user_lock(uuid) to service_role;
