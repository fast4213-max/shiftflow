-- save_month_records: 存在しない日付のキー(2026-02-30 など)が入っていても、エラーにせず読み飛ばす。
-- 今までは、形(yyyy-mm-dd)が合っていて日付として読めないキーがあると、日付への変換でエラー(500)になった。
-- アプリの画面と register-month は月の日付しか送らないので、本人が直接呼んだときだけ起きていた。
-- 動きは今までと同じ(その月の記録を消して、月内の日付の分を入れ直す)。データは変えない。

create or replace function public.save_month_records(p_year int, p_month int, p_entries jsonb)
returns int
language plpgsql
security invoker
set search_path = ''
as $$
declare
  first_day date := make_date(p_year, p_month, 1);
  next_first date := (make_date(p_year, p_month, 1) + interval '1 month')::date;
  n int := 0;
  rec record;
  d date;
  c text;
  m text;
begin
  delete from public.shift_records
   where user_id = auth.uid() and date >= first_day and date < next_first;

  for rec in
    select e.k, e.v
      from jsonb_each(coalesce(p_entries, '{}'::jsonb)) as e(k, v)
     where e.k ~ '^\d{4}-\d{2}-\d{2}$'
  loop
    begin
      d := rec.k::date;
    exception when others then
      continue; -- 存在しない日付は読み飛ばす
    end;
    if d < first_day or d >= next_first then
      continue; -- 月外の日付は無視する
    end if;
    c := trim(coalesce(rec.v ->> 'code', ''));
    m := trim(coalesce(rec.v ->> 'memo', ''));
    if c = '' and m = '' then
      continue;
    end if;
    insert into public.shift_records (user_id, date, code, memo) values (auth.uid(), d, c, m);
    n := n + 1;
  end loop;
  return n;
end;
$$;
