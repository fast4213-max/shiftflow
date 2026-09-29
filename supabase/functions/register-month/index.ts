// 指定月の入力を shift_records に保存し、カレンダーに登録する。
// このアプリが作った予定だけを消してから作り直す(手で入れた予定は消さない)。

import { requireMember } from "../_shared/auth.ts";
import { loadHolidays } from "../_shared/holidays.ts";
import { AppError, readBody, serve, yearMonthOf } from "../_shared/http.ts";
import { addDays, buildPlan, codeOf, dateKey, daysInMonth, indexMaster } from "../_shared/plan.js";
import {
  createEvents,
  deleteAppEvents,
  loadVerifiedCalendars,
  withUserLock,
} from "../_shared/shift-calendar.ts";

serve(async (req) => {
  const ctx = await requireMember(req);
  const body = await readBody(req);
  const { year, month } = yearMonthOf(body);
  const entries = body.entries && typeof body.entries === "object" ? body.entries as Record<string, unknown> : {};
  if (Object.keys(entries).length > 62) throw new AppError(400, "入力が多すぎます。");

  const calendars = await loadVerifiedCalendars(ctx);

  return await withUserLock(ctx, async () => {
    const first = dateKey(year, month, 1);
    const last = dateKey(year, month, daysInMonth(year, month));
    const prevLast = addDays(first, -1);
    const nextFirst = addDays(last, 1);

    const [masterRes, recordsRes, holidays] = await Promise.all([
      ctx.db.from("shift_master").select("*").order("sort_order"),
      ctx.db.from("shift_records").select("date, code, memo").in("date", [prevLast, nextFirst]),
      loadHolidays(ctx.admin, first, nextFirst),
    ]);
    if (masterRes.error) throw masterRes.error;
    if (recordsRes.error) throw recordsRes.error;
    const byDate = Object.fromEntries((recordsRes.data || []).map((r) => [r.date, r]));

    const plan = buildPlan({
      year,
      month,
      entries,
      prevLastCode: codeOf(byDate[prevLast]),
      nextFirstEntry: byDate[nextFirst],
      master: indexMaster(masterRes.data || []),
      holidays,
    });

    const saved = await ctx.db.rpc("save_month_records", { p_year: year, p_month: month, p_entries: plan.entries });
    if (saved.error) throw saved.error;

    await deleteAppEvents(calendars, year, month);
    const count = await createEvents(calendars, plan.events);

    await ctx.admin.from("user_settings")
      .update({ last_registered_at: new Date().toISOString() })
      .eq("user_id", ctx.userId);

    return { count };
  });
});
