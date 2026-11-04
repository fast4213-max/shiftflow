-- 管理画面の概要・利用者の見直し(2026-11-04・ご依頼)
--   最終登録 → 「最終登録・保存」: Googleカレンダーへの登録だけでなく、保存(アプリ内カレンダー・勤務入力の「保存」)も数える。
--     勤務の記録(shift_records)の最後の更新日時と、last_registered_at の新しい方を使う。
--   30日以内に登録した人: 登録と保存を合算して数える(users_list の最終登録・保存と同じ基準)。
--   直近7日の新規登録(signups_7d)は画面から外したので、返さない。
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
    -- 30日以内に登録・保存した人(Googleへの登録も、保存のみも合算)
    'active_30d', (select count(*) from public.profiles p
                    left join public.user_settings s on s.user_id = p.user_id
                   where p.role = 'user'
                     and greatest(s.last_registered_at, (select max(r.updated_at) from public.shift_records r where r.user_id = p.user_id))
                         > now() - interval '30 days'),
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
               'last_registered_at', greatest(s.last_registered_at, (select max(r.updated_at) from public.shift_records r where r.user_id = p.user_id)),
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
