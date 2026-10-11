-- 勤務用の終日の予定のタイトルに、時間を半角の括弧で付けるかどうか。
--   title_day_time    : 出勤(日勤・泊)の番号のあとに出勤時間(例「1(10:00)」)
--   title_offduty_time: 非番の「〜」のあとに退勤時間(例「〜(9:00)」)
-- メモは変えない。次回の登録から使われる(登録済みの予定は変えない)。
alter table public.user_settings
  add column if not exists title_day_time boolean not null default false,
  add column if not exists title_offduty_time boolean not null default false;

grant insert (title_day_time, title_offduty_time) on public.user_settings to authenticated;
grant update (title_day_time, title_offduty_time) on public.user_settings to authenticated;
