-- カレンダーの共有(第2段階: 夫婦)。設計は docs/share/DESIGN.md の 2・5・6章。
-- 夫婦は、招待した側(持ち主)のカレンダーを2人で使う。予定などの表(cal_*)の user_id は「カレンダーの持ち主」として扱い、
-- RLS を user_id = auth.uid() から user_id = cal_owner() に変える。
-- 夫婦でない人は cal_owner() = 自分なので、今までと同じ動き(テストで確かめる)。

-- ============================================================
-- 1. 誰のカレンダーか
-- ============================================================
-- いま使っているカレンダーの持ち主(夫婦なら招待した側。それ以外は自分)
create or replace function public.cal_owner()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select l.inviter_id from public.cal_share_links l
      where l.kind = 'couple' and (l.user_a = auth.uid() or l.user_b = auth.uid()) limit 1),
    auth.uid())
$$;

-- 夫婦の相手(いなければ null)
create or replace function public.cal_partner()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select case when l.user_a = auth.uid() then l.user_b else l.user_a end
    from public.cal_share_links l
   where l.kind = 'couple' and (l.user_a = auth.uid() or l.user_b = auth.uid()) limit 1
$$;

-- ============================================================
-- 2. 作った人(created_by)・名前のラベル(member_id)・自分だけ(private_to)
-- ============================================================
do $$
declare
  t text;
begin
  foreach t in array array['cal_labels', 'cal_events', 'cal_photos', 'cal_stamp_defs', 'cal_stamps', 'cal_todos', 'cal_importants', 'cal_gallery', 'cal_templates'] loop
    execute format('alter table public.%I add column created_by uuid', t);
    execute format('update public.%I set created_by = user_id', t);
    execute format('alter table public.%I alter column created_by set default auth.uid()', t);
    execute format('alter table public.%I alter column created_by set not null', t);
    -- 新しい行は、いま使っているカレンダー(夫婦なら持ち主)に入る
    execute format('alter table public.%I alter column user_id set default public.cal_owner()', t);
  end loop;
end
$$;

-- 作った人は、画面からは決められない(自分になる)・あとから変えられない。
-- 関数(security definer)の中から入れるとき(持って帰るときのラベルなど)は、関数が決めた人のまま
create or replace function public.cal_created_by()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    new.created_by := old.created_by;
  elsif current_user = 'authenticated' or new.created_by is null then
    new.created_by := coalesce(auth.uid(), new.created_by, new.user_id);
  end if;
  return new;
end;
$$;
do $$
declare
  t text;
begin
  foreach t in array array['cal_labels', 'cal_events', 'cal_photos', 'cal_stamp_defs', 'cal_stamps', 'cal_todos', 'cal_importants', 'cal_gallery', 'cal_templates'] loop
    execute format('create trigger %I before insert or update on public.%I for each row execute function public.cal_created_by()', t || '_created_by', t);
  end loop;
end
$$;

-- 名前のラベル: 夫婦のカレンダーで、相手(招待された側)の勤務・休日・非番のラベル。持ち主のものは null
alter table public.cal_labels add column member_id uuid references auth.users (id) on delete cascade;
-- 自分だけのラベル: 作った人にしか見えない(そのラベルの予定・テンプレートも)。自分のラベルにしか付けられない
alter table public.cal_labels add column private_to uuid;
alter table public.cal_labels add constraint cal_labels_private_by_creator check (private_to is null or private_to = created_by);
alter table public.cal_labels add constraint cal_labels_member_shift check (member_id is null or kind <> 'custom');
drop index public.cal_labels_kind_once;
create unique index cal_labels_kind_once on public.cal_labels (user_id, kind, coalesce(member_id, user_id)) where kind <> 'custom';

-- 写真・画像のファイルは、作った人のフォルダ(<作った人のID>/…)。持ち主を付け替えても、ファイルは動かさない
do $$
declare
  c record;
begin
  for c in select con.conname, rel.relname from pg_constraint con join pg_class rel on rel.oid = con.conrelid
            where rel.relnamespace = 'public'::regnamespace and rel.relname in ('cal_photos', 'cal_gallery', 'cal_stamp_defs')
              and con.contype = 'c' and pg_get_constraintdef(con.oid) like '%user_id)::text%' loop
    execute format('alter table public.%I drop constraint %I', c.relname, c.conname);
  end loop;
end
$$;
alter table public.cal_photos add constraint cal_photos_path_creator check (path like created_by::text || '/%');
alter table public.cal_gallery add constraint cal_gallery_path_creator check (path like created_by::text || '/%');
alter table public.cal_stamp_defs add constraint cal_stamp_defs_image_creator check (image_path = '' or image_path like created_by::text || '/%');

-- 持ち主の付け替え(夫婦の取り込み・持って帰る)で、予定の写真・スタンプの種類のスタンプがついていくように
alter table public.cal_photos drop constraint cal_photos_event_id_user_id_fkey;
alter table public.cal_photos add constraint cal_photos_event_id_user_id_fkey
  foreign key (event_id, user_id) references public.cal_events (id, user_id) on delete cascade on update cascade;
alter table public.cal_stamps drop constraint cal_stamps_stamp_def_id_user_id_fkey;
alter table public.cal_stamps add constraint cal_stamps_stamp_def_id_user_id_fkey
  foreign key (stamp_def_id, user_id) references public.cal_stamp_defs (id, user_id) on delete cascade on update cascade;

-- ============================================================
-- 3. RLS: 持ち主のカレンダーの行。自分だけのラベル(相手のもの)と、その予定・写真・テンプレートは見えない
-- ============================================================
-- ラベルが、ほかの人の「自分だけ」か(RLS を通さずに調べる)
create or replace function public.cal_label_hidden(p_label uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.cal_labels where id = p_label and private_to is not null and private_to <> auth.uid())
$$;
create or replace function public.cal_event_hidden(p_event uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.cal_events e join public.cal_labels l on l.id = e.label_id
                  where e.id = p_event and l.private_to is not null and l.private_to <> auth.uid())
$$;

do $$
declare
  t text;
  extra text;
  base text := 'user_id = (select public.cal_owner()) and (select public.is_member())';
begin
  foreach t in array array['cal_labels', 'cal_events', 'cal_photos', 'cal_stamp_defs', 'cal_stamps', 'cal_todos', 'cal_importants', 'cal_gallery', 'cal_templates'] loop
    execute format('drop policy if exists %I on public.%I', t || '_own', t);
    extra := case t
      when 'cal_labels' then ' and (private_to is null or private_to = (select auth.uid()))'
      when 'cal_events' then ' and not public.cal_label_hidden(label_id)'
      when 'cal_templates' then ' and (label_id is null or not public.cal_label_hidden(label_id))'
      when 'cal_photos' then ' and not public.cal_event_hidden(event_id)'
      else '' end;
    execute format('create policy %I on public.%I for all to authenticated using (%s%s) with check (%s%s)', t || '_own', t, base, extra, base, extra);
  end loop;
end
$$;

-- ============================================================
-- 4. 画像の置き場: 1人10枚、夫婦のカレンダーは20枚
-- ============================================================
create or replace function public.cal_gallery_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  lim int := case when exists (select 1 from public.cal_share_links where kind = 'couple' and inviter_id = new.user_id) then 20 else 10 end;
begin
  if (select count(*) from public.cal_gallery where user_id = new.user_id) >= lim then
    raise exception '画像 は % 件までです。', lim using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger cal_gallery_limit on public.cal_gallery;
create trigger cal_gallery_limit before insert on public.cal_gallery
  for each row execute function public.cal_gallery_limit();

-- ============================================================
-- 5. 最初のラベル: いま使っているカレンダーに、自分の勤務・休日・非番のラベルを作る(夫婦なら名前のラベル)
-- ============================================================
create or replace function public.cal_given(u uuid)
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(nullif(left(btrim(given_name), 8), ''), '共有') from public.profiles where user_id = u
$$;

create or replace function public.cal_shift_label_name(u uuid, kind text, couple boolean)
returns text
language sql
stable
set search_path = ''
as $$
  select case when not couple then case kind when 'duty' then '勤務' when 'off' then '休日' else '非番' end
              else public.cal_given(u) || case kind when 'duty' then '' when 'off' then '・休' else '・非' end end
$$;

create or replace function public.cal_ensure_default_labels()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  own uuid;
  mem uuid;
  couple boolean;
  k text;
  c text;
  s int;
begin
  if me is null or not public.is_member() then return; end if;
  own := public.cal_owner();
  couple := public.cal_partner() is not null;
  mem := case when own = me then null else me end;
  foreach k in array array['duty', 'off', 'offduty'] loop
    if not exists (select 1 from public.cal_labels where user_id = own and kind = k and member_id is not distinct from mem) then
      c := case k when 'duty' then '#3b6fd4' when 'off' then '#e0553f' else '#d4607a' end;
      s := case k when 'duty' then 1 when 'off' then 2 else 2 end + case when mem is null then 0 else 50 end;
      insert into public.cal_labels (user_id, created_by, kind, member_id, name, color, sort)
      values (own, me, k, mem, public.cal_shift_label_name(me, k, couple), c, s) on conflict do nothing;
    end if;
  end loop;
  if not exists (select 1 from public.cal_labels where user_id = own and kind = 'custom') then
    insert into public.cal_labels (user_id, created_by, kind, name, color, sort) values (own, me, 'custom', 'その他', '#6b7280', 3);
  end if;
end;
$$;

-- ============================================================
-- 6. 夫婦を始める・やめる(取り込み・持って帰る)
-- ============================================================
-- 予定の行き先のカレンダーで使う「取り込み」のラベル(無ければ作る。10個あれば、いちばん上のラベル)
create or replace function public.cal_couple_fallback(to_owner uuid, who uuid)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  lid uuid;
begin
  select id into lid from public.cal_labels where user_id = to_owner and kind = 'custom' and name = '取り込み' and private_to is null limit 1;
  if lid is null and (select count(*) from public.cal_labels where user_id = to_owner and kind = 'custom') < 10 then
    insert into public.cal_labels (user_id, created_by, kind, name, color, sort) values (to_owner, who, 'custom', '取り込み', '#6b7280', 99)
    returning id into lid;
  end if;
  if lid is null then
    select id into lid from public.cal_labels where user_id = to_owner and kind = 'custom' and private_to is null order by sort, created_at limit 1;
  end if;
  return lid;
end;
$$;

-- who が作ったもの(予定・テンプレート・TODO・重要メモ・画像・スタンプの種類)を、from_owner のカレンダーから to_owner のカレンダーへ移す。
-- 予定の写真・スタンプは、外部キー(on update cascade)で一緒に移る。ラベルは、行き先の同じ名前のラベルにつけ直す(無ければ作る。10個を超えるときは「取り込み」)。
-- who が作ったラベルは、予定に使っていなくても行き先に作る。移したあと、who が作って、もう使われていないラベルは元のカレンダーから消す
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
  for r in select l.id, l.name, l.color, l.kind, l.private_to from public.cal_labels l
            where l.user_id = from_owner and (l.id in (
              select label_id from public.cal_events where user_id = from_owner and created_by = who
              union select label_id from public.cal_templates where user_id = from_owner and created_by = who and label_id is not null)
              -- who が作ったラベルは、予定に使っていなくても持っていく
              or (l.created_by = who and l.kind = 'custom'))
            order by l.sort, l.created_at loop
    tgt := null;
    if r.kind = 'custom' then
      select id into tgt from public.cal_labels
       where user_id = to_owner and kind = 'custom' and name = r.name and private_to is not distinct from r.private_to limit 1;
      if tgt is null and (select count(*) from public.cal_labels where user_id = to_owner and kind = 'custom') < 10 then
        insert into public.cal_labels (user_id, created_by, kind, name, color, sort, private_to)
        values (to_owner, coalesce(r.private_to, who), 'custom', r.name, r.color, 90, r.private_to) returning id into tgt;
      end if;
    end if;
    if tgt is null then tgt := public.cal_couple_fallback(to_owner, who); end if;
    m := m || jsonb_build_object(r.id::text, tgt);
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

-- 夫婦を始める: 持ち主の勤務のラベルを名前のラベルにし、相手の名前のラベルを作る(色は相手の今の色)。取り込むなら、相手のものを移す
create or replace function public.cal_couple_start(owner uuid, member uuid, do_import boolean)
returns void
language plpgsql
set search_path = ''
as $$
declare
  k text;
  c text;
begin
  update public.cal_labels set name = public.cal_shift_label_name(owner, kind, true)
   where user_id = owner and member_id is null and kind <> 'custom';
  foreach k in array array['duty', 'off', 'offduty'] loop
    select color into c from public.cal_labels where user_id = member and member_id is null and kind = k;
    insert into public.cal_labels (user_id, created_by, kind, member_id, name, color, sort)
    values (owner, member, k, member, public.cal_shift_label_name(member, k, true),
            coalesce(c, case k when 'duty' then '#16a085' when 'off' then '#f39c12' else '#d4607a' end),
            case k when 'duty' then 51 else 52 end)
    on conflict do nothing;
  end loop;
  if do_import then perform public.cal_couple_move(member, owner, member); end if;
  -- 仲間の名前のラベルは使わない(夫婦は、カレンダーのラベル)
  delete from public.cal_share_views where (viewer_id = owner and owner_id = member) or (viewer_id = member and owner_id = owner);
end;
$$;

-- 夫婦をやめる: 招待された側が作ったものを、招待された側のカレンダーへ持って帰る。名前のラベルを元に戻す
create or replace function public.cal_couple_end(owner uuid, member uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  fb uuid;
begin
  perform public.cal_couple_move(owner, member, member);
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
end;
$$;

-- 退会(管理画面での削除)の前に呼ぶ(サーバーだけ): 夫婦なら、やめるときと同じに持って帰ってから共有を消す
create or replace function public.cal_couple_end_for(p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  l public.cal_share_links;
begin
  select * into l from public.cal_share_links where kind = 'couple' and (user_a = p_user or user_b = p_user);
  if l.id is null then return; end if;
  perform public.cal_couple_end(l.inviter_id, case when l.user_a = l.inviter_id then l.user_b else l.user_a end);
  delete from public.cal_share_links where id = l.id;
end;
$$;

-- ============================================================
-- 7. 共有の関数を、夫婦に対応させる
-- ============================================================
create or replace function public.cal_share_send(p_employee_no text, p_kind text, p_scope text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  my_no text;
  target uuid;
  lk public.cal_share_links;
  no text := btrim(coalesce(p_employee_no, ''));
begin
  select employee_no into my_no from public.profiles where user_id = me;
  if me is null or my_no is null then raise exception 'ログインし直してください。' using errcode = '42501'; end if;
  if no !~ '^\d{7}$' then raise exception '社員番号は7桁の数字で入れてください。' using errcode = '22023'; end if;
  if p_kind not in ('mate', 'couple') then raise exception '共有の種類が正しくありません。' using errcode = '22023'; end if;
  if p_scope not in ('none', 'duty', 'duty_off') then raise exception '見せる範囲が正しくありません。' using errcode = '22023'; end if;
  if no = my_no then raise exception '自分の社員番号には送れません。' using errcode = '22023'; end if;

  perform public.cal_share_lock(me, null);
  if (select count(*) from public.cal_share_sends where user_id = me and at > now() - interval '1 day') >= 10 then
    raise exception 'お誘いは1日10回までです。明日、もう一度送ってください。' using errcode = '54000';
  end if;
  insert into public.cal_share_sends (user_id) values (me);
  delete from public.cal_share_sends where user_id = me and at < now() - interval '2 days';

  if exists (select 1 from public.cal_share_invites
              where from_id = me and to_employee_no = no and status = 'pending' and expires_at > now()) then
    raise exception 'この社員番号には、もう送っています(返事待ち)。' using errcode = '23505';
  end if;
  if p_kind = 'couple' then
    if public.cal_partner() is not null then
      raise exception '夫婦の共有は1組までです。今の夫婦の共有をやめてから送ってください。' using errcode = '23514';
    end if;
    if exists (select 1 from public.cal_share_invites
                where from_id = me and kind = 'couple' and status = 'pending' and expires_at > now()) then
      raise exception '夫婦のお誘いは、返事待ちが1つまでです。' using errcode = '23514';
    end if;
  end if;
  select user_id into target from public.profiles where employee_no = no and role = 'user';
  if target is not null then
    select * into lk from public.cal_share_links where (user_a = me and user_b = target) or (user_a = target and user_b = me);
    -- 仲間の人を、夫婦に誘い直すのはよい(受けると夫婦になる)
    if lk.id is not null and not (lk.kind = 'mate' and p_kind = 'couple') then
      raise exception 'この人とは、もう共有しています。' using errcode = '23505';
    end if;
  end if;
  if public.cal_share_count(me) >= 5 and lk.id is null then
    raise exception '共有できるのは5人までです(返事待ちも数えます)。' using errcode = '23514';
  end if;
  insert into public.cal_share_invites (from_id, to_id, to_employee_no, kind, from_scope)
  values (me, target, no, p_kind, p_scope);
end;
$$;

drop function public.cal_share_accept(uuid, text);
-- 共有する。p_scope は自分が相手に見せる範囲。p_import は夫婦のとき、自分の予定などを相手のカレンダーへ取り込むか
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
begin
  if me is null or not public.is_member() then raise exception 'ログインし直してください。' using errcode = '42501'; end if;
  if p_scope not in ('none', 'duty', 'duty_off') then raise exception '見せる範囲が正しくありません。' using errcode = '22023'; end if;
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
    if public.cal_share_count(me) >= 5 then
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

-- 共有をやめる。夫婦なら、招待された側が作ったものを持って帰ってから
create or replace function public.cal_share_stop(p_link uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  l public.cal_share_links;
begin
  if me is null or not public.is_member() then raise exception 'ログインし直してください。' using errcode = '42501'; end if;
  select * into l from public.cal_share_links where id = p_link and (user_a = me or user_b = me) for update;
  if l.id is null then return; end if;
  perform public.cal_share_lock(l.user_a, l.user_b);
  if l.kind = 'couple' then
    perform public.cal_couple_end(l.inviter_id, case when l.user_a = l.inviter_id then l.user_b else l.user_a end);
  end if;
  delete from public.cal_share_links where id = l.id;
end;
$$;

-- ============================================================
-- 8. 写真・画像の置き場(Storage): 夫婦の相手のフォルダも、読める・消せる(入れるのは自分のフォルダだけ)
-- ============================================================
do $$
begin
  if to_regclass('storage.objects') is null then
    return;
  end if;
  drop policy if exists calendar_select_own on storage.objects;
  drop policy if exists calendar_delete_own on storage.objects;
  create policy calendar_select_own on storage.objects for select to authenticated
    using (bucket_id = 'calendar' and public.is_member()
           and ((storage.foldername(name))[1] = auth.uid()::text or (storage.foldername(name))[1] = public.cal_partner()::text));
  create policy calendar_delete_own on storage.objects for delete to authenticated
    using (bucket_id = 'calendar' and public.is_member()
           and ((storage.foldername(name))[1] = auth.uid()::text or (storage.foldername(name))[1] = public.cal_partner()::text));
exception when others then
  -- 本番の Storage の持ち主の権限で作れないときも、migration 全体は止めない。
  -- その場合は docs/share/DESIGN.md の「Storage の権限を手で作る SQL」を SQL エディタで実行する
  raise notice 'calendar の Storage の権限を作れませんでした(%)', sqlerrm;
end
$$;

-- ============================================================
-- 9. 関数の権限
-- ============================================================
revoke execute on function public.cal_created_by() from public, anon, authenticated;
revoke execute on function public.cal_gallery_limit() from public, anon, authenticated;
revoke execute on function public.cal_given(uuid) from public, anon, authenticated;
revoke execute on function public.cal_shift_label_name(uuid, text, boolean) from public, anon, authenticated;
revoke execute on function public.cal_couple_fallback(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.cal_couple_move(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.cal_couple_start(uuid, uuid, boolean) from public, anon, authenticated;
revoke execute on function public.cal_couple_end(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.cal_couple_end_for(uuid) from public, anon, authenticated;
grant execute on function public.cal_couple_end_for(uuid) to service_role;
-- RLS の中で使う(利用者の権限で呼ばれる)
revoke execute on function public.cal_owner() from public, anon;
revoke execute on function public.cal_partner() from public, anon;
revoke execute on function public.cal_label_hidden(uuid) from public, anon;
revoke execute on function public.cal_event_hidden(uuid) from public, anon;
grant execute on function public.cal_owner(), public.cal_partner(), public.cal_label_hidden(uuid), public.cal_event_hidden(uuid) to authenticated;
revoke execute on function public.cal_share_accept(uuid, text, boolean) from public, anon;
grant execute on function public.cal_share_accept(uuid, text, boolean) to authenticated;
revoke execute on function public.cal_ensure_default_labels() from public, anon;
grant execute on function public.cal_ensure_default_labels() to authenticated;
