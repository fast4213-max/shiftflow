-- shiftflowカレンダーに「出すもの」(勤務・休日・非番)の設定。null は「自動」(Google の設定から決める):
--   勤務: 出す / 休日: Google に登録していて休日用カレンダーが無い人は出さない・それ以外は出す / 非番を別のボタンにする: 非番の時間用カレンダーがある人だけ
-- 自分で決めたら、true / false が入る。
alter table public.user_settings
  add column if not exists cal_show_duty boolean,
  add column if not exists cal_show_off boolean,
  add column if not exists cal_offduty_label boolean;

grant insert (cal_show_duty, cal_show_off, cal_offduty_label) on public.user_settings to authenticated;
grant update (cal_show_duty, cal_show_off, cal_offduty_label) on public.user_settings to authenticated;
