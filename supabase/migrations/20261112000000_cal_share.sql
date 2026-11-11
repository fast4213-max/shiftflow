-- カレンダーの共有(第1段階: 仲間)。設計は docs/share/DESIGN.md。
-- 相手の社員番号を入れてお誘いを送る → 相手の「お知らせ」に届く → 「共有する」で、お互いの勤務(と休日)を、決めた範囲だけ見せ合う。
-- 表は本人に関係する行を読むだけ。書くのは下の関数(security definer)だけ(社員番号から人を探すのも、関数の中だけ)。
-- 今の表(cal_* ・shift_records など)は変えない。

-- ============================================================
-- 1. 表
-- ============================================================
-- お誘い。to_id は、その社員番号の人がいないときは null(送った側には、いてもいなくても同じに見せる)
create table public.cal_share_invites (
  id             uuid primary key default gen_random_uuid(),
  from_id        uuid not null references auth.users (id) on delete cascade,
  to_id          uuid references auth.users (id) on delete set null,
  to_employee_no text not null check (to_employee_no ~ '^\d{7}$'),
  kind           text not null default 'mate' check (kind in ('mate', 'couple')),
  from_scope     text not null check (from_scope in ('none', 'duty', 'duty_off')),
  status         text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null default now() + interval '14 days',
  responded_at   timestamptz
);
create index cal_share_invites_from on public.cal_share_invites (from_id, created_at);
create index cal_share_invites_to on public.cal_share_invites (to_id) where status = 'pending';

-- 共有している2人(1組1行。user_a < user_b)。scope_a = a が b に見せる範囲、scope_b = b が a に見せる範囲
create table public.cal_share_links (
  id         uuid primary key default gen_random_uuid(),
  user_a     uuid not null references auth.users (id) on delete cascade,
  user_b     uuid not null references auth.users (id) on delete cascade,
  kind       text not null default 'mate' check (kind in ('mate', 'couple')),
  inviter_id uuid not null,
  scope_a    text not null check (scope_a in ('none', 'duty', 'duty_off')),
  scope_b    text not null check (scope_b in ('none', 'duty', 'duty_off')),
  created_at timestamptz not null default now(),
  check (user_a < user_b),
  check (inviter_id in (user_a, user_b)),
  unique (user_a, user_b)
);
create index cal_share_links_b on public.cal_share_links (user_b);

-- 仲間の名前のラベル(見る人ごと。名前と色は見る人が決める。相手には関係しない)
create table public.cal_share_views (
  viewer_id  uuid not null references auth.users (id) on delete cascade,
  owner_id   uuid not null references auth.users (id) on delete cascade,
  name       text not null check (char_length(btrim(name)) between 1 and 10),
  color      text not null check (color ~ '^#[0-9a-fA-F]{6}$'),
  off_name   text not null check (char_length(btrim(off_name)) between 1 and 10),
  off_color  text not null check (off_color ~ '^#[0-9a-fA-F]{6}$'),
  sort       integer not null default 0,
  primary key (viewer_id, owner_id)
);

-- 送った記録(1日10回まで、を数える)。中身は見せない
create table public.cal_share_sends (
  user_id uuid not null references auth.users (id) on delete cascade,
  at      timestamptz not null default now()
);
create index cal_share_sends_user on public.cal_share_sends (user_id, at);

alter table public.cal_share_invites enable row level security;
alter table public.cal_share_links enable row level security;
alter table public.cal_share_views enable row level security;
alter table public.cal_share_sends enable row level security;

create policy cal_share_invites_mine on public.cal_share_invites for select to authenticated
  using ((from_id = auth.uid() or to_id = auth.uid()) and public.is_member());
create policy cal_share_links_mine on public.cal_share_links for select to authenticated
  using ((user_a = auth.uid() or user_b = auth.uid()) and public.is_member());
create policy cal_share_views_select on public.cal_share_views for select to authenticated
  using (viewer_id = auth.uid() and public.is_member());
create policy cal_share_views_update on public.cal_share_views for update to authenticated
  using (viewer_id = auth.uid() and public.is_member()) with check (viewer_id = auth.uid() and public.is_member());

revoke all on public.cal_share_invites, public.cal_share_links, public.cal_share_views, public.cal_share_sends from public, anon, authenticated;
grant select on public.cal_share_invites, public.cal_share_links, public.cal_share_views to authenticated;
grant update (name, color, off_name, off_color, sort) on public.cal_share_views to authenticated;
grant all on public.cal_share_invites, public.cal_share_links, public.cal_share_views, public.cal_share_sends to service_role;

-- ============================================================
-- 2. 内側で使う関数(利用者からは呼べない)
-- ============================================================
-- 2人の共有の数を、順番にロックしてから数える(2人が同時に「共有する」を押しても、5人を超えないように)
create or replace function public.cal_share_lock(a uuid, b uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if a is null or b is null then
    perform pg_advisory_xact_lock(hashtextextended('cal_share:' || coalesce(a, b)::text, 0));
  elsif a < b then
    perform pg_advisory_xact_lock(hashtextextended('cal_share:' || a::text, 0));
    perform pg_advisory_xact_lock(hashtextextended('cal_share:' || b::text, 0));
  else
    perform pg_advisory_xact_lock(hashtextextended('cal_share:' || b::text, 0));
    perform pg_advisory_xact_lock(hashtextextended('cal_share:' || a::text, 0));
  end if;
end;
$$;

-- 共有している人+自分が送った返事待ち(期限内)の数。except_invite は数えないお誘い(今、受けているもの)
create or replace function public.cal_share_count(u uuid, except_invite uuid default null)
returns integer
language sql
stable
set search_path = ''
as $$
  select (select count(*) from public.cal_share_links where user_a = u or user_b = u)::int
       + (select count(*) from public.cal_share_invites
           where from_id = u and status = 'pending' and expires_at > now() and id is distinct from except_invite)::int
$$;

-- 名前のラベルの色(人ごとに順番に)。勤務の色と、休日の色の組
create or replace function public.cal_share_palette(n integer, off boolean)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when off then (array['#f39c12', '#e84393', '#00a8a8', '#a0522d', '#7f8c8d'])[1 + (n % 5)]
              else (array['#16a085', '#8e44ad', '#2d6cdf', '#c0392b', '#556b2f'])[1 + (n % 5)] end
$$;

-- 見る人(viewer)に、相手(owner)の名前のラベルを作る(もうあれば、そのまま)
create or replace function public.cal_share_add_view(viewer uuid, owner uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  given text;
  n int;
begin
  select left(btrim(given_name), 8) into given from public.profiles where user_id = owner;
  if coalesce(given, '') = '' then given := '共有'; end if;
  select count(*) into n from public.cal_share_views where viewer_id = viewer;
  insert into public.cal_share_views (viewer_id, owner_id, name, color, off_name, off_color, sort)
  values (viewer, owner, given, public.cal_share_palette(n, false), given || '・休', public.cal_share_palette(n, true), n + 1)
  on conflict do nothing;
end;
$$;

-- ============================================================
-- 3. 画面から呼ぶ関数
-- ============================================================
-- お誘いを送る。相手がいてもいなくても、同じように終わる(登録しているか探れないように)。
-- 送った側の都合で送れないとき(1日10回・5人まで・自分あて・共有中・同じ番号に送ったまま)だけ、理由を返す
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
  no text := btrim(coalesce(p_employee_no, ''));
begin
  select employee_no into my_no from public.profiles where user_id = me;
  if me is null or my_no is null then raise exception 'ログインし直してください。' using errcode = '42501'; end if;
  if no !~ '^\d{7}$' then raise exception '社員番号は7桁の数字で入れてください。' using errcode = '22023'; end if;
  if p_kind is distinct from 'mate' then raise exception '共有の種類が正しくありません。' using errcode = '22023'; end if;
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
  select user_id into target from public.profiles where employee_no = no and role = 'user';
  if target is not null and exists (select 1 from public.cal_share_links
                                     where (user_a = me and user_b = target) or (user_a = target and user_b = me)) then
    raise exception 'この人とは、もう共有しています。' using errcode = '23505';
  end if;
  if public.cal_share_count(me) >= 5 then
    raise exception '共有できるのは5人までです(返事待ちも数えます)。' using errcode = '23514';
  end if;
  insert into public.cal_share_invites (from_id, to_id, to_employee_no, kind, from_scope)
  values (me, target, no, p_kind, p_scope);
end;
$$;

-- 共有の一覧(設定・お知らせで使う)。名前は、共有している人と、自分にお誘いを送った人のぶんだけ返す
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

-- 返事を待っている、自分あてのお誘いの数(赤い点)
create or replace function public.cal_share_inbox_count()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::int from public.cal_share_invites
   where to_id = auth.uid() and status = 'pending' and expires_at > now() and public.is_member()
$$;

-- 共有する(お誘いを受ける)。p_scope は自分が相手に見せる範囲
create or replace function public.cal_share_accept(p_invite uuid, p_scope text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  inv public.cal_share_invites;
begin
  if me is null or not public.is_member() then raise exception 'ログインし直してください。' using errcode = '42501'; end if;
  if p_scope not in ('none', 'duty', 'duty_off') then raise exception '見せる範囲が正しくありません。' using errcode = '22023'; end if;
  select * into inv from public.cal_share_invites where id = p_invite and to_id = me for update;
  if inv.id is null or inv.status <> 'pending' or inv.expires_at <= now() then
    raise exception 'このお誘いは、もう使えません(取り消されたか、期限が切れました)。' using errcode = 'P0002';
  end if;
  perform public.cal_share_lock(me, inv.from_id);
  if not exists (select 1 from public.cal_share_links
                  where (user_a = me and user_b = inv.from_id) or (user_a = inv.from_id and user_b = me)) then
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
    perform public.cal_share_add_view(me, inv.from_id);
    perform public.cal_share_add_view(inv.from_id, me);
  end if;
  -- 2人のあいだの、ほかの返事待ちのお誘い(お互いに送っていたとき)も片付ける
  update public.cal_share_invites set status = 'accepted', responded_at = now()
   where status = 'pending' and ((from_id = inv.from_id and to_id = me) or (from_id = me and to_id = inv.from_id) or id = inv.id);
end;
$$;

-- 断る
create or replace function public.cal_share_decline(p_invite uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_member() then raise exception 'ログインし直してください。' using errcode = '42501'; end if;
  update public.cal_share_invites set status = 'declined', responded_at = now()
   where id = p_invite and to_id = auth.uid() and status = 'pending';
end;
$$;

-- 送ったお誘いを取り消す・「共有されませんでした」を消す
create or replace function public.cal_share_cancel(p_invite uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_member() then raise exception 'ログインし直してください。' using errcode = '42501'; end if;
  delete from public.cal_share_invites where id = p_invite and from_id = auth.uid() and status <> 'accepted';
end;
$$;

-- 自分が相手に見せる範囲を変える
create or replace function public.cal_share_set_scope(p_link uuid, p_scope text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
begin
  if me is null or not public.is_member() then raise exception 'ログインし直してください。' using errcode = '42501'; end if;
  if p_scope not in ('none', 'duty', 'duty_off') then raise exception '見せる範囲が正しくありません。' using errcode = '22023'; end if;
  update public.cal_share_links
     set scope_a = case when user_a = me then p_scope else scope_a end,
         scope_b = case when user_b = me then p_scope else scope_b end
   where id = p_link and (user_a = me or user_b = me);
  if not found then raise exception 'この共有は、もうありません。' using errcode = 'P0002'; end if;
end;
$$;

-- 共有をやめる(どちらからでも)。お互いの名前のラベルも消す
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
  delete from public.cal_share_links where id = p_link and (user_a = me or user_b = me) returning * into l;
  if l.id is null then return; end if;
  delete from public.cal_share_views
   where (viewer_id = l.user_a and owner_id = l.user_b) or (viewer_id = l.user_b and owner_id = l.user_a);
end;
$$;

-- 共有をやめたあと・アカウントが消えたあとに、名前のラベルが残らないように(相手が退会したとき)
create or replace function public.cal_share_links_after_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.cal_share_views
   where (viewer_id = old.user_a and owner_id = old.user_b) or (viewer_id = old.user_b and owner_id = old.user_a);
  return old;
end;
$$;
create trigger cal_share_links_after_delete after delete on public.cal_share_links
  for each row execute function public.cal_share_links_after_delete();

-- ============================================================
-- 4. 関数の権限: 自動で付いたものを外して、画面から呼ぶものだけ authenticated に
-- ============================================================
revoke execute on function public.cal_share_lock(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.cal_share_count(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.cal_share_palette(integer, boolean) from public, anon, authenticated;
revoke execute on function public.cal_share_add_view(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.cal_share_links_after_delete() from public, anon, authenticated;
revoke execute on function public.cal_share_send(text, text, text) from public, anon;
revoke execute on function public.cal_share_list() from public, anon;
revoke execute on function public.cal_share_inbox_count() from public, anon;
revoke execute on function public.cal_share_accept(uuid, text) from public, anon;
revoke execute on function public.cal_share_decline(uuid) from public, anon;
revoke execute on function public.cal_share_cancel(uuid) from public, anon;
revoke execute on function public.cal_share_set_scope(uuid, text) from public, anon;
revoke execute on function public.cal_share_stop(uuid) from public, anon;
grant execute on function public.cal_share_send(text, text, text), public.cal_share_list(), public.cal_share_inbox_count(),
  public.cal_share_accept(uuid, text), public.cal_share_decline(uuid), public.cal_share_cancel(uuid),
  public.cal_share_set_scope(uuid, text), public.cal_share_stop(uuid) to authenticated;
