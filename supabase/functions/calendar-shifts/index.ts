// アプリ内カレンダー用: 指定した期間の勤務の予定と祝日を返す(Google には何も書かない・何も読まない)。
// 勤務の記録(shift_records)を、利用者の設定(2件・名前に時間・時間つき)どおりに組み立てる(_shared/shift-view.ts)。
// 読み取りだけで、データは変えない。
// mates: true のときは、共有で自分に勤務を見せてくれている人の勤務も返す(docs/share/DESIGN.md)。
//   相手の勤務の記録+相手の区所のマスタ+自分(見る人)の表記の設定で組み立てる。範囲が「勤務だけ」の人の休日は返さない。

import { requireMember } from "../_shared/auth.ts";
import { ensureHolidayYears } from "../_shared/holidays.ts";
import { AppError, readBody, serve } from "../_shared/http.ts";
import { addDays, dateKey, daysInMonth, holidayYearsFor } from "../_shared/plan.js";
import { loadMasterSet } from "../_shared/shift-calendar.ts";
import { buildShiftViewWithCarry, monthsBetween, validIso, type ViewEvent } from "../_shared/shift-view.ts";
import { mateView, type ShareLink, sharedOwners } from "../_shared/share.ts";

const MAX_MONTHS = 5;

serve(async (req) => {
  const ctx = await requireMember(req);
  const body = await readBody(req);
  const from = String(body.from || "");
  const to = String(body.to || "");
  if (!validIso(from) || !validIso(to) || from > to) throw new AppError(400, "期間の指定が正しくありません。", "bad_period");
  const months = monthsBetween(from, to);
  if (months.length > MAX_MONTHS) throw new AppError(400, "期間が長すぎます。", "bad_period");

  const first = dateKey(months[0].year, months[0].month, 1);
  const lastMonth = months[months.length - 1];
  const last = dateKey(lastMonth.year, lastMonth.month, daysInMonth(lastMonth.year, lastMonth.month));
  // 記録は、1か月前から(前の月の末日からの泊の続きを組み立てるため。buildShiftViewWithCarry)
  const prevFirst = months[0].month === 1 ? dateKey(months[0].year - 1, 12, 1) : dateKey(months[0].year, months[0].month - 1, 1);
  const recFrom = addDays(prevFirst, -1);
  const recTo = addDays(last, 1);
  const holFrom = addDays(first, -1);
  const holTo = addDays(last, 2);

  // 祝日(曜日の色と、平日・休日で泊の時間を選ぶため)と設定は、同時に読む(待ち時間を短くする)
  const holP = (async () => {
    await ensureHolidayYears(ctx.admin, holidayYearsFor(holFrom, holTo));
    return await ctx.db.from("holidays").select("date, name").gte("date", holFrom).lte("date", holTo).order("date");
  })();
  const settingsP = ctx.db
    .from("user_settings")
    .select("office_id, split_day_events, split_offduty_events, title_day_time, title_offduty_time, timed_events")
    .eq("user_id", ctx.userId)
    .maybeSingle();
  const [holRes, settingsRes] = await Promise.all([holP, settingsP]);
  if (holRes.error) throw holRes.error;
  const holidays = (holRes.data || []) as { date: string; name: string }[];
  if (settingsRes.error) throw settingsRes.error;
  const s = settingsRes.data;
  const viewSettings = {
    splitDayEvents: !!s?.split_day_events,
    splitOffdutyEvents: !!s?.split_offduty_events,
    titleDayTime: !!s?.title_day_time,
    titleOffdutyTime: !!s?.title_offduty_time,
    timedEvents: !!s?.timed_events,
  };
  // マスタは区所ごとに1回だけ読む(自分と相手が同じ区所のとき)
  const masters = new Map<number, Promise<unknown>>();
  const masterOf = (officeId: number) => {
    if (!masters.has(officeId)) masters.set(officeId, loadMasterSet(ctx, officeId));
    return masters.get(officeId)!;
  };
  const build = (master: unknown, rows: { date: string; code: string; memo: string }[]): ViewEvent[] => {
    const records: Record<string, { code: string; memo: string }> = {};
    for (const r of rows) records[r.date] = { code: r.code, memo: r.memo };
    return buildShiftViewWithCarry({ months, records, master, holidays: holidays.map((h) => h.date), settings: viewSettings });
  };

  const matesP = body.mates === true ? loadMates() : Promise.resolve(undefined);

  // 区所が未設定なら、自分の勤務の予定は出せない(祝日と、共有の相手の勤務だけ返す)
  if (!s || !s.office_id) return { shifts: [], holidays, needOffice: true, mates: await matesP };

  const [master, recordsRes] = await Promise.all([
    masterOf(s.office_id as number),
    ctx.db.from("shift_records").select("date, code, memo").gte("date", recFrom).lte("date", recTo),
  ]);
  if (recordsRes.error) throw recordsRes.error;
  const shifts = build(master, (recordsRes.data || []) as { date: string; code: string; memo: string }[]);
  return { shifts, holidays, needOffice: false, mates: await matesP };

  // 共有の相手の勤務。許可(見せる範囲)はサーバーで確かめる。相手の記録は service_role で読む(本人以外は RLS で読めないため)
  async function loadMates() {
    const linksRes = await ctx.admin.from("cal_share_links").select("user_a, user_b, scope_a, scope_b")
      .or(`user_a.eq.${ctx.userId},user_b.eq.${ctx.userId}`);
    if (linksRes.error) throw linksRes.error;
    const owners = sharedOwners(ctx.userId, (linksRes.data || []) as ShareLink[]);
    if (!owners.length) return [];
    const ids = owners.map((o) => o.ownerId);
    const setRes = await ctx.admin.from("user_settings").select("user_id, office_id").in("user_id", ids);
    if (setRes.error) throw setRes.error;
    const office = new Map((setRes.data || []).map((r) => [r.user_id as string, r.office_id as number | null]));
    // 記録は人ごとに読む(5人分を1回で読むと、1回に読める行数を超えることがあるため)
    const built = await Promise.all(owners.map(async (o) => {
      const officeId = office.get(o.ownerId);
      if (!officeId) return null; // 区所を選んでいない人の勤務は、組み立てられない
      const [master, recRes] = await Promise.all([
        masterOf(officeId),
        ctx.admin.from("shift_records").select("date, code, memo").eq("user_id", o.ownerId).gte("date", recFrom).lte("date", recTo),
      ]);
      if (recRes.error) throw recRes.error;
      return { ownerId: o.ownerId, scope: o.scope, shifts: mateView(build(master, (recRes.data || []) as { date: string; code: string; memo: string }[]), o.scope) };
    }));
    return built.filter((x) => x !== null);
  }
});
