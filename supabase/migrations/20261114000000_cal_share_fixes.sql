-- カレンダーの共有: 36回目のデバッグ(AR1・AR3・AR7・AR8・AR10・AR11)の直し。docs/DEBUG-LOG.md の 36回目。
-- 表の中身は変えない(権限と関数だけ)。

-- ============================================================
-- AR1: お誘いの表は、直接読めないようにする。
--   送った本人が表を直接読むと、to_id(相手がいるか)・status(断られたか)が見えて、社員番号が登録されているかを探れた。
--   読むのは cal_share_list()(名前や状態を、見せてよい形にして返す)だけにする
-- ============================================================
drop policy if exists cal_share_invites_mine on public.cal_share_invites;
revoke select on public.cal_share_invites from authenticated;

-- ============================================================
-- AR11: お誘いを送ったあとに、その社員番号の人が登録したときも届くように。
--   自分の社員番号あての返事待ち(相手が決まっていないもの)を、自分あてにする
-- ============================================================
create or replace function public.cal_share_adopt()
returns void
language plpgsql
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  my_no text;
begin
  select employee_no into my_no from public.profiles where user_id = me and role = 'user';
  if my_no is null then return; end if;
  update public.cal_share_invites set to_id = me
   where to_id is null and to_employee_no = my_no and from_id <> me and status = 'pending' and expires_at > now();
end;
$$;

create or replace function public.cal_share_inbox_count()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::int from public.cal_share_invites i
   where i.status = 'pending' and i.expires_at > now() and public.is_member() and i.from_id <> auth.uid()
     and (i.to_id = auth.uid()
          or (i.to_id is null and i.to_employee_no = (select employee_no from public.profiles where user_id = auth.uid() and role = 'user')))
$$;

create or replace function public.cal_share_list()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
begin
  if me is null or not public.is_member() then raise exception 'ログインし直してください。' using errcode = '42501'; end if;
  -- 古いお誘い(30日より前)は片付ける
  delete from public.cal_share_invites where (from_id = me or to_id = me) and created_at < now() - interval '30 days';
  perform public.cal_share_adopt();
  return jsonb_build_object(
    'links', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'kind', l.kind, 'partner_id', p.user_id,
               'partner_name', btrim(p.family_name || ' ' || p.given_name),
               'inviter', l.inviter_id = me,
               'my_scope', case when l.user_a = me then l.scope_a else l.scope_b end,
               'their_scope', case when l.user_a = me then l.scope_b else l.scope_a end,
               'created_at', l.created_at) order by l.created_at)
        from public.cal_share_links l
        join public.profiles p on p.user_id = case when l.user_a = me then l.user_b else l.user_a end
       where l.user_a = me or l.user_b = me), '[]'::jsonb),
    'views', coalesce((
      select jsonb_agg(jsonb_build_object('owner_id', v.owner_id, 'name', v.name, 'color', v.color,
                                          'off_name', v.off_name, 'off_color', v.off_color, 'sort', v.sort) order by v.sort)
        from public.cal_share_views v where v.viewer_id = me), '[]'::jsonb),
    'sent', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', i.id, 'employee_no', i.to_employee_no, 'kind', i.kind, 'scope', i.from_scope,
               -- 断られたのか、期限が切れたのかは区別しない
               'state', case when i.status = 'pending' and i.expires_at > now() then 'pending' else 'closed' end,
               'expires_at', i.expires_at) order by i.created_at desc)
        from public.cal_share_invites i where i.from_id = me and i.status <> 'accepted'), '[]'::jsonb),
    'received', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', i.id, 'kind', i.kind, 'from_scope', i.from_scope, 'expires_at', i.expires_at, 'created_at', i.created_at,
               'from_name', btrim(p.family_name || ' ' || p.given_name)) order by i.created_at desc)
        from public.cal_share_invites i join public.profiles p on p.user_id = i.from_id
       where i.to_id = me and i.status = 'pending' and i.expires_at > now()), '[]'::jsonb));
end;
$$;

create or replace function public.cal_share_decline(p_invite uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_member() then raise exception 'ログインし直してください。' using errcode = '42501'; end if;
  perform public.cal_share_adopt();
  update public.cal_share_invites set status = 'declined', responded_at = now()
   where id = p_invite and to_id = auth.uid() and status = 'pending';
end;
$$;

-- ============================================================
-- AR8: お互いにお誘いを送り合っていたとき、受ける側の人数に、相手あての自分のお誘いを数えない(受けると1人になるため)
-- ============================================================
create or replace function public.cal_share_accept(p_invite uuid, p_scope text, p_import boolean default false)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  inv public.cal_share_invites;
  lk public.cal_share_links;
  mutual int;
begin
  if me is null or not public.is_member() then raise exception 'ログインし直してください。' using errcode = '42501'; end if;
  if p_scope not in ('none', 'duty', 'duty_off') then raise exception '見せる範囲が正しくありません。' using errcode = '22023'; end if;
  perform public.cal_share_adopt();
  select * into inv from public.cal_share_invites where id = p_invite and to_id = me for update;
  if inv.id is null or inv.status <> 'pending' or inv.expires_at <= now() then
    raise exception 'このお誘いは、もう使えません(取り消されたか、期限が切れました)。' using errcode = 'P0002';
  end if;
  perform public.cal_share_lock(me, inv.from_id);
  select * into lk from public.cal_share_links
   where (user_a = me and user_b = inv.from_id) or (user_a = inv.from_id and user_b = me);
  if inv.kind = 'couple' then
    if exists (select 1 from public.cal_share_links where kind = 'couple' and (user_a = me or user_b = me)) then
      raise exception '夫婦の共有は1組までです。今の夫婦の共有をやめてから、もう一度押してください。' using errcode = '23514';
    end if;
    if exists (select 1 from public.cal_share_links where kind = 'couple' and (user_a = inv.from_id or user_b = inv.from_id)) then
      raise exception '相手は、ほかの人と夫婦の共有をしているため、共有できません。' using errcode = '23514';
    end if;
  end if;
  if lk.id is null then
    select count(*) into mutual from public.cal_share_invites
     where from_id = me and to_id = inv.from_id and status = 'pending' and expires_at > now();
    if public.cal_share_count(me) - mutual >= 5 then
      raise exception '共有できるのは5人までです。ほかの人との共有をやめるか、送ったお誘いを取り消してから、もう一度押してください。' using errcode = '23514';
    end if;
    if public.cal_share_count(inv.from_id, inv.id) >= 5 then
      raise exception '相手の共有が5人に達しているため、共有できません。' using errcode = '23514';
    end if;
    insert into public.cal_share_links (user_a, user_b, kind, inviter_id, scope_a, scope_b)
    values (least(me, inv.from_id), greatest(me, inv.from_id), inv.kind, inv.from_id,
            case when inv.from_id < me then inv.from_scope else p_scope end,
            case when inv.from_id < me then p_scope else inv.from_scope end);
    if inv.kind = 'mate' then
      perform public.cal_share_add_view(me, inv.from_id);
      perform public.cal_share_add_view(inv.from_id, me);
    end if;
  elsif inv.kind = 'couple' and lk.kind = 'mate' then
    -- 仲間から夫婦へ(招待した側のカレンダーを使う)
    update public.cal_share_links
       set kind = 'couple', inviter_id = inv.from_id,
           scope_a = case when user_a = inv.from_id then inv.from_scope else p_scope end,
           scope_b = case when user_b = inv.from_id then inv.from_scope else p_scope end
     where id = lk.id;
  end if;
  if inv.kind = 'couple' and (lk.id is null or lk.kind = 'mate') then
    perform public.cal_couple_start(inv.from_id, me, coalesce(p_import, false));
  end if;
  update public.cal_share_invites set status = 'accepted', responded_at = now()
   where status = 'pending' and ((from_id = inv.from_id and to_id = me) or (from_id = me and to_id = inv.from_id) or id = inv.id);
end;
$$;

-- ============================================================
-- AR3: 「自分だけ」にできるのは、相手が作った予定・テンプレートが入っていないラベルだけ。
--   入っていると、作った本人から見えなくなり、やめたあとも本人のカレンダーで見えないままになっていた
-- ============================================================
create or replace function public.cal_labels_private_check()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.private_to is not null and old.private_to is distinct from new.private_to
     and (exists (select 1 from public.cal_events where label_id = new.id and created_by <> new.private_to)
          or exists (select 1 from public.cal_templates where label_id = new.id and created_by <> new.private_to)) then
    raise exception 'このラベルには、相手が作った予定かテンプレートがあるので、「自分だけ」にできません。先に、その予定のラベルを変えてください。' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger cal_labels_private_check before update on public.cal_labels
  for each row execute function public.cal_labels_private_check();

-- 持って帰る・取り込む: ほかの人の「自分だけ」のラベルは、行き先に「自分だけ」のまま作らない(念のため。上の確かめの前に付けたもの)。
-- 使っているラベルを先に、行き先のラベルの枠(10個)に入れる
create or replace function public.cal_couple_move(from_owner uuid, to_owner uuid, who uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  r record;
  m jsonb := '{}'::jsonb;
  tgt uuid;
begin
  if from_owner = to_owner then return; end if;
  for r in select l.id, l.name, l.color, l.kind, l.private_to, l.created_by,
                  (l.id in (select label_id from public.cal_events where user_id = from_owner and created_by = who
                            union select label_id from public.cal_templates where user_id = from_owner and created_by = who and label_id is not null)) as used
             from public.cal_labels l
            where l.user_id = from_owner
            order by l.sort, l.created_at loop
    -- who が使っているラベルと、who が作ったラベル(使っていなくても持っていく)だけ
    continue when not r.used and not (r.kind = 'custom' and r.created_by = who);
    tgt := null;
    if r.kind = 'custom' and (r.private_to is null or r.private_to = who) then
      select id into tgt from public.cal_labels
       where user_id = to_owner and kind = 'custom' and name = r.name and private_to is not distinct from r.private_to limit 1;
      if tgt is null and (select count(*) from public.cal_labels where user_id = to_owner and kind = 'custom') < (case when r.used then 10 else 9 end) then
        insert into public.cal_labels (user_id, created_by, kind, name, color, sort, private_to)
        values (to_owner, who, 'custom', r.name, r.color, 90, r.private_to) returning id into tgt;
      end if;
    end if;
    if tgt is null and r.used then tgt := public.cal_couple_fallback(to_owner, who); end if;
    if tgt is not null then m := m || jsonb_build_object(r.id::text, tgt); end if;
  end loop;

  update public.cal_events set user_id = to_owner, label_id = (m ->> label_id::text)::uuid
   where user_id = from_owner and created_by = who;
  update public.cal_templates set user_id = to_owner, label_id = case when label_id is null then null else (m ->> label_id::text)::uuid end
   where user_id = from_owner and created_by = who;
  update public.cal_todos set user_id = to_owner where user_id = from_owner and created_by = who;
  update public.cal_importants set user_id = to_owner where user_id = from_owner and created_by = who;
  update public.cal_gallery set user_id = to_owner where user_id = from_owner and created_by = who;
  update public.cal_stamp_defs set user_id = to_owner where user_id = from_owner and created_by = who;

  delete from public.cal_labels l
   where l.user_id = from_owner and l.created_by = who and l.kind = 'custom'
     and not exists (select 1 from public.cal_events e where e.label_id = l.id)
     and not exists (select 1 from public.cal_templates t where t.label_id = l.id);
end;
$$;

-- ============================================================
-- AR7: 夫婦をやめるとき、相手の予定に足した写真(ファイルは足した人のフォルダ)は、行ごと消す。
--   やめたあとは相手のフォルダを読めず、枠だけ残っていた。消した写真の場所を返す(退会のとき、サーバーがファイルを消す)
-- ============================================================
drop function public.cal_couple_end_for(uuid);
drop function public.cal_couple_end(uuid, uuid);
create function public.cal_couple_end(owner uuid, member uuid)
returns text[]
language plpgsql
set search_path = ''
as $$
declare
  fb uuid;
  gone text[];
begin
  perform public.cal_couple_move(owner, member, member);
  -- 相手の予定に足した写真(持ち主のカレンダーに残った相手の写真・相手のカレンダーへ移った持ち主の写真)
  with d as (
    delete from public.cal_photos
     where (user_id = owner and created_by = member) or (user_id = member and created_by = owner)
    returning path)
  select coalesce(array_agg(path), '{}') into gone from d;
  -- 相手の名前のラベルを、持ち主の予定・テンプレートが使っていたら、ほかのラベルにつけ直してから消す
  if exists (select 1 from public.cal_events e join public.cal_labels l on l.id = e.label_id where l.user_id = owner and l.member_id = member)
     or exists (select 1 from public.cal_templates t join public.cal_labels l on l.id = t.label_id where l.user_id = owner and l.member_id = member) then
    fb := public.cal_couple_fallback(owner, owner);
    update public.cal_events set label_id = fb where user_id = owner and label_id in (select id from public.cal_labels where user_id = owner and member_id = member);
    update public.cal_templates set label_id = fb where user_id = owner and label_id in (select id from public.cal_labels where user_id = owner and member_id = member);
  end if;
  delete from public.cal_labels where user_id = owner and member_id = member;
  update public.cal_labels set name = public.cal_shift_label_name(owner, kind, false)
   where user_id = owner and member_id is null and kind <> 'custom';
  return gone;
end;
$$;

-- 退会(管理画面での削除)の前に呼ぶ(サーバーだけ)。消した写真の場所を返す
create function public.cal_couple_end_for(p_user uuid)
returns text[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  l public.cal_share_links;
  gone text[];
begin
  select * into l from public.cal_share_links where kind = 'couple' and (user_a = p_user or user_b = p_user);
  if l.id is null then return '{}'; end if;
  gone := public.cal_couple_end(l.inviter_id, case when l.user_a = l.inviter_id then l.user_b else l.user_a end);
  delete from public.cal_share_links where id = l.id;
  return gone;
end;
$$;

-- ============================================================
-- AR10: 管理画面の「使用量の多い人」は、作った人(ファイルのフォルダの持ち主)ごとに数える。
--   夫婦だと、カレンダーの持ち主に2人分が付いていた
-- ============================================================
create or replace function public.admin_usage()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  storage_bytes bigint := 0;
  storage_files bigint := 0;
  top jsonb;
begin
  if not public.is_admin() then
    raise exception '管理者だけが実行できます' using errcode = '42501';
  end if;
  -- Storage の使用量(calendar バケット)。Storage が無い環境(テスト用の素の PostgreSQL)では 0
  if to_regclass('storage.objects') is not null then
    execute $q$select coalesce(sum(coalesce((metadata ->> 'size')::bigint, 0)), 0), count(*)
                 from storage.objects where bucket_id = 'calendar'$q$
      into storage_bytes, storage_files;
  end if;
  select coalesce(jsonb_agg(t order by t.bytes desc), '[]'::jsonb) into top from (
    select p.employee_no, btrim(p.family_name || ' ' || p.given_name) as name, u.bytes
      from (
        select user_id, sum(bytes) as bytes from (
          select created_by as user_id, size_bytes as bytes from public.cal_photos
          union all
          select created_by as user_id, size_bytes as bytes from public.cal_gallery
        ) a group by user_id
      ) u
      join public.profiles p on p.user_id = u.user_id
     order by u.bytes desc
     limit 5
  ) t;
  return jsonb_build_object(
    'db_bytes', pg_database_size(current_database()),
    'db_limit_bytes', 524288000,
    'storage_bytes', storage_bytes,
    'storage_files', storage_files,
    'storage_limit_bytes', 1073741824,
    'photos', (select count(*) from public.cal_photos),
    'photo_bytes', (select coalesce(sum(size_bytes), 0) from public.cal_photos),
    'gallery', (select count(*) from public.cal_gallery),
    'gallery_bytes', (select coalesce(sum(size_bytes), 0) from public.cal_gallery),
    'top_users', top
  );
end;
$$;

-- ============================================================
-- 関数の権限
-- ============================================================
revoke execute on function public.cal_share_adopt() from public, anon, authenticated;
revoke execute on function public.cal_labels_private_check() from public, anon, authenticated;
revoke execute on function public.cal_couple_end(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.cal_couple_end_for(uuid) from public, anon, authenticated;
grant execute on function public.cal_couple_end_for(uuid) to service_role;
revoke execute on function public.admin_usage() from public, anon;
grant execute on function public.admin_usage() to authenticated;
