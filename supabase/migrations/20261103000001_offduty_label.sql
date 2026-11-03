-- カレンダーに「非番」のラベルを足す(勤務のボタンを押して隠したとき、非番の予定まで一緒に消えないように)。
-- 勤務(duty)・休日(off)・非番(offduty)は、勤務の予定の色。1人に1つずつ。
alter table public.cal_labels drop constraint if exists cal_labels_kind_check;
alter table public.cal_labels add constraint cal_labels_kind_check check (kind in ('custom', 'duty', 'off', 'offduty'));

-- 最初のラベル。足りないものだけ作る(何度呼んでも増えない)。今の利用者には「非番」だけが足される(並びは休日の次)
create or replace function public.cal_ensure_default_labels()
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('cal_ensure_default_labels:' || coalesce(auth.uid()::text, ''), 0));
  insert into public.cal_labels (kind, name, color, sort) values ('duty', '勤務', '#3b6fd4', 1) on conflict do nothing;
  insert into public.cal_labels (kind, name, color, sort) values ('off', '休日', '#e0553f', 2) on conflict do nothing;
  insert into public.cal_labels (kind, name, color, sort) values ('offduty', '非番', '#d4607a', 2) on conflict do nothing;
  if not exists (select 1 from public.cal_labels where user_id = auth.uid() and kind = 'custom') then
    insert into public.cal_labels (kind, name, color, sort) values ('custom', 'その他', '#6b7280', 3);
  end if;
end;
$$;

revoke execute on function public.cal_ensure_default_labels() from public, anon;
grant execute on function public.cal_ensure_default_labels() to authenticated;
