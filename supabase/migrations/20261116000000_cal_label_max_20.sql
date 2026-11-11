-- 自分で作れるラベルを 10 個 → 20 個にする(カレンダーを共有すると、相手の分も同じカレンダーに入って足りなくなるため)。
-- 上限の数は cal_label_max() の 1 か所に持つ。数え方は今までどおり(kind = 'custom' だけ。勤務・休日・非番は数えない)。
-- 変えるもの: ① 追加のときの上限(トリガー) ② 夫婦の取り込み用の「取り込み」ラベル ③ 夫婦をやめて持って帰るときのラベルの枠
-- 今あるラベルは触らない(上限が広がるだけなので、データの変更は無い)。

create or replace function public.cal_label_max()
returns int
language sql
immutable
set search_path = ''
as $$ select 20 $$;

create or replace function public.cal_labels_limit()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.kind = 'custom'
     and (select count(*) from public.cal_labels where user_id = new.user_id and kind = 'custom') >= public.cal_label_max() then
    raise exception 'ラベルは % 件までです。', public.cal_label_max() using errcode = '23514';
  end if;
  return new;
end;
$$;

-- 予定の行き先のカレンダーで使う「取り込み」のラベル(無ければ作る。上限まであれば、いちばん上のラベル)
create or replace function public.cal_couple_fallback(to_owner uuid, who uuid)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  lid uuid;
begin
  select id into lid from public.cal_labels where user_id = to_owner and kind = 'custom' and name = '取り込み' and private_to is null limit 1;
  if lid is null and (select count(*) from public.cal_labels where user_id = to_owner and kind = 'custom') < public.cal_label_max() then
    insert into public.cal_labels (user_id, created_by, kind, name, color, sort) values (to_owner, who, 'custom', '取り込み', '#6b7280', 99)
    returning id into lid;
  end if;
  if lid is null then
    select id into lid from public.cal_labels where user_id = to_owner and kind = 'custom' and private_to is null order by sort, created_at limit 1;
  end if;
  return lid;
end;
$$;

-- 持って帰る・取り込む: 使っているラベルを先に、行き先のラベルの枠に入れる(使っていないラベルは、枠が1つ残るときだけ)
create or replace function public.cal_couple_move(from_owner uuid, to_owner uuid, who uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  r record;
  m jsonb := '{}'::jsonb;
  tgt uuid;
begin
  if from_owner = to_owner then return; end if;
  for r in select l.id, l.name, l.color, l.kind, l.private_to, l.created_by,
                  (l.id in (select label_id from public.cal_events where user_id = from_owner and created_by = who
                            union select label_id from public.cal_templates where user_id = from_owner and created_by = who and label_id is not null)) as used
             from public.cal_labels l
            where l.user_id = from_owner
            order by l.sort, l.created_at loop
    -- who が使っているラベルと、who が作ったラベル(使っていなくても持っていく)だけ
    continue when not r.used and not (r.kind = 'custom' and r.created_by = who);
    tgt := null;
    if r.kind = 'custom' and (r.private_to is null or r.private_to = who) then
      select id into tgt from public.cal_labels
       where user_id = to_owner and kind = 'custom' and name = r.name and private_to is not distinct from r.private_to limit 1;
      if tgt is null and (select count(*) from public.cal_labels where user_id = to_owner and kind = 'custom') < (case when r.used then public.cal_label_max() else public.cal_label_max() - 1 end) then
        insert into public.cal_labels (user_id, created_by, kind, name, color, sort, private_to)
        values (to_owner, who, 'custom', r.name, r.color, 90, r.private_to) returning id into tgt;
      end if;
    end if;
    if tgt is null and r.used then tgt := public.cal_couple_fallback(to_owner, who); end if;
    if tgt is not null then m := m || jsonb_build_object(r.id::text, tgt); end if;
  end loop;

  update public.cal_events set user_id = to_owner, label_id = (m ->> label_id::text)::uuid
   where user_id = from_owner and created_by = who;
  update public.cal_templates set user_id = to_owner, label_id = case when label_id is null then null else (m ->> label_id::text)::uuid end
   where user_id = from_owner and created_by = who;
  update public.cal_todos set user_id = to_owner where user_id = from_owner and created_by = who;
  update public.cal_importants set user_id = to_owner where user_id = from_owner and created_by = who;
  update public.cal_gallery set user_id = to_owner where user_id = from_owner and created_by = who;
  update public.cal_stamp_defs set user_id = to_owner where user_id = from_owner and created_by = who;

  delete from public.cal_labels l
   where l.user_id = from_owner and l.created_by = who and l.kind = 'custom'
     and not exists (select 1 from public.cal_events e where e.label_id = l.id)
     and not exists (select 1 from public.cal_templates t where t.label_id = l.id);
end;
$$;

-- cal_label_max() は数字を返すだけ。トリガー(ログイン中の利用者の権限で動く)の中から呼ぶので、利用者には残し、未ログインには出さない
revoke execute on function public.cal_label_max() from public, anon;
grant execute on function public.cal_label_max() to authenticated, service_role;
