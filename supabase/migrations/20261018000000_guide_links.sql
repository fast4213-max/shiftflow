-- 使い方リンク(動画・文書へのリンク)。ログイン画面の「はじめての方へ」・お知らせ画面・使い方ページに出す。
-- 読むのは関数 current_guide_links() 経由(未ログインでも可)。書くのは管理者(RLS)。並べ替えは関数 move_guide_link。

create table public.guide_links (
  id         bigint generated always as identity primary key,
  label      text not null check (char_length(btrim(label)) between 1 and 20),
  -- https:// だけ(空白・<>"' を含まない)。javascript: などは通さない
  url        text not null check (char_length(url) <= 500 and url ~ '^https://[^[:space:]<>"'']+$'),
  kind       text not null default 'video' check (kind in ('video', 'doc')),
  sort_order int not null default 0,
  visible    boolean not null default true,
  updated_at timestamptz not null default now()
);

comment on table public.guide_links is '使い方リンク(動画・文書)。ログイン画面などに、並び順(sort_order)どおりに出す。最大10件';

create trigger guide_links_updated_at before update on public.guide_links
  for each row execute function public.set_updated_at();

-- 最大10件(画面だけに任せない)
create or replace function public.guide_links_limit()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (select count(*) from public.guide_links) >= 10 then
    raise exception '使い方リンクは10件までです';
  end if;
  return new;
end;
$$;

create trigger guide_links_limit before insert on public.guide_links
  for each row execute function public.guide_links_limit();

alter table public.guide_links enable row level security;

create policy guide_links_admin_select on public.guide_links for select to authenticated using (public.is_admin());
create policy guide_links_admin_insert on public.guide_links for insert to authenticated with check (public.is_admin());
create policy guide_links_admin_update on public.guide_links for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy guide_links_admin_delete on public.guide_links for delete to authenticated using (public.is_admin());

-- いま出すリンク(表示するもの、並び順どおり)。未ログインでも呼べる
create or replace function public.current_guide_links()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', g.id, 'label', g.label, 'url', g.url, 'kind', g.kind)
                            order by g.sort_order, g.id), '[]'::jsonb)
    from public.guide_links g
   where g.visible
$$;

-- 1つ上(p_delta = -1)・下(1)へ動かす。全部を 1,2,3… に振り直す(抜けや同じ数字があっても崩れない)。端なら何もしない
create or replace function public.move_guide_link(p_id bigint, p_delta int)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  ids bigint[];
  i int;
  j int;
  tmp bigint;
begin
  if not public.is_admin() then
    raise exception '管理者だけが実行できます' using errcode = '42501';
  end if;
  select array_agg(id order by sort_order, id) into ids from public.guide_links;
  i := array_position(ids, p_id);
  if i is null then
    raise exception 'リンクが見つかりません(ほかの画面で消されたかもしれません)。画面を読み直してください';
  end if;
  j := i + case when p_delta < 0 then -1 else 1 end;
  if j >= 1 and j <= array_length(ids, 1) then
    tmp := ids[i]; ids[i] := ids[j]; ids[j] := tmp;
  end if;
  for k in 1..array_length(ids, 1) loop
    update public.guide_links set sort_order = k where id = ids[k] and sort_order <> k;
  end loop;
end;
$$;

revoke all on public.guide_links from anon, authenticated;
grant select, insert, update, delete on public.guide_links to authenticated;  -- 実際に触れるのは管理者だけ(RLS)
grant all on public.guide_links to service_role;

revoke execute on function public.guide_links_limit() from public, anon, authenticated;
revoke execute on function public.current_guide_links() from public, anon, authenticated;
revoke execute on function public.move_guide_link(bigint, int) from public, anon, authenticated;
grant execute on function public.current_guide_links() to anon, authenticated;
grant execute on function public.move_guide_link(bigint, int) to authenticated;
