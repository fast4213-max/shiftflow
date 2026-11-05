-- 交番表から休みを自動入力。設計は docs/kouban/DESIGN.md
--
-- user_settings.kouban: 本人が ⚙ で覚えた休みの並び(始まりの日・一周の日数・休みの日・予備の月)。本人が書く。
--   {"start":"2026-11-01","cycle":30,"days":{"3":"特休"},"spareMonths":[2,5,8,11],"spareOff":true}
--   中身の確かめは画面(web/js/kouban.js)。DB は形(オブジェクト)と大きさだけ見る。交番表のデータ・管理者の表は持たない。

alter table public.user_settings
  add column if not exists kouban jsonb not null default '{}'::jsonb;
alter table public.user_settings
  add constraint user_settings_kouban_check check (jsonb_typeof(kouban) = 'object' and pg_column_size(kouban) <= 4000);

comment on column public.user_settings.kouban is
  '交番表の休みの並び: {"start":始まりの日,"cycle":一周の日数,"days":{"何日目":"休みの番号"},"spareMonths":[予備の月],"spareOff":予備の月も休みを入れる}';

grant insert (kouban) on public.user_settings to authenticated;
grant update (kouban) on public.user_settings to authenticated;
