-- 古い勤務記録(shift_records)の自動削除。
-- 画面は今月より前に戻れず、記録を読むのは「前月末の1日分(月またぎの非番判定)」と今月以降だけ。
-- そこで、日本時間で「前月の1日」より前の記録を消す(例: 10月なら 9月1日より前 = 8月以前)。
-- Google カレンダーの予定には触れない(DB の行を消すだけ)。

-- 消える件数だけを数える(消す前の確認用。SQL エディタから select public.count_old_shift_records(); で呼ぶ)
create or replace function public.count_old_shift_records()
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select count(*) from public.shift_records
   where date < (date_trunc('month', (now() at time zone 'Asia/Tokyo')::date) - interval '1 month')::date
$$;

-- 実際に消す。消した件数を返す
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
  return n;
end;
$$;

-- 利用者(anon / authenticated)からは呼べないようにする。Supabase は新しい関数に自動で実行権限を付けるので外す
revoke execute on function public.count_old_shift_records() from public, anon, authenticated;
revoke execute on function public.purge_old_shift_records() from public, anon, authenticated;

-- 毎日 日本時間の午前3時(UTC 18:00)に実行する。何度実行しても同じ結果になるので、取りこぼしても翌日に追いつく。
-- pg_cron が使えない環境でも migration 全体は失敗させない(その場合は README の手順で手動登録する)
do $$
begin
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname = 'purge-old-shift-records';
  perform cron.schedule('purge-old-shift-records', '0 18 * * *', 'select public.purge_old_shift_records()');
exception when others then
  raise notice 'pg_cron を設定できませんでした(%)。README の「古い勤務記録の自動削除」を参照して手動で登録してください', sqlerrm;
end
$$;
