-- マスタの切替(ダイヤ改正・ダイヤ修正)の直し。20回目のデバッグ(docs/DEBUG-LOG.md の AB10〜AB13・AB16)。
-- 番号は本番の最後(20261017000000)より大きくする(AB18)。

-- AB10: 古い切替日の自動削除は、次の切替日にマスタの行があるときだけ。
-- ある区所だけ CSV を入れ忘れたまま日がたつと、中身のある前のマスタが消えて空のマスタだけが残り、
-- 番号が黙って手入力(時間なし)で登録されてしまうため
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
        and q.starts_on <= (date_trunc('month', (now() at time zone 'Asia/Tokyo')::date) - interval '1 month')::date
        and exists (select 1 from public.shift_master sm where sm.period_id = q.id)
   );
  get diagnostics n = row_count;
  return n;
end;
$$;

-- AB11: 日付を変えないとき(名前だけ直すとき)は、日付の確かめをしない(始まった切替日の名前も直せるように)
-- AB16: 古い切替日の片付けを先にする(片付けで消えたものを「保存しました」にしない)。直す行が無ければエラー
create or replace function public.save_master_period(p_office_id bigint, p_period_id bigint, p_starts_on date, p_name text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  this_month date := date_trunc('month', (now() at time zone 'Asia/Tokyo')::date)::date;
  base_id bigint;
  id_out bigint;
  current_start date;
  name_in text := coalesce(trim(p_name), '');
begin
  if not public.is_admin() then
    raise exception '管理者だけが実行できます' using errcode = '42501';
  end if;
  if not exists (select 1 from public.offices where id = p_office_id) then
    raise exception '区所が見つかりません';
  end if;
  if p_starts_on is null then
    raise exception '切替日を入れてください';
  end if;
  if char_length(name_in) > 20 then
    raise exception '名前は20文字までにしてください';
  end if;

  perform public.purge_old_master_periods();
  if p_period_id is not null then
    select starts_on into current_start from public.master_periods where id = p_period_id and office_id = p_office_id;
    if not found then
      raise exception 'マスタが見つかりません(ほかの画面で消されたかもしれません)。画面を読み直してください';
    end if;
  end if;
  select id into base_id from public.master_periods where office_id = p_office_id order by starts_on limit 1;

  if p_period_id is not null and p_starts_on = current_start then
    null; -- 名前だけ直す
  elsif p_period_id is not null and p_period_id = base_id then
    if exists (select 1 from public.master_periods where office_id = p_office_id and id <> base_id and starts_on <= p_starts_on) then
      raise exception 'いちばん古いマスタの切替日は、ほかのマスタの切替日より前にしてください';
    end if;
  else
    if p_starts_on < this_month then
      raise exception '切替日は、今月の1日から後の日にしてください';
    end if;
    if p_starts_on <= (select starts_on from public.master_periods where id = base_id) then
      raise exception '切替日は、いちばん古いマスタの切替日より後にしてください';
    end if;
  end if;
  if exists (select 1 from public.master_periods
              where office_id = p_office_id and starts_on = p_starts_on and id is distinct from p_period_id) then
    raise exception 'その日に切り替わるマスタがもうあります';
  end if;

  if p_period_id is null then
    insert into public.master_periods (office_id, starts_on, name)
    values (p_office_id, p_starts_on, name_in)
    returning id into id_out;
  else
    update public.master_periods set starts_on = p_starts_on, name = name_in, updated_at = now()
     where id = p_period_id
    returning id into id_out;
  end if;
  if id_out is null then
    raise exception 'マスタが見つかりません(ほかの画面で消されたかもしれません)。画面を読み直してください';
  end if;
  return id_out;
end;
$$;

-- AB16: まとめて直す・消すで、対象の区所が1つも無ければエラー(ほかの画面で変えた・消したあとの古い画面から押したとき)
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
  if n = 0 then
    raise exception 'その切替日のマスタが見つかりません(ほかの画面で変えた・消したかもしれません)。画面を読み直してください';
  end if;
  return n;
end;
$$;

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
  if n = 0 then
    raise exception 'その切替日のマスタが見つかりません(ほかの画面で消したかもしれません)。画面を読み直してください';
  end if;
  return n;
end;
$$;

-- AB12: 登録し直しが要る人数。p_from の前日から後の勤務を、もう保存・登録している利用者を数える
-- (切替日の前日の泊は、非番の退勤時間が変わるので前日から)。p_office_id が null なら全部の区所。
-- 切替日を動かしたときは、前と後の早いほうを p_from にする。消すときも、消す前に呼ぶ
create or replace function public.master_affected_users(p_office_id bigint, p_from date)
returns int
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception '管理者だけが実行できます' using errcode = '42501';
  end if;
  return (select count(distinct r.user_id)::int
            from public.shift_records r
            join public.user_settings s on s.user_id = r.user_id
           where (p_office_id is null or s.office_id = p_office_id)
             and s.office_id is not null
             and r.date >= p_from - 1 and r.code <> '');
end;
$$;

drop function public.master_period_affected(bigint);

-- AB13: 区所を足したら、ほかの区所にある「これからの切替日」(日付と名前)も同じように作る
-- (ダイヤ改正・ダイヤ修正の日はどの区所も同じなので、新しい区所だけ古いマスタのままにならないように。CSV は区所ごと)
create or replace function public.offices_add_master_period()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  today date := (now() at time zone 'Asia/Tokyo')::date;
begin
  insert into public.master_periods (office_id, starts_on, name)
  values (new.id, today, '');
  insert into public.master_periods (office_id, starts_on, name)
  select new.id, starts_on, max(name)
    from public.master_periods
   where office_id <> new.id and starts_on > today
   group by starts_on;
  return new;
end;
$$;

revoke execute on function public.purge_old_master_periods() from public, anon, authenticated;
revoke execute on function public.offices_add_master_period() from public, anon, authenticated;
revoke execute on function public.master_affected_users(bigint, date) from public, anon;
grant execute on function public.master_affected_users(bigint, date) to authenticated;
