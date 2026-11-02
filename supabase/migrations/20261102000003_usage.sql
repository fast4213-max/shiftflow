-- 無料枠の使用量(管理画面の概要に出す)。管理者だけが呼べる。
--   データベース: 500MB / Storage: 1GB(Supabase の無料プラン。上限は表示のための目安で、ここで止めはしない)
--   写真・画像の内訳(枚数と大きさ)と、使っている量の多い人(社員番号・名前。ファイルの中身は見えない)
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
          select user_id, size_bytes as bytes from public.cal_photos
          union all
          select user_id, size_bytes as bytes from public.cal_gallery
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

revoke execute on function public.admin_usage() from public, anon;
grant execute on function public.admin_usage() to authenticated;
