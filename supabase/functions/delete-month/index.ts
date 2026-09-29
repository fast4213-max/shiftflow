// 指定月に、このアプリで登録した予定だけをカレンダーから削除する。
// 入力内容(shift_records)と、手で入れた予定は消さない。月末が泊なら翌月1日の非番も消す。

import { requireMember } from "../_shared/auth.ts";
import { readBody, serve, yearMonthOf } from "../_shared/http.ts";
import { deleteAppEvents, loadVerifiedCalendars, withUserLock } from "../_shared/shift-calendar.ts";

serve(async (req) => {
  const ctx = await requireMember(req);
  const { year, month } = yearMonthOf(await readBody(req));
  const calendars = await loadVerifiedCalendars(ctx);
  const count = await withUserLock(ctx, () => deleteAppEvents(calendars, year, month));
  return { count };
});
