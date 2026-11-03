-- 「Googleカレンダーにも登録する」の初期値を、チェックなし(false)にする。
--   これから使い始める人は、最初は保存だけ(登録のボタンは出ない)。Googleに登録したい人は、設定でチェックを入れる。
--   今、Googleカレンダーに登録して使っている人(true)は、そのまま変えない。
alter table public.user_settings alter column google_sync set default false;

-- 前の migration のあとに作られた行のうち、カレンダーIDが空のもの(Googleを設定していない人)は、チェックなしにそろえる
update public.user_settings set google_sync = false where google_sync and work_calendar_id = '';
