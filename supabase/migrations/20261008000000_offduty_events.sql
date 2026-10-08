-- 非番を終日の「〜」と、退勤時間の時間つきの予定の2件で登録するかどうか(split_offduty_events)と、
-- その時間の予定を入れるカレンダー(offduty_calendar_id。空なら勤務用。色を変えたい人向け)。
-- 終日の「〜」は今までどおり勤務用に入る。次回の登録から使われる(登録済みの予定は変えない)。
alter table public.user_settings
  add column if not exists split_offduty_events boolean not null default false,
  add column if not exists offduty_calendar_id text not null default '';

-- カレンダーIDを変えたら検証済みを外す(非番用も勤務用・休日用と同じ)
create or replace function public.user_settings_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.work_calendar_id := trim(new.work_calendar_id);
  new.holiday_calendar_id := trim(new.holiday_calendar_id);
  new.offduty_calendar_id := trim(new.offduty_calendar_id);
  if tg_op = 'UPDATE' then
    if new.work_calendar_id is distinct from old.work_calendar_id
       or new.holiday_calendar_id is distinct from old.holiday_calendar_id
       or new.offduty_calendar_id is distinct from old.offduty_calendar_id then
      new.verified_at := null;
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

grant insert (split_offduty_events, offduty_calendar_id) on public.user_settings to authenticated;
grant update (split_offduty_events, offduty_calendar_id) on public.user_settings to authenticated;
