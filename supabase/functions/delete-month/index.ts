// 指定月に、このアプリで登録した予定だけをカレンダーから削除し、その月の入力内容(shift_records)も消す。
// 手で入れた予定は消さない。月末が泊なら翌月1日の非番も消す。

import { requireMember } from "../_shared/auth.ts";
import { readBody, serve, yearMonthOf } from "../_shared/http.ts";
import { deleteAppEvents, loadVerifiedCalendars, withUserLock } from "../_shared/shift-calendar.ts";

serve(async (req) => {
  const ctx = await requireMember(req);
  const { year, month } = yearMonthOf(await readBody(req));
  const calendars = await loadVerifiedCalendars(ctx);
  const count = await withUserLock(ctx, async () => {
    const n = await deleteAppEvents(calendars, year, month);
    // 入力内容も消す(空の入力で1か月分を入れ替える)。画面を開き直しても残らないように
    const saved = await ctx.db.rpc("save_month_records", { p_year: year, p_month: month, p_entries: {} });
    if (saved.error) throw saved.error;
    return n;
  });
  return { count };
});
