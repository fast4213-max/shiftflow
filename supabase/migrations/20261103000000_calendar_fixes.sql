-- カレンダーのデバッグの直し(2026-11-03)。
-- M1: 写真を消す日(予定の終了日から1か月後)がもう過ぎている予定には、写真を付けられない
--     (付けると、保存した直後の片付けで消えて、「保存できたのに付かない」ように見えるため)
-- L4: 最初のラベルを2つの画面で同時に作っても、「その他」が2つにならない(人ごとの排他ロック)

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
  if new.expires_on is not null and new.expires_on < (now() at time zone 'Asia/Tokyo')::date then
    raise exception '終わって1か月以上たった予定には、写真を付けられません。' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.cal_ensure_default_labels()
returns void
language plpgsql
set search_path = ''
as $$
begin
  -- 同じ人の2つの呼び出しが重ならないようにする(重なると、まだ無いと見て、どちらも「その他」を作ってしまう)
  perform pg_advisory_xact_lock(hashtextextended('cal_ensure_default_labels:' || coalesce(auth.uid()::text, ''), 0));
  insert into public.cal_labels (kind, name, color, sort) values ('duty', '勤務', '#3b6fd4', 1) on conflict do nothing;
  insert into public.cal_labels (kind, name, color, sort) values ('off', '休日', '#e0553f', 2) on conflict do nothing;
  if not exists (select 1 from public.cal_labels where user_id = auth.uid() and kind = 'custom') then
    insert into public.cal_labels (kind, name, color, sort) values ('custom', 'その他', '#6b7280', 3);
  end if;
end;
$$;

revoke execute on function public.cal_photos_before_insert() from public, anon, authenticated;
revoke execute on function public.cal_ensure_default_labels() from public, anon;
grant execute on function public.cal_ensure_default_labels() to authenticated;
