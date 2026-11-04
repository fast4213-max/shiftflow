-- ホーム画面のアイコン(カレンダーの設定の一番下で、利用者が選ぶ)。管理画面で足す・名前を直す・並べ替える・隠す・消す。
--   一覧は app_icons(名前・並び順・表示)。画像は Storage の公開バケット app-icons に、<id>/180.png・192.png・512.png の3枚を置く
--   (画像は管理画面が、正方形に切って3つの大きさにしてから入れる)。
--   はじめから入っている「電車・青・緑・オレンジ」は、コードの中(web/calendar/icons)にあり、この表には入れない。
--   読めるのはログインした人(表示中のものだけ)。管理者はすべて読める。書けるのは管理者だけ(RLS)。最大20件。

create table public.app_icons (
  id         bigint generated always as identity primary key,
  name       text not null check (char_length(btrim(name)) between 1 and 20),
  sort_order int not null default 0,
  visible    boolean not null default true,
  updated_at timestamptz not null default now()
);

comment on table public.app_icons is 'ホーム画面のアイコン(管理画面で足す)。画像は Storage の app-icons/<id>/{180,192,512}.png。最大20件';

create trigger app_icons_updated_at before update on public.app_icons
  for each row execute function public.set_updated_at();

-- 最大20件(画面だけに任せない)
create or replace function public.app_icons_limit()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (select count(*) from public.app_icons) >= 20 then
    raise exception 'アイコンは20件までです';
  end if;
  return new;
end;
$$;

create trigger app_icons_limit before insert on public.app_icons
  for each row execute function public.app_icons_limit();

alter table public.app_icons enable row level security;

create policy app_icons_select on public.app_icons for select to authenticated using (visible or public.is_admin());
create policy app_icons_admin_insert on public.app_icons for insert to authenticated with check (public.is_admin());
create policy app_icons_admin_update on public.app_icons for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy app_icons_admin_delete on public.app_icons for delete to authenticated using (public.is_admin());

-- 1つ上(p_delta = -1)・下(1)へ動かす。全部を 1,2,3… に振り直す(抜けや同じ数字があっても崩れない)。端なら何もしない
create or replace function public.move_app_icon(p_id bigint, p_delta int)
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
  select array_agg(id order by sort_order, id) into ids from public.app_icons;
  i := array_position(ids, p_id);
  if i is null then
    raise exception 'アイコンが見つかりません(ほかの画面で消されたかもしれません)。画面を読み直してください';
  end if;
  j := i + case when p_delta < 0 then -1 else 1 end;
  if j >= 1 and j <= array_length(ids, 1) then
    tmp := ids[i]; ids[i] := ids[j]; ids[j] := tmp;
  end if;
  for k in 1..array_length(ids, 1) loop
    update public.app_icons set sort_order = k where id = ids[k] and sort_order <> k;
  end loop;
end;
$$;

revoke all on public.app_icons from anon, authenticated;
grant select, insert, update, delete on public.app_icons to authenticated;  -- 書けるのは管理者だけ(RLS)。読むのは表示中のものだけ
grant all on public.app_icons to service_role;

revoke execute on function public.app_icons_limit() from public, anon, authenticated;
revoke execute on function public.move_app_icon(bigint, int) from public, anon, authenticated;
grant execute on function public.move_app_icon(bigint, int) to authenticated;

-- ============================================================
-- 画像の置き場(Storage)。公開のバケット app-icons(URL を知っていれば誰でも見られる。アイコンなので問題ない)。
--   入れる・消すのは管理者だけ。1枚1MBまで・png だけ。Storage が無い環境(テスト用の素の PostgreSQL)では飛ばす
-- ============================================================
do $$
begin
  if to_regclass('storage.buckets') is null then
    return;
  end if;
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('app-icons', 'app-icons', true, 1048576, array['image/png'])
  on conflict (id) do update
    set public = true, file_size_limit = 1048576, allowed_mime_types = array['image/png'];

  drop policy if exists app_icons_select_admin on storage.objects;
  drop policy if exists app_icons_insert_admin on storage.objects;
  drop policy if exists app_icons_delete_admin on storage.objects;
  -- 消すときに、消す行を探すために select の権限も要る(公開の URL で見るだけなら、権限は要らない)
  create policy app_icons_select_admin on storage.objects for select to authenticated
    using (bucket_id = 'app-icons' and public.is_admin());
  create policy app_icons_insert_admin on storage.objects for insert to authenticated
    with check (bucket_id = 'app-icons' and public.is_admin());
  create policy app_icons_delete_admin on storage.objects for delete to authenticated
    using (bucket_id = 'app-icons' and public.is_admin());
exception when others then
  -- 本番の Storage の持ち主の権限で作れないときも、migration 全体(あとの反映)は止めない。
  -- その場合は、docs/mycalendar/CHECKLIST.md の「アイコンの置き場を手で作る SQL」を SQL エディタで実行する
  raise notice 'Storage の app-icons バケット・権限を作れませんでした(%)。docs/mycalendar/CHECKLIST.md の手順で手で作ってください', sqlerrm;
end
$$;
