-- ローカル開発用の架空データ(実データは入れない)
-- `supabase db reset` で読み込まれる。本番のマスタは管理画面の CSV 取り込みで入れる。
insert into public.offices (name, sort_order) values ('サンプル区', 1)
on conflict (name) do nothing;

insert into public.shift_master
  (office_id, code, kind, weekday_start, weekday_end, holiday_start, holiday_end, stay, sort_order)
select o.id, v.code, v.kind, v.ws, v.we, v.hs, v.he, v.stay, v.ord
  from public.offices o,
       (values
         ('101', '泊',   '9:00',  '9:30',  '9:10',  '9:40',  'サンプル泊地A', 1),
         ('102', '泊',   '10:00', '8:45',  '10:00', '8:45',  'サンプル泊地B', 2),
         ('201', '日勤', '8:30',  '17:15', '9:00',  '17:00', '', 3),
         ('202', '日勤', '12:00', '21:00', '',      '',      '', 4),
         ('公休', '休日', '', '', '', '', '', 5),
         ('年休', '休日', '', '', '', '', '', 6)
       ) as v(code, kind, ws, we, hs, he, stay, ord)
 where o.name = 'サンプル区'
on conflict (office_id, code) do nothing;

-- ローカルで試すときは、自分の Google アカウントを管理者として許可リストに入れ、管理画面のパスワードを設定する(例)
-- insert into public.members (email, is_admin) values ('you@example.com', true);
-- select public.set_admin_passcode('local-passcode');
