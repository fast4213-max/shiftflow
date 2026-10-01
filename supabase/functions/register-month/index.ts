// 指定月の入力を shift_records に保存し、カレンダーに登録する。
// このアプリが作った予定だけを消してから作り直す(手で入れた予定は消さない)。

import { requireMember } from "../_shared/auth.ts";
import { loadHolidays } from "../_shared/holidays.ts";
import { AppError, readBody, serve, yearMonthOf } from "../_shared/http.ts";
import { addDays, buildPlan, codeOf, dateKey, daysInMonth, indexMaster } from "../_shared/plan.js";
import {
  createEvents,
  deleteAppEvents,
  deleteRecords,
  eventsToRegister,
  listAppEvents,
  loadVerifiedCalendars,
  splitDayEvents,
  staleNextMonthRecords,
  withUserLock,
} from "../_shared/shift-calendar.ts";

serve(async (req) => {
  const ctx = await requireMember(req);
  const body = await readBody(req);
  const { year, month } = yearMonthOf(body);
  const entries = body.entries && typeof body.entries === "object" ? body.entries as Record<string, unknown> : {};
  if (Object.keys(entries).length > 62) throw new AppError(400, "入力が多すぎます。");

  const calendars = await loadVerifiedCalendars(ctx);
  if (!calendars.officeId) throw new AppError(400, "設定画面で区所を選んでください。", "no_office");

  return await withUserLock(ctx, async () => {
    const first = dateKey(year, month, 1);
    const last = dateKey(year, month, daysInMonth(year, month));
    const prevLast = addDays(first, -1);
    const nextFirst = addDays(last, 1);

    // 月末(last)は、登録する前の番号を見るために読む(翌月1日の非番が変わるかどうか)
    const [masterRes, recordsRes, holidays] = await Promise.all([
      ctx.db.from("shift_master").select("*").eq("office_id", calendars.officeId).order("sort_order"),
      ctx.db.from("shift_records").select("date, code, memo").in("date", [prevLast, last, nextFirst]),
      loadHolidays(ctx.admin, first, nextFirst),
    ]);
    if (masterRes.error) throw masterRes.error;
    if (recordsRes.error) throw recordsRes.error;
    const byDate = Object.fromEntries((recordsRes.data || []).map((r) => [r.date, r]));
    const master = indexMaster(masterRes.data || []);

    const plan = buildPlan({
      year,
      month,
      entries,
      prevLastCode: codeOf(byDate[prevLast]),
      nextFirstEntry: byDate[nextFirst],
      master,
      holidays,
    });
    const nextFirstOffduty = plan.events.some((e) => e.date === nextFirst && e.kind === "offduty");

    const saved = await ctx.db.rpc("save_month_records", { p_year: year, p_month: month, p_entries: plan.entries });
    if (saved.error) throw saved.error;

    // 月末の泊が変わって翌月1日の非番が変わったら、翌月1日・2日の記録の、前の状態のための番号やメモを消す。
    // 残しておくと、あとで月末を泊から戻したとき(泊を1日前へ入れ直したときなど)、消えたはずの番号が戻ってしまうため
    await deleteRecords(ctx, staleNextMonthRecords({
      nextFirst,
      lastCode: codeOf(byDate[last]),
      nextFirstOffduty,
      nextFirstCode: codeOf(byDate[nextFirst]),
      master,
    }));

    const existing = await listAppEvents(calendars, year, month);
    const registered = eventsToRegister(plan.events, existing, nextFirst);
    // 出勤を終日2件(番号・時間)に分ける設定の人は、次回の登録から時間の予定も作る
    const events = calendars.splitDayEvents ? splitDayEvents(registered, master) : registered;
    // 翌月1日の予定(月末が泊なら非番、泊でなければ翌月1日の記録の予定)を作るときは、
    // 翌月1日にあるアプリの予定を全部消してから作り直す(重ならないように)。
    // 翌月1日が非番なら翌月2日は非番にならないので、翌月2日に残った非番(翌月1日が泊だったとき)も消す
    const clearNextFirst = events.some((e) => e.date === nextFirst);
    await deleteAppEvents(calendars, year, month, { clearNextFirst, clearNextSecondOffduty: nextFirstOffduty, existing });
    const { created, skipped } = await createEvents(calendars, events);

    await ctx.admin.from("user_settings")
      .update({ last_registered_at: new Date().toISOString() })
      .eq("user_id", ctx.userId);

    // skipped: 休日用のカレンダーを設定していない人の「休日」の予定(登録していない)
    return { count: created, skipped };
  });
});
