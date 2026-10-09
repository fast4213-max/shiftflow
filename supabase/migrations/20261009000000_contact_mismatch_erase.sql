-- 8回目のデバッグの修正(W11・W12)。反映済みの migration は書き換えず、ここで足す。
--
-- W12: 受信メールが「問い合わせのアドレスと違う人から」かどうかの、サーバーの判断を取り込み時に保存する
--   (管理画面が別に判断すると、スレッドで当てはまったメール・本物の届かなかった知らせとずれるため)。
--   null = 古い行・どの問い合わせにも当てはめていないメール(画面は今までの判断に戻る)。
--   表の権限は変えない(未ログイン・利用者は表を読めない。管理画面は Edge Function 経由)
alter table public.inquiry_messages add column if not exists mismatch boolean;
comment on column public.inquiry_messages.mismatch is
  '件名の受付番号だけで当てはめた、問い合わせのアドレスと違う人からのメールなら true(取り込み時の判断)。null = 古い行・当てはめていないメール';

-- W11: アドレスを消す(対応済みから30日)ときに、こちらの返事の行(sender = admin)の from_email(= 送り先)も消す。
--   残すと、管理画面は「アドレスは消去済み」と出すのに、返事の行にアドレスが出てしまう。
--   受信メール(sender = mail)の from_email は消さない: アドレスを消したあとに返信してきた人へ返すのに使う(DESIGN.md A4。
--   replyTarget が、こちらのスレッドに返信してきた人のアドレスを読む)。こちらは90日で問い合わせごと消える
--   中身は 20261006000000_contact_notices.sql の purge_old_contact() と同じで、アドレスを消す条件に合う問い合わせの返事の行を消す処理を足しただけ
--   (アドレスを消したあとに送った返事の行も、次の日に消えるよう、email が null のものも対象にする)
create or replace function public.purge_old_contact()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  n_inq bigint;
  n_mail bigint;
  n_email bigint;
begin
  delete from public.inquiries where last_activity_at < now() - interval '90 days';
  get diagnostics n_inq = row_count;
  delete from public.inquiry_messages where inquiry_id is null and created_at < now() - interval '90 days';
  get diagnostics n_mail = row_count;
  update public.inquiries set email = null
   where email is not null and status = 'done'
     and done_at < now() - interval '30 days' and last_activity_at < now() - interval '30 days';
  get diagnostics n_email = row_count;
  update public.inquiry_messages set from_email = null
   where sender = 'admin' and from_email is not null
     and inquiry_id in (
       select id from public.inquiries
        where email is null and status = 'done'
          and done_at < now() - interval '30 days' and last_activity_at < now() - interval '30 days'
     );
  delete from public.rate_limits where window_start < now() - interval '1 day';
  delete from public.discord_posts where created_at < now() - interval '120 days';
  insert into public.app_status (key, value, updated_at)
    values ('purge', jsonb_build_object('inquiries', n_inq, 'unmatched_mails', n_mail, 'emails', n_email), now())
    on conflict (key) do update set value = excluded.value, updated_at = now();
  return jsonb_build_object('inquiries', n_inq, 'unmatched_mails', n_mail, 'emails', n_email);
end;
$$;

-- 関数を作り直したあとも、権限は元のまま(サーバー専用)にしておく
revoke execute on function public.purge_old_contact() from public, anon, authenticated;
grant execute on function public.purge_old_contact() to service_role;
