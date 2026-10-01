-- 出勤(日勤・泊)の予定を、終日の2件(番号・時間)に分けて登録するかどうか。
-- Googleカレンダーだけで勤務を見る人向け。次回の登録から使われる(登録済みの予定は変えない)。
alter table public.user_settings
  add column if not exists split_day_events boolean not null default false;

grant insert (split_day_events) on public.user_settings to authenticated;
grant update (split_day_events) on public.user_settings to authenticated;
