-- PINを再設定・変更したときに、その人のログイン状態(セッション)を消す関数。
-- スマホを落とした・他人にPINを知られたときに、管理者がPINを再設定すれば、その端末からは使えなくなるように。
-- 消すのは Supabase Auth のセッション(auth.sessions。ログインの更新に使う refresh_tokens も一緒に消える)だけで、
-- 勤務の記録・設定・マスタ・アカウントには触らない。
--   p_keep_session: 残すセッション(PINを変えた本人の、変えたあとの新しいログイン)。null なら全部消す
-- Edge Function(service_role)からだけ呼ぶ。

create or replace function public.revoke_user_sessions(p_user_id uuid, p_keep_session uuid default null)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  n int;
begin
  delete from auth.sessions
   where user_id = p_user_id
     and (p_keep_session is null or id <> p_keep_session);
  get diagnostics n = row_count;
  return n;
end;
$$;

-- 利用者(anon / authenticated)からは呼べないようにする。Supabase は新しい関数に自動で実行権限を付けるので外す
revoke execute on function public.revoke_user_sessions(uuid, uuid) from public, anon, authenticated;
grant execute on function public.revoke_user_sessions(uuid, uuid) to service_role;

-- この関数を作った役割(関数はこの役割の権限で動く)が auth.sessions を消せるか、反映のログに出す(データは変えない)。
-- 消せないときは、PINの再設定・変更の画面に「ログインは消せませんでした」と出る(PINの変更そのものはできる)
do $$
begin
  raise notice 'revoke_user_sessions: % can delete auth.sessions = %',
    current_user, has_table_privilege(current_user, 'auth.sessions', 'DELETE');
end
$$;
