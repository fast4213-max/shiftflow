-- マスタの切替(ダイヤ改正・ダイヤ修正)。設計は docs/DESIGN.md の「マスタの切替」
--
-- 区所ごとに、マスタを「切替日」つきで複数持つ(master_periods)。shift_master の行は、どの切替日のマスタかを period_id で持つ。
--   ある日に使うマスタ = その日以前に始まったもののうち、いちばん新しいもの。
--   区所のいちばん古いマスタは、切替日より前の日にも使う(始まりの日は表示のためのもの)。
--   切替日の前日の泊は、泊の日(出勤・泊地)は前のマスタ、非番の日(退勤)は新しいマスタ(予定の組み立て plan.js)。
-- 今あるマスタは、全部「2026年10月3日からのダイヤ修正」にする(行は消さない。period_id を付けるだけ)。
-- 勤務の記録(shift_records)・カレンダーの予定には触れない。

create table public.master_periods (
  id         bigint generated always as identity primary key,
  office_id  bigint not null references public.offices (id) on delete cascade,
  starts_on  date not null,                                         -- 切替日(この日から使う)
  name       text not null default '' check (char_length(name) <= 20),  -- ダイヤ改正・ダイヤ修正 など
  updated_at timestamptz not null default now(),
  unique (office_id, starts_on),
  unique (id, office_id)  -- shift_master から (period_id, office_id) で参照する(別の区所の切替日に行を入れないため)
);

comment on table public.master_periods is 'マスタの切替日(ダイヤ改正・ダイヤ修正)。区所ごと。書くのは管理者の関数だけ';

alter table public.master_periods enable row level security;

create policy master_periods_select on public.master_periods
  for select to authenticated
  using (public.is_member());

-- 利用者・管理者は読むだけ(書くのは下の管理者用の関数だけ)
revoke all on public.master_periods from anon, authenticated;
grant select on public.master_periods to authenticated;
grant all on public.master_periods to service_role;

-- 今ある区所に、今のマスタの切替日を作る(2026年10月3日 ダイヤ修正)
insert into public.master_periods (office_id, starts_on, name)
select id, date '2026-10-03', 'ダイヤ修正' from public.offices;

-- 区所を追加したら、その区所のマスタの切替日を1つ作る(どの区所にも必ず1つある。今日から・名前なし)
create or replace function public.offices_add_master_period()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.master_periods (office_id, starts_on, name)
  values (new.id, (now() at time zone 'Asia/Tokyo')::date, '');
  return new;
end;
$$;

create trigger offices_add_master_period
  after insert on public.offices
  for each row execute function public.offices_add_master_period();

-- 今あるマスタの行に、その区所の切替日を付ける
alter table public.shift_master add column period_id bigint;
update public.shift_master sm set period_id = p.id
  from public.master_periods p where p.office_id = sm.office_id;
alter table public.shift_master alter column period_id set not null;
alter table public.shift_master drop constraint shift_master_pkey;
alter table public.shift_master add primary key (period_id, code);
alter table public.shift_master
  add constraint shift_master_period_fkey foreign key (period_id, office_id)
  references public.master_periods (id, office_id) on delete cascade;

-- 区所の、ある日に使う切替日(その日以前に始まったうちの最新。無ければいちばん古いもの)
create or replace function public.master_period_on(p_office_id bigint, p_date date)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select id from public.master_periods
   where office_id = p_office_id
   order by (starts_on <= p_date) desc, case when starts_on <= p_date then starts_on end desc, starts_on
   limit 1
$$;

-- 行を入れるときに period_id が無ければ、今日使っているマスタにする(ローカルの seed など)
create or replace function public.shift_master_default_period()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.period_id is null then
    new.period_id := public.master_period_on(new.office_id, (now() at time zone 'Asia/Tokyo')::date);
  end if;
  return new;
end;
$$;

create trigger shift_master_default_period
  before insert on public.shift_master
  for each row execute function public.shift_master_default_period();

-- 使われなくなった古い切替日(とそのマスタの行)を消す。
-- 勤務の記録は「前月の1日」から後だけ残る(purge_old_shift_records)ので、次の切替日がそれ以前に始まったマスタは、もう使わない
create or replace function public.purge_old_master_periods()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  n bigint;
begin
  delete from public.master_periods p
   where exists (
     select 1 from public.master_periods q
      where q.office_id = p.office_id
        and q.starts_on > p.starts_on
        and q.starts_on <= (date_trunc('month', (now() at time zone 'Asia/Tokyo')::date) - interval '1 month')::date
   );
  get diagnostics n = row_count;
  return n;
end;
$$;

-- 毎日の古い勤務記録の削除(pg_cron)で、古い切替日も消す
create or replace function public.purge_old_shift_records()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  n bigint;
begin
  delete from public.shift_records
   where date < (date_trunc('month', (now() at time zone 'Asia/Tokyo')::date) - interval '1 month')::date;
  get diagnostics n = row_count;
  perform public.purge_old_master_periods();
  return n;
end;
$$;

-- 切替日を作る・変える(管理画面)。p_period_id が null なら作る。作った・変えた切替日の id を返す
--   いちばん古い切替日(今までのマスタ)は、ほかの切替日より前の日にだけできる(切替日より前の日にも使うため)
--   それ以外は、今月の1日から後の日にだけできる(過ぎた月の勤務は入力できないので、そこから切り替えても意味がない)
create or replace function public.save_master_period(p_office_id bigint, p_period_id bigint, p_starts_on date, p_name text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  this_month date := date_trunc('month', (now() at time zone 'Asia/Tokyo')::date)::date;
  base_id bigint;
  id_out bigint;
  name_in text := coalesce(trim(p_name), '');
begin
  if not public.is_admin() then
    raise exception '管理者だけが実行できます' using errcode = '42501';
  end if;
  if not exists (select 1 from public.offices where id = p_office_id) then
    raise exception '区所が見つかりません';
  end if;
  if p_starts_on is null then
    raise exception '切替日を入れてください';
  end if;
  if char_length(name_in) > 20 then
    raise exception '名前は20文字までにしてください';
  end if;
  if p_period_id is not null and not exists (select 1 from public.master_periods where id = p_period_id and office_id = p_office_id) then
    raise exception 'マスタが見つかりません(ほかの画面で消されたかもしれません)。画面を読み直してください';
  end if;

  perform public.purge_old_master_periods();
  select id into base_id from public.master_periods where office_id = p_office_id order by starts_on limit 1;

  if p_period_id is not null and p_period_id = base_id then
    if exists (select 1 from public.master_periods where office_id = p_office_id and id <> base_id and starts_on <= p_starts_on) then
      raise exception 'いちばん古いマスタの切替日は、ほかのマスタの切替日より前にしてください';
    end if;
  else
    if p_starts_on < this_month then
      raise exception '切替日は、今月の1日から後の日にしてください';
    end if;
    if p_starts_on <= (select starts_on from public.master_periods where id = base_id) then
      raise exception '切替日は、いちばん古いマスタの切替日より後にしてください';
    end if;
  end if;
  if exists (select 1 from public.master_periods
              where office_id = p_office_id and starts_on = p_starts_on and id is distinct from p_period_id) then
    raise exception 'その日に切り替わるマスタがもうあります';
  end if;

  if p_period_id is null then
    insert into public.master_periods (office_id, starts_on, name)
    values (p_office_id, p_starts_on, name_in)
    returning id into id_out;
  else
    update public.master_periods set starts_on = p_starts_on, name = name_in, updated_at = now()
     where id = p_period_id
    returning id into id_out;
  end if;
  return id_out;
end;
$$;

-- まだ始まっていない切替日を消す(そのマスタの行も消える)。始まったもの・いちばん古いものは消せない
create or replace function public.delete_master_period(p_period_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.master_periods;
begin
  if not public.is_admin() then
    raise exception '管理者だけが実行できます' using errcode = '42501';
  end if;
  select * into p from public.master_periods where id = p_period_id;
  if not found then
    raise exception 'マスタが見つかりません(ほかの画面で消されたかもしれません)。画面を読み直してください';
  end if;
  if p.starts_on <= (now() at time zone 'Asia/Tokyo')::date then
    raise exception 'もう使っているマスタは消せません';
  end if;
  if p.id = (select id from public.master_periods where office_id = p.office_id order by starts_on limit 1) then
    raise exception 'いちばん古いマスタは消せません';
  end if;
  delete from public.master_periods where id = p_period_id;
end;
$$;

-- 切替日から後の日に、番号をもう入れている(保存・登録した)利用者の人数。
-- マスタを入れ替えたり切替日を変えたりしたあとに、登録し直しが要る人がいるかを知らせるため(管理画面)
create or replace function public.master_period_affected(p_period_id bigint)
returns int
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  p public.master_periods;
begin
  if not public.is_admin() then
    raise exception '管理者だけが実行できます' using errcode = '42501';
  end if;
  select * into p from public.master_periods where id = p_period_id;
  if not found then return 0; end if;
  -- 切替日の前日の泊(非番が切替日)も、退勤時間が変わるので数える
  return (select count(distinct r.user_id)::int
            from public.shift_records r
            join public.user_settings s on s.user_id = r.user_id and s.office_id = p.office_id
           where r.date >= p.starts_on - 1 and r.code <> '');
end;
$$;

-- 区所のマスタ(切替日ごと)を丸ごと入れ替える(管理画面の CSV 取り込み)
drop function public.replace_shift_master(bigint, jsonb);

create or replace function public.replace_shift_master(p_office_id bigint, p_period_id bigint, rows jsonb)
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
  if not exists (select 1 from public.master_periods where id = p_period_id and office_id = p_office_id) then
    raise exception 'マスタが見つかりません(ほかの画面で消されたかもしれません)。画面を読み直してください';
  end if;
  if jsonb_typeof(rows) <> 'array' or jsonb_array_length(rows) = 0 then
    raise exception 'マスタが空です';
  end if;

  drop table if exists pg_temp.incoming; -- 同じトランザクションで2回呼んでも止まらないように
  create temp table incoming on commit drop as
  select
    trim(r ->> 'code')                                    as code,
    trim(r ->> 'kind')                                    as kind,
    public.normalize_time(r ->> 'weekday_start')          as weekday_start,
    public.normalize_time(r ->> 'weekday_end')            as weekday_end,
    public.normalize_time(r ->> 'holiday_start')          as holiday_start,
    public.normalize_time(r ->> 'holiday_end')            as holiday_end,
    public.normalize_time(r ->> 'weekday_holiday_start')  as weekday_holiday_start,
    public.normalize_time(r ->> 'weekday_holiday_end')    as weekday_holiday_end,
    public.normalize_time(r ->> 'holiday_weekday_start')  as holiday_weekday_start,
    public.normalize_time(r ->> 'holiday_weekday_end')    as holiday_weekday_end,
    coalesce(trim(r ->> 'stay'), '')                      as stay,
    coalesce(trim(r ->> 'stay_next_holiday'), '')         as stay_next_holiday,
    ord::int                                              as sort_order
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

  delete from public.shift_master where period_id = p_period_id;
  insert into public.shift_master
    (office_id, period_id, code, kind, weekday_start, weekday_end, holiday_start, holiday_end,
     weekday_holiday_start, weekday_holiday_end, holiday_weekday_start, holiday_weekday_end, stay, stay_next_holiday, sort_order)
  select p_office_id, p_period_id, code, kind, weekday_start, weekday_end, holiday_start, holiday_end,
         weekday_holiday_start, weekday_holiday_end, holiday_weekday_start, holiday_weekday_end, stay, stay_next_holiday, sort_order
    from incoming;
  get diagnostics n = row_count;
  update public.master_periods set updated_at = now() where id = p_period_id;
  return n;
end;
$$;

-- 管理画面のダッシュボード: 区所ごとのマスタの件数は「今日使っているマスタ」の件数にし、切替日の一覧(periods)を足す
create or replace function public.admin_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
  today date := (now() at time zone 'Asia/Tokyo')::date;
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
    'today', today,
    'offices', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', o.id,
               'name', o.name,
               'master_count', (select count(*) from public.shift_master sm
                                 where sm.period_id = public.master_period_on(o.id, today)),
               'periods', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'id', mp.id,
                          'starts_on', mp.starts_on,
                          'name', mp.name,
                          'count', (select count(*) from public.shift_master sm where sm.period_id = mp.id)
                        ) order by mp.starts_on)
                   from public.master_periods mp where mp.office_id = o.id
               ), '[]'::jsonb),
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

-- 関数の実行権限: Supabase は新しい関数に自動で付けるので、外してから必要なものだけ付ける
revoke execute on function public.offices_add_master_period() from public, anon, authenticated;
revoke execute on function public.shift_master_default_period() from public, anon, authenticated;
revoke execute on function public.master_period_on(bigint, date) from public, anon, authenticated;
revoke execute on function public.purge_old_master_periods() from public, anon, authenticated;
revoke execute on function public.purge_old_shift_records() from public, anon, authenticated;
revoke execute on function public.save_master_period(bigint, bigint, date, text) from public, anon;
revoke execute on function public.delete_master_period(bigint) from public, anon;
revoke execute on function public.master_period_affected(bigint) from public, anon;
revoke execute on function public.replace_shift_master(bigint, bigint, jsonb) from public, anon;
revoke execute on function public.admin_stats() from public, anon;
grant execute on function public.save_master_period(bigint, bigint, date, text) to authenticated;
grant execute on function public.delete_master_period(bigint) to authenticated;
grant execute on function public.master_period_affected(bigint) to authenticated;
grant execute on function public.replace_shift_master(bigint, bigint, jsonb) to authenticated;
grant execute on function public.admin_stats() to authenticated;
