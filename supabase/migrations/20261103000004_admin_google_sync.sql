-- 管理画面の「接続」: Googleカレンダーにも登録しない人(保存だけの人)は、接続テストをしないので、「—」ではなく「保」と出す。
--   stats.verified は Google に登録する人だけの接続テスト済み。stats.google_users(Google に登録する人)・stats.save_only(保存だけの人)を足す。
--   users_list に google_sync を足す(設定の行がまだ無い人は null)。
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
    -- 接続テスト済みは、Googleカレンダーにも登録する人(google_sync)だけを数える。保存だけの人は、別に数える
    'verified', (select count(*) from public.user_settings s
                   join public.profiles p on p.user_id = s.user_id and p.role = 'user'
                  where s.verified_at is not null and s.google_sync),
    'google_users', (select count(*) from public.user_settings s
                       join public.profiles p on p.user_id = s.user_id and p.role = 'user'
                      where s.google_sync),
    'save_only', (select count(*) from public.user_settings s
                    join public.profiles p on p.user_id = s.user_id and p.role = 'user'
                   where not s.google_sync and s.office_id is not null),
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
               'google_sync', s.google_sync,
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
