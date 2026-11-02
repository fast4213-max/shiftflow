-- 「Googleカレンダーにも登録する」のチェック(自作カレンダーの1段階目: 保存だけで使える)。
--   true  = 今までと同じ。「登録」で保存して、Googleカレンダーにも入れる(初期値)
--   false = 保存だけ。Googleには何も書かない。接続テストもカレンダーIDも要らない
-- 既存の利用者は、カレンダーIDを設定済みの人は true(動きは今までと同じ)、空の人は false(保存だけで使える)。
-- 画面を更新していない人からのリクエストにはこの値が付かないので、サーバーは「値がない・true」のときは登録する。
alter table public.user_settings
  add column if not exists google_sync boolean not null default true;

update public.user_settings set google_sync = false where work_calendar_id = '';

grant insert (google_sync) on public.user_settings to authenticated;
grant update (google_sync) on public.user_settings to authenticated;
