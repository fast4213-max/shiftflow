-- shiftflowカレンダー(アプリ内カレンダー)の表と、写真の置き場(Storage)の権限。設計は docs/mycalendar/DESIGN.md。
-- どの表も、本人の行だけ読み書きできる(RLS。勤務記録 shift_records と同じ方式)。1アカウント1人のカレンダー。
-- 今の利用者のデータ(shift_records・user_settings など)は一切変えない。新しい表を足すだけ。
--
-- 勤務の予定は、ここに持たない(shift_records から、勤務入力と同じ組み立てで画面に出す)。
-- ここにあるのは、自分で作る予定・ラベル・スタンプ・TODO・重要メモ・画像の置き場・予定の写真の一覧だけ。

-- ============================================================
-- 1. 上限を決める共通のトリガー(1人あたり・親1件あたりの数)
--    引数: 上限の数, 親の列の名前(空なら1人あたり), エラーに出す名前
-- ============================================================
create or replace function public.cal_limit()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  lim int := tg_argv[0]::int;
  grp text := nullif(tg_argv[1], '');
  n bigint;
begin
  if grp is null then
    execute format('select count(*) from public.%I where user_id = $1', tg_table_name) into n using new.user_id;
  else
    execute format('select count(*) from public.%I where user_id = $1 and %I::text = $2', tg_table_name, grp)
      into n using new.user_id, to_jsonb(new) ->> grp;
  end if;
  if n >= lim then
    raise exception '% は % 件までです。', tg_argv[2], lim using errcode = '23514';
  end if;
  return new;
end;
$$;

-- ============================================================
-- 2. ラベル(名前+色。並び順)。kind: custom=自分で作る / duty・off=勤務・休日(勤務の予定の色)。duty・off は1人1つ
-- ============================================================
create table public.cal_labels (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind       text not null default 'custom' check (kind in ('custom', 'duty', 'off')),
  name       text not null check (char_length(btrim(name)) between 1 and 20),
  color      text not null check (color ~ '^#[0-9a-fA-F]{6}$'),
  sort       integer not null default 0,
  created_at timestamptz not null default now(),
  unique (id, user_id)
);
create unique index cal_labels_kind_once on public.cal_labels (user_id, kind) where kind <> 'custom';
create index cal_labels_user on public.cal_labels (user_id, sort);

create or replace function public.cal_labels_limit()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.kind = 'custom'
     and (select count(*) from public.cal_labels where user_id = new.user_id and kind = 'custom') >= 10 then
    raise exception 'ラベルは 10 件までです。' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger cal_labels_limit before insert on public.cal_labels
  for each row execute function public.cal_labels_limit();

-- ============================================================
-- 3. 予定(自分で作る予定。繰り返し・複数日・時間指定)。時刻は「HH:MM」の分単位
-- ============================================================
create table public.cal_events (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title        text not null default '' check (char_length(title) <= 100),
  start_date   date not null,
  end_date     date not null,
  all_day      boolean not null default true,
  start_time   text not null default '' check (start_time = '' or start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  end_time     text not null default '' check (end_time = '' or end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  label_id     uuid not null,
  memo         text not null default '' check (char_length(memo) <= 1000),
  repeat_rule  text not null default 'none' check (repeat_rule in ('none', 'daily', 'weekly', 'monthly', 'yearly')),
  repeat_until date,
  exdates      jsonb not null default '[]' check (jsonb_typeof(exdates) = 'array' and jsonb_array_length(exdates) <= 500),
  years_label  text not null default '' check (years_label in ('', 'age', 'anniv')),
  version      integer not null default 1,   -- 更新のたびに +1(同時に直したときの検知用)。画面から決めた値は使わない
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (id, user_id),
  foreign key (label_id, user_id) references public.cal_labels (id, user_id) on delete restrict,
  check (end_date >= start_date),
  check (end_date - start_date <= 366),
  check (all_day or start_time <> ''),
  check (all_day or end_date > start_date or end_time = '' or end_time >= start_time),
  check (repeat_until is null or repeat_until >= start_date)
);
create index cal_events_user_start on public.cal_events (user_id, start_date);

create or replace function public.cal_events_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    new.version := old.version + 1;
    new.created_at := old.created_at;
  else
    new.version := 1;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger cal_events_before_write before insert or update on public.cal_events
  for each row execute function public.cal_events_before_write();
create trigger cal_events_limit before insert on public.cal_events
  for each row execute function public.cal_limit(5000, '', '予定');

-- ============================================================
-- 4. 予定の写真の一覧(中身は Storage の calendar バケット)。1つの予定に3枚まで。
--    消す日(expires_on)は「予定の終了日から1か月」。繰り返しの予定は消さない(null)。消す処理は後の段階(Storage の API で消してから行を消す)
-- ============================================================
create table public.cal_photos (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  event_id   uuid not null,
  path       text not null check (path like user_id::text || '/%'),
  size_bytes integer not null default 0 check (size_bytes >= 0),
  expires_on date,
  created_at timestamptz not null default now(),
  foreign key (event_id, user_id) references public.cal_events (id, user_id) on delete cascade
);
create index cal_photos_event on public.cal_photos (event_id);
create index cal_photos_expires on public.cal_photos (expires_on) where expires_on is not null;

create or replace function public.cal_photos_before_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  e record;
begin
  select end_date, repeat_rule into e from public.cal_events where id = new.event_id and user_id = new.user_id;
  new.expires_on := case when e.repeat_rule = 'none' then (e.end_date + interval '1 month')::date else null end;
  return new;
end;
$$;
create trigger cal_photos_before_insert before insert on public.cal_photos
  for each row execute function public.cal_photos_before_insert();
create trigger cal_photos_limit before insert on public.cal_photos
  for each row execute function public.cal_limit(3, 'event_id', '予定の写真');

-- 予定の終了日・繰り返しを変えたら、写真を消す日も合わせる
-- 利用者は写真の行を更新できない(消す日を書き換えられない)ので、この関数だけが書けるように security definer にする
create or replace function public.cal_events_after_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.end_date is distinct from old.end_date or new.repeat_rule is distinct from old.repeat_rule then
    update public.cal_photos
       set expires_on = case when new.repeat_rule = 'none' then (new.end_date + interval '1 month')::date else null end
     where event_id = new.id and user_id = new.user_id;
  end if;
  return new;
end;
$$;
create trigger cal_events_after_update after update on public.cal_events
  for each row execute function public.cal_events_after_update();

-- ============================================================
-- 5. スタンプ(種類と、日付に置いたもの)
-- ============================================================
create table public.cal_stamp_defs (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind         text not null check (kind in ('emoji', 'image', 'text')),
  emoji        text not null default '' check (char_length(emoji) <= 16),
  image_path   text not null default '' check (image_path = '' or image_path like user_id::text || '/%'),
  text         text not null default '' check (char_length(text) <= 8),
  text_color   text not null default '#ffffff' check (text_color ~ '^#[0-9a-fA-F]{6}$'),
  bg_color     text not null default '#5b4bd6' check (bg_color ~ '^#[0-9a-fA-F]{6}$'),
  shape        text not null default 'round' check (shape in ('round', 'square', 'bubble')),
  default_size real not null default 0.34 check (default_size between 0.05 and 2.5),
  sort         integer not null default 0,
  created_at   timestamptz not null default now(),
  unique (id, user_id),
  check ((kind = 'emoji' and emoji <> '') or (kind = 'image' and image_path <> '') or (kind = 'text' and text <> ''))
);
create trigger cal_stamp_defs_limit before insert on public.cal_stamp_defs
  for each row execute function public.cal_limit(40, '', 'スタンプの種類');

create table public.cal_stamps (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  date         date not null,
  stamp_def_id uuid not null,
  x            real not null check (x between -1 and 2),
  y            real not null check (y between -1 and 2),
  size         real not null check (size between 0.05 and 2.5),
  rotation     real not null default 0 check (rotation between -360 and 360),
  notes        jsonb not null default '[]' check (jsonb_typeof(notes) = 'array' and jsonb_array_length(notes) <= 10),  -- [{t:題名, d:詳細}]
  created_at   timestamptz not null default now(),
  foreign key (stamp_def_id, user_id) references public.cal_stamp_defs (id, user_id) on delete cascade
);
create index cal_stamps_user_date on public.cal_stamps (user_id, date);
create trigger cal_stamps_limit before insert on public.cal_stamps
  for each row execute function public.cal_limit(3000, '', 'スタンプ');

-- ============================================================
-- 6. TODOメモ・重要メモ・画像の置き場
-- ============================================================
create table public.cal_todos (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  text       text not null check (char_length(btrim(text)) between 1 and 100),
  done       boolean not null default false,
  sort       integer not null default 0,
  created_at timestamptz not null default now()
);
create index cal_todos_user on public.cal_todos (user_id, sort);
create trigger cal_todos_limit before insert on public.cal_todos
  for each row execute function public.cal_limit(200, '', 'TODOメモ');

create table public.cal_importants (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title      text not null check (char_length(btrim(title)) between 1 and 40),
  body       text not null default '' check (char_length(body) <= 1000),
  sort       integer not null default 0,
  created_at timestamptz not null default now()
);
create index cal_importants_user on public.cal_importants (user_id, sort);
create trigger cal_importants_limit before insert on public.cal_importants
  for each row execute function public.cal_limit(100, '', '重要メモ');

-- 「画像」(日程表などの置き場)。1人10枚まで。自動では消えない
create table public.cal_gallery (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  path       text not null check (path like user_id::text || '/%'),
  title      text not null default '' check (char_length(title) <= 40),
  size_bytes integer not null default 0 check (size_bytes >= 0),
  created_at timestamptz not null default now()
);
create index cal_gallery_user on public.cal_gallery (user_id, created_at desc);
create trigger cal_gallery_limit before insert on public.cal_gallery
  for each row execute function public.cal_limit(10, '', '画像');

-- ============================================================
-- 7. 最初のラベル(勤務・休日・その他)。まだ1つも無い人に、1回だけ作る。何度呼んでも増えない
-- ============================================================
create or replace function public.cal_ensure_default_labels()
returns void
language plpgsql
set search_path = ''
as $$
begin
  insert into public.cal_labels (kind, name, color, sort) values ('duty', '勤務', '#3b6fd4', 1) on conflict do nothing;
  insert into public.cal_labels (kind, name, color, sort) values ('off', '休日', '#e0553f', 2) on conflict do nothing;
  if not exists (select 1 from public.cal_labels where user_id = auth.uid() and kind = 'custom') then
    insert into public.cal_labels (kind, name, color, sort) values ('custom', 'その他', '#6b7280', 3);
  end if;
end;
$$;

-- ============================================================
-- 8. RLS(本人の行だけ)と権限
-- ============================================================
do $$
declare
  t text;
begin
  foreach t in array array['cal_labels', 'cal_events', 'cal_photos', 'cal_stamp_defs', 'cal_stamps', 'cal_todos', 'cal_importants', 'cal_gallery'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy %I on public.%I for all to authenticated using (user_id = auth.uid() and public.is_member()) with check (user_id = auth.uid() and public.is_member())',
      t || '_own', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
  end loop;
end
$$;

grant select, insert, update, delete on public.cal_labels, public.cal_events, public.cal_stamp_defs, public.cal_stamps,
  public.cal_todos, public.cal_importants to authenticated;
-- 写真・画像の一覧は、入れる・消す・読むだけ(消す日 expires_on などは、入れるときにサーバー側の仕組みが決める)
grant select, insert, delete on public.cal_photos, public.cal_gallery to authenticated;
-- gallery は題名だけ直せる
grant update (title) on public.cal_gallery to authenticated;
grant all on public.cal_labels, public.cal_events, public.cal_photos, public.cal_stamp_defs, public.cal_stamps,
  public.cal_todos, public.cal_importants, public.cal_gallery to service_role;

-- 関数: 自動で付いた実行権限を外して、必要なものだけ付ける
revoke execute on function public.cal_limit() from public, anon, authenticated;
revoke execute on function public.cal_labels_limit() from public, anon, authenticated;
revoke execute on function public.cal_events_before_write() from public, anon, authenticated;
revoke execute on function public.cal_photos_before_insert() from public, anon, authenticated;
revoke execute on function public.cal_events_after_update() from public, anon, authenticated;
revoke execute on function public.cal_ensure_default_labels() from public, anon;
grant execute on function public.cal_ensure_default_labels() to authenticated;

-- ============================================================
-- 9. 写真の置き場(Storage)。非公開のバケット calendar。自分のフォルダ(<user_id>/…)だけ読み書き・消せる
--    1枚1MBまで・jpeg/png/webp だけ。Storage が無い環境(テスト用の素の PostgreSQL)では飛ばす
-- ============================================================
do $$
begin
  if to_regclass('storage.buckets') is null then
    return;
  end if;
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('calendar', 'calendar', false, 1048576, array['image/jpeg', 'image/png', 'image/webp'])
  on conflict (id) do update
    set public = false, file_size_limit = 1048576, allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

  drop policy if exists calendar_select_own on storage.objects;
  drop policy if exists calendar_insert_own on storage.objects;
  drop policy if exists calendar_delete_own on storage.objects;
  create policy calendar_select_own on storage.objects for select to authenticated
    using (bucket_id = 'calendar' and (storage.foldername(name))[1] = auth.uid()::text and public.is_member());
  create policy calendar_insert_own on storage.objects for insert to authenticated
    with check (bucket_id = 'calendar' and (storage.foldername(name))[1] = auth.uid()::text and public.is_member());
  create policy calendar_delete_own on storage.objects for delete to authenticated
    using (bucket_id = 'calendar' and (storage.foldername(name))[1] = auth.uid()::text and public.is_member());
exception when others then
  -- 本番の Storage の持ち主の権限で作れないときも、migration 全体(あとの反映)は止めない。
  -- その場合は、docs/mycalendar/CHECKLIST.md の「Storage の権限を手で作る SQL」を SQL エディタで実行する
  raise notice 'Storage の calendar バケット・権限を作れませんでした(%)。docs/mycalendar/CHECKLIST.md の手順で手で作ってください', sqlerrm;
end
$$;
