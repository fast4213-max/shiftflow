// アプリ内カレンダー用: 指定した期間の勤務の予定と祝日を返す(Google には何も書かない・何も読まない)。
// 勤務の記録(shift_records)を、利用者の設定(2件・名前に時間・時間つき)どおりに組み立てる(_shared/shift-view.ts)。
// 読み取りだけで、データは変えない。

import { requireMember } from "../_shared/auth.ts";
import { ensureHolidayYears } from "../_shared/holidays.ts";
import { AppError, readBody, serve } from "../_shared/http.ts";
import { addDays, dateKey, daysInMonth, holidayYearsFor } from "../_shared/plan.js";
import { loadMasterSet } from "../_shared/shift-calendar.ts";
import { buildShiftViewWithCarry, monthsBetween, validIso } from "../_shared/shift-view.ts";

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

  // 祝日(曜日の色と、平日・休日で泊の時間を選ぶため)
  await ensureHolidayYears(ctx.admin, holidayYearsFor(holFrom, holTo));
  const holRes = await ctx.db.from("holidays").select("date, name").gte("date", holFrom).lte("date", holTo).order("date");
  if (holRes.error) throw holRes.error;
  const holidays = (holRes.data || []) as { date: string; name: string }[];

  const settingsRes = await ctx.db
    .from("user_settings")
    .select("office_id, split_day_events, split_offduty_events, title_day_time, title_offduty_time, timed_events")
    .eq("user_id", ctx.userId)
    .maybeSingle();
  if (settingsRes.error) throw settingsRes.error;
  const s = settingsRes.data;
  // 区所が未設定なら、勤務の予定は出せない(祝日だけ返す)
  if (!s || !s.office_id) return { shifts: [], holidays, needOffice: true };

  const [master, recordsRes] = await Promise.all([
    loadMasterSet(ctx, s.office_id as number),
    ctx.db.from("shift_records").select("date, code, memo").gte("date", recFrom).lte("date", recTo),
  ]);
  if (recordsRes.error) throw recordsRes.error;
  const records: Record<string, { code: string; memo: string }> = {};
  for (const r of (recordsRes.data || [])) records[r.date as string] = { code: r.code as string, memo: r.memo as string };

  const shifts = buildShiftViewWithCarry({
    months,
    records,
    master,
    holidays: holidays.map((h) => h.date),
    settings: {
      splitDayEvents: !!s.split_day_events,
      splitOffdutyEvents: !!s.split_offduty_events,
      titleDayTime: !!s.title_day_time,
      titleOffdutyTime: !!s.title_offduty_time,
      timedEvents: !!s.timed_events,
    },
  });
  return { shifts, holidays, needOffice: false };
});
