-- 登録(register-month)が途中で失敗してやり直すと、翌月1日の予定が消えたまま戻らない不具合の対策。
-- 翌月1日にあるアプリの予定を消す前に、「この日を作り直す」という印(next_first_pending = 翌月1日)をここに残す。
-- 登録がうまくいったら消す。途中で失敗しても印が残るので、やり直したときに作り直せる。
-- 月をリセットしたとき(delete-month)も消す。書くのは Edge Function(service_role)だけ
-- (利用者に渡している列ごとの更新の権限には、この列を入れていない)。

alter table public.user_settings add column if not exists next_first_pending date;

comment on column public.user_settings.next_first_pending is
  '登録の途中で止まったときのための印: この日(翌月1日)のアプリの予定を消したので、次の登録で作り直す';
