-- お問い合わせの「返事が来た」赤い点(設計: docs/contact/DESIGN.md の 6章)
--
-- ログインした人の、自分のお問い合わせに来た管理者の返事のうち、いちばん新しい時刻だけを返す。返事が無ければ null。
-- 中身(文章・メールアドレス)は返さない。画面は、この時刻と「お問い合わせのページで見た返事の時刻」(端末に保存)を比べて点を出す。
-- 数える返事は、お問い合わせのページ(Edge Function contact の mine = listMine)に出るものとそろえる:
--   新しい20件の問い合わせ・管理者の返事・送れなかったメール(mail_status = 'failed')は除く。
-- そろえないと、ページに出ない返事のせいで、見ても点が消えなくなる。

create or replace function public.my_contact_reply_at()
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select max(m.created_at)
    from public.inquiry_messages m
   where m.sender = 'admin'
     and m.mail_status is distinct from 'failed'
     and m.inquiry_id in (
       select i.id from public.inquiries i
        where i.user_id = auth.uid()
        order by i.created_at desc
        limit 20
     )
$$;

comment on function public.my_contact_reply_at() is '自分のお問い合わせへの、いちばん新しい管理者の返事の時刻(赤い点用。中身は返さない)';

revoke execute on function public.my_contact_reply_at() from public, anon, authenticated;
grant execute on function public.my_contact_reply_at() to authenticated;
