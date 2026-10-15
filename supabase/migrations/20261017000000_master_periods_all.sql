-- マスタの切替日(ダイヤ改正・ダイヤ修正)を、全部の区所にまとめて作る・直す・消す(管理画面)。
-- ダイヤ改正・ダイヤ修正の日はどの区所も同じなので、区所ごとに作る手間と、作り忘れを減らす。CSV は今までどおり区所ごと。
-- 1つの区所で失敗したら、全部を元に戻す(区所の名前を付けて知らせる)。

-- p_old_starts_on が null: 全部の区所に p_starts_on の切替日を作る(その日のマスタがもうある区所は、名前だけ直す)
-- p_old_starts_on があれば: その日に切り替わるマスタがある区所の、切替日と名前を直す(無い区所は飛ばす)
-- 戻り値: 作った・直した区所の数
create or replace function public.save_master_period_all(p_old_starts_on date, p_starts_on date, p_name text)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  o record;
  pid bigint;
  n int := 0;
begin
  if not public.is_admin() then
    raise exception '管理者だけが実行できます' using errcode = '42501';
  end if;
  for o in select id, name from public.offices order by sort_order, id loop
    select id into pid from public.master_periods
     where office_id = o.id and starts_on = coalesce(p_old_starts_on, p_starts_on);
    if pid is null and p_old_starts_on is not null then
      continue;
    end if;
    begin
      perform public.save_master_period(o.id, pid, p_starts_on, p_name);
    exception when others then
      raise exception '%: %', o.name, sqlerrm;
    end;
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- 全部の区所の、p_starts_on に切り替わるマスタを消す(まだ始まっていないものだけ。そのマスタの行も消える)。消した区所の数を返す
create or replace function public.delete_master_period_all(p_starts_on date)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  p record;
  n int := 0;
begin
  if not public.is_admin() then
    raise exception '管理者だけが実行できます' using errcode = '42501';
  end if;
  for p in select mp.id, o.name from public.master_periods mp join public.offices o on o.id = mp.office_id
            where mp.starts_on = p_starts_on order by o.sort_order, o.id loop
    begin
      perform public.delete_master_period(p.id);
    exception when others then
      raise exception '%: %', p.name, sqlerrm;
    end;
    n := n + 1;
  end loop;
  return n;
end;
$$;

revoke execute on function public.save_master_period_all(date, date, text) from public, anon;
revoke execute on function public.delete_master_period_all(date) from public, anon;
grant execute on function public.save_master_period_all(date, date, text) to authenticated;
grant execute on function public.delete_master_period_all(date) to authenticated;
