-- 交番表から自動入力。設計は docs/kouban/DESIGN.md
--
-- kouban_tables: マスタの切替日(master_periods)ごとの交番表(JSON。中身の確かめは画面の web/js/kouban.js)。
--   読むのは利用者全員、書くのは下の管理者用の関数だけ。切替日を消すと一緒に消える。名前は入れない。
-- user_settings.kouban: 自分の位置(切替日ごと)と設定(行路も入れるか・予備のとき休を入れるか)。本人が書く。

create table public.kouban_tables (
  period_id  bigint primary key references public.master_periods (id) on delete cascade,
  data       jsonb not null check (jsonb_typeof(data) = 'object' and (data ->> 'v') = '1' and pg_column_size(data) <= 200000),
  updated_at timestamptz not null default now()
);

comment on table public.kouban_tables is '交番表(マスタの切替日ごと)。書くのは管理者の関数だけ。名前は入れない';

alter table public.kouban_tables enable row level security;

create policy kouban_tables_select on public.kouban_tables
  for select to authenticated
  using (public.is_member());

revoke all on public.kouban_tables from anon, authenticated;
grant select on public.kouban_tables to authenticated;
grant all on public.kouban_tables to service_role;

-- 交番表を入れる(管理画面)。p_period_ids の切替日全部に同じ交番表を入れる(同じ切替日の、天王寺車掌区の区所にまとめて)。入れた数を返す
create or replace function public.save_kouban(p_period_ids bigint[], p_data jsonb)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  n int;
begin
  if not public.is_admin() then
    raise exception '管理者だけが実行できます' using errcode = '42501';
  end if;
  if p_period_ids is null or cardinality(p_period_ids) = 0 then
    raise exception '入れる先の切替日がありません';
  end if;
  if (select count(*) from public.master_periods where id = any (p_period_ids)) <> (select count(distinct x) from unnest(p_period_ids) x) then
    raise exception 'マスタが見つかりません(ほかの画面で消されたかもしれません)。画面を読み直してください';
  end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' or (p_data ->> 'v') is distinct from '1' then
    raise exception '交番表の形が違います';
  end if;
  insert into public.kouban_tables (period_id, data, updated_at)
  select distinct x, p_data, now() from unnest(p_period_ids) x
  on conflict (period_id) do update set data = excluded.data, updated_at = excluded.updated_at;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- 交番表を消す(管理画面)。消した数を返す
create or replace function public.delete_kouban(p_period_ids bigint[])
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  n int;
begin
  if not public.is_admin() then
    raise exception '管理者だけが実行できます' using errcode = '42501';
  end if;
  delete from public.kouban_tables where period_id = any (coalesce(p_period_ids, '{}'));
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke execute on function public.save_kouban(bigint[], jsonb) from public, anon;
revoke execute on function public.delete_kouban(bigint[]) from public, anon;
grant execute on function public.save_kouban(bigint[], jsonb) to authenticated;
grant execute on function public.delete_kouban(bigint[]) to authenticated;

-- 自分の位置と設定
alter table public.user_settings
  add column if not exists kouban jsonb not null default '{}'::jsonb;
alter table public.user_settings
  add constraint user_settings_kouban_check check (jsonb_typeof(kouban) = 'object' and pg_column_size(kouban) <= 4000);

comment on column public.user_settings.kouban is
  '交番表: {"pos":{"<切替日のid>":{"r":行,"c":名前の欄}},"routes":行路も入れる,"spareOff":予備のとき休を入れる}';

grant insert (kouban) on public.user_settings to authenticated;
grant update (kouban) on public.user_settings to authenticated;
