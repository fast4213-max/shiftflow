-- 勤務コードマスタに「平休退勤」「休平退勤」を足す。
--   平休退勤: 平日に泊 → 休日に非番 のときの退勤(空なら休日退勤を使う)
--   休平退勤: 休日に泊 → 平日に非番 のときの退勤(空なら平日退勤を使う)
-- どちらも任意。今あるマスタの行は空になり、退勤の選び方は今までと同じ。

alter table public.shift_master
  add column weekday_holiday_end text not null default '',  -- 平休退勤
  add column holiday_weekday_end text not null default '';  -- 休平退勤

-- 区所のマスタを丸ごと入れ替える(管理画面の CSV 取り込み)
-- rows: [{code, kind, weekday_start, weekday_end, holiday_start, holiday_end, weekday_holiday_end, holiday_weekday_end, stay}, ...] (並び順どおり)
-- weekday_holiday_end / holiday_weekday_end は無くてもよい(空になる)
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
    trim(r ->> 'code')                                    as code,
    trim(r ->> 'kind')                                    as kind,
    public.normalize_time(r ->> 'weekday_start')          as weekday_start,
    public.normalize_time(r ->> 'weekday_end')            as weekday_end,
    public.normalize_time(r ->> 'holiday_start')          as holiday_start,
    public.normalize_time(r ->> 'holiday_end')            as holiday_end,
    public.normalize_time(r ->> 'weekday_holiday_end')    as weekday_holiday_end,
    public.normalize_time(r ->> 'holiday_weekday_end')    as holiday_weekday_end,
    coalesce(trim(r ->> 'stay'), '')                      as stay,
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

  delete from public.shift_master where office_id = p_office_id;
  insert into public.shift_master
    (office_id, code, kind, weekday_start, weekday_end, holiday_start, holiday_end,
     weekday_holiday_end, holiday_weekday_end, stay, sort_order)
  select p_office_id, code, kind, weekday_start, weekday_end, holiday_start, holiday_end,
         weekday_holiday_end, holiday_weekday_end, stay, sort_order
    from incoming;
  get diagnostics n = row_count;
  return n;
end;
$$;
