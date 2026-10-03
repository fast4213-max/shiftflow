-- ログイン・登録の失敗回数(auth_attempts)のうち、30日以上更新されていない行を自動で消す。
-- 失敗回数は、ログインに成功したときしか減らない。何か月も前に数回失敗しただけの社員番号や IP が残り続けないようにする。
-- ロック中の行(ロックは15分)は updated_at が直近なので、ここでは消えず、ロックの動きは変わらない。

create or replace function public.purge_old_auth_attempts()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  n bigint;
begin
  delete from public.auth_attempts
   where updated_at < now() - interval '30 days'
     and (locked_until is null or locked_until < now());
  get diagnostics n = row_count;
  return n;
end;
$$;

-- 利用者(anon / authenticated)からは呼べないようにする。Supabase は新しい関数に自動で実行権限を付けるので外す
revoke execute on function public.purge_old_auth_attempts() from public, anon, authenticated;

-- 毎日 日本時間の午前3時10分(UTC 18:10)に実行する。pg_cron を設定できなくても migration 全体は失敗させない
do $$
begin
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname = 'purge-old-auth-attempts';
  perform cron.schedule('purge-old-auth-attempts', '10 18 * * *', 'select public.purge_old_auth_attempts()');
exception when others then
  raise notice 'pg_cron を設定できませんでした(%)。README の「古い勤務記録・ログイン記録の自動削除」を参照して手動で登録してください', sqlerrm;
end
$$;
