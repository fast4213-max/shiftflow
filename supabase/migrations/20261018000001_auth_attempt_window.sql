-- ログインの失敗を、長い期間でも数える(22回目のデバッグ AD1)。
-- 今までのロック(短い期間)は、解けると数え直しになるので、長い期間で数える2つ目の数え方を足す。
-- 回数・期間は呼ぶ側(Edge Function の _shared/attempts.ts)が決める。

-- 失敗を1回記録する。前の失敗から p_window_minutes 分より空いていたら数え直す。
-- p_max 回に達したら p_lock_minutes 分ロックして回数を0に戻す。ロック解除時刻(無ければ null)を返す
create or replace function public.auth_attempt_fail_window(p_key text, p_max int, p_window_minutes int, p_lock_minutes int)
returns timestamptz
language plpgsql
set search_path = ''
as $$
declare
  rec public.auth_attempts;
begin
  insert into public.auth_attempts (key, failed_count) values (p_key, 1)
    on conflict (key) do update
      set failed_count = case
            when public.auth_attempts.locked_until is not null and public.auth_attempts.locked_until <= now() then 1
            when public.auth_attempts.updated_at < now() - make_interval(mins => p_window_minutes) then 1
            else public.auth_attempts.failed_count + 1 end,
          locked_until = case when public.auth_attempts.locked_until <= now() then null
                              else public.auth_attempts.locked_until end,
          updated_at = now()
    returning * into rec;
  if rec.failed_count >= p_max then
    update public.auth_attempts
       set failed_count = 0, locked_until = now() + make_interval(mins => p_lock_minutes)
     where key = p_key
    returning locked_until into rec.locked_until;
    return rec.locked_until;
  end if;
  return null;
end;
$$;

revoke execute on function public.auth_attempt_fail_window(text, int, int, int) from public, anon, authenticated;
grant execute on function public.auth_attempt_fail_window(text, int, int, int) to service_role;
