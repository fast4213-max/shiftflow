-- 勤務を時間つきの予定で登録するかどうか(TimeTree など、時間つきの予定で勤務を見る人向け)。
--   泊は出勤時間から翌日の退勤時間までの1件(翌日の非番は作らない)、日勤は出勤から退勤まで。休日は終日のまま。
-- オンのあいだは「2件で登録」「名前に時間」は使わない。次回の登録から使われる(登録済みの予定は変えない)。
alter table public.user_settings
  add column if not exists timed_events boolean not null default false;

grant insert (timed_events) on public.user_settings to authenticated;
grant update (timed_events) on public.user_settings to authenticated;
