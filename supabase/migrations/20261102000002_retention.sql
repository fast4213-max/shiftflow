-- 保存期間(自作カレンダーに合わせて延ばす)。設計は docs/mycalendar/DESIGN.md。
--   勤務の記録(shift_records)と、使い終わった古いマスタ(切替日): 13か月(日本時間で、13か月前の月の1日より前を消す)
--     1年前の月まで見返せるようにするため。1か月の余裕は、月またぎの非番判定が前月末の記録を使うのと同じ理由。
--     古いマスタの消す条件は「次の切替日が13か月前の月の1日以前」(個数の上限は付けない。半年ごとの改正なら3つ前後残る)。
--   カレンダーの予定・スタンプ: 12か月(12か月前の月の1日より前を消す)。画面も12か月前の月までしか戻れない。
--     繰り返しの予定は、終わりの日が無いものは消さない。予定の写真が残っている予定は消さない(写真のファイルは、持ち主が
--     カレンダーを開いたときに、期限(予定の終了日から1か月)を過ぎたものから消える。ファイルを消してから行が消えるので、消し忘れが出ない)。
-- 毎日 日本時間の午前3時の削除(pg_cron の purge-old-shift-records)が、これらをまとめて行う。

-- 消える件数だけを数える(消す前の確認用)
create or replace function public.count_old_shift_records()
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select count(*) from public.shift_records
   where date < (date_trunc('month', (now() at time zone 'Asia/Tokyo')::date) - interval '13 months')::date
$$;

-- 古いマスタ(切替日): 次の切替日が13か月前の月の1日以前で、次の切替日にマスタの行があるものを消す
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
        and q.starts_on <= (date_trunc('month', (now() at time zone 'Asia/Tokyo')::date) - interval '13 months')::date
        and exists (select 1 from public.shift_master sm where sm.period_id = q.id)
   );
  get diagnostics n = row_count;
  return n;
end;
$$;

-- カレンダーの古い予定・スタンプ(12か月前の月の1日より前)。消した件数を返す
create or replace function public.purge_old_calendar()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  cutoff date := (date_trunc('month', (now() at time zone 'Asia/Tokyo')::date) - interval '12 months')::date;
  n bigint := 0;
  k bigint;
begin
  delete from public.cal_events e
   where not exists (select 1 from public.cal_photos p where p.event_id = e.id)
     and ((e.repeat_rule = 'none' and e.end_date < cutoff)
          or (e.repeat_rule <> 'none' and e.repeat_until is not null and e.repeat_until < cutoff));
  get diagnostics k = row_count;
  n := n + k;
  delete from public.cal_stamps where date < cutoff;
  get diagnostics k = row_count;
  n := n + k;
  return n;
end;
$$;

-- 毎日の削除(pg_cron)。勤務の記録を消し、古いマスタとカレンダーの古い予定・スタンプも片付ける
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
   where date < (date_trunc('month', (now() at time zone 'Asia/Tokyo')::date) - interval '13 months')::date;
  get diagnostics n = row_count;
  perform public.purge_old_master_periods();
  perform public.purge_old_calendar();
  return n;
end;
$$;

revoke execute on function public.count_old_shift_records() from public, anon, authenticated;
revoke execute on function public.purge_old_master_periods() from public, anon, authenticated;
revoke execute on function public.purge_old_calendar() from public, anon, authenticated;
revoke execute on function public.purge_old_shift_records() from public, anon, authenticated;
