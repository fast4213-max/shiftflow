-- shiftflowカレンダー: 予定のテンプレートと、アナウンス(2026-11-08。設計は docs/mycalendar/DESIGN.md の末尾)。
-- 今の行は何も変えない(新しい表を足し、足した列は「出さない」・空から始まる)。

-- ============================================================
-- 1. 予定のテンプレート。予定を追加するとき、ボタン1つでタイトル・ラベル・時刻・メモを入れる。日付は持たない。1人30個まで
-- ============================================================
create table public.cal_templates (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title      text not null check (char_length(btrim(title)) between 1 and 100),
  label_id   uuid,
  all_day    boolean not null default true,
  start_time text not null default '' check (start_time = '' or start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  end_time   text not null default '' check (end_time = '' or end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  memo       text not null default '' check (char_length(memo) <= 1000),
  sort       integer not null default 0,
  created_at timestamptz not null default now(),
  -- ラベルは本人のものだけ。ラベルを消したら、テンプレートのラベルだけ空にする(テンプレートは残す。使うときは最初のラベルになる)
  foreign key (label_id, user_id) references public.cal_labels (id, user_id) on delete set null (label_id),
  check (all_day or start_time <> '')
);
create index cal_templates_user on public.cal_templates (user_id, sort);
create trigger cal_templates_limit before insert on public.cal_templates
  for each row execute function public.cal_limit(30, '', '予定のテンプレート');

alter table public.cal_templates enable row level security;
create policy cal_templates_own on public.cal_templates for all to authenticated
  using (user_id = auth.uid() and public.is_member()) with check (user_id = auth.uid() and public.is_member());
revoke all on public.cal_templates from public, anon, authenticated;
grant select, insert, update, delete on public.cal_templates to authenticated;
grant all on public.cal_templates to service_role;

-- ============================================================
-- 2. アナウンス(カレンダーの上に、1件ずつ切り替えて流す)。
--    none = 出さない / dated = 日付あり(「11/13(金) 車検 あと5日」) / plain = 日付なし(題名だけ)
--    予定の日付は予定の日。重要メモは「日付あり」のとき、日付(announce_on)を自分で入れる
-- ============================================================
alter table public.cal_events add column announce text not null default 'none' check (announce in ('none', 'dated', 'plain'));
alter table public.cal_importants add column announce text not null default 'none' check (announce in ('none', 'dated', 'plain'));
alter table public.cal_importants add column announce_on date;
alter table public.cal_importants add constraint cal_importants_announce_on check (announce <> 'dated' or announce_on is not null);
