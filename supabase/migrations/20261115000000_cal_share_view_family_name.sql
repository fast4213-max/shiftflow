-- 仲間の名前のラベルの初期値を、下の名前から苗字に変える(夫婦のラベルは、今までどおり下の名前)。
-- 設計は docs/share/DESIGN.md の2章。

-- 1. これから作るラベル: 相手の苗字(8文字まで)。苗字が空なら「共有」
create or replace function public.cal_share_add_view(viewer uuid, owner uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  fam text;
  n int;
begin
  select left(btrim(family_name), 8) into fam from public.profiles where user_id = owner;
  if coalesce(fam, '') = '' then fam := '共有'; end if;
  select count(*) into n from public.cal_share_views where viewer_id = viewer;
  insert into public.cal_share_views (viewer_id, owner_id, name, color, off_name, off_color, sort)
  values (viewer, owner, fam, public.cal_share_palette(n, false), fam || '・休', public.cal_share_palette(n, true), n + 1)
  on conflict do nothing;
end;
$$;

-- 2. もうあるラベルのうち、初期値の「下の名前」のまま(自分で変えていない)のものだけを、苗字にする。
--    自分で名前を直したものは、そのまま。仲間のラベルだけ(夫婦は cal_labels のラベルなので対象外)
update public.cal_share_views v
   set name = fam.f,
       off_name = fam.f || '・休'
  from (
    select p.user_id,
           coalesce(nullif(left(btrim(p.family_name), 8), ''), '共有') as f,
           coalesce(nullif(left(btrim(p.given_name), 8), ''), '共有') as g
      from public.profiles p
  ) fam
 where fam.user_id = v.owner_id
   and v.name = fam.g
   and v.off_name = fam.g || '・休'
   and exists (
     select 1 from public.cal_share_links l
      where l.kind <> 'couple'
        and ((l.user_a = v.viewer_id and l.user_b = v.owner_id) or (l.user_b = v.viewer_id and l.user_a = v.owner_id))
   );
