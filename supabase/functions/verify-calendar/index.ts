// 接続テスト: 登録済みの勤務用・休日用カレンダーにテスト予定を書いて即削除する。
// 両方とも書ければ検証済みにする。カレンダーIDは user_settings から読む(本文は見ない)。

import { requireMember } from "../_shared/auth.ts";
import { calendarAccessError, deleteEvent, insertAllDayEvent } from "../_shared/google.ts";
import { AppError, serve } from "../_shared/http.ts";
import { addDays } from "../_shared/plan.js";

// "xxx@group.calendar.google.com" などの追加カレンダーではなく、メールアドレス形式のID(メインのカレンダー)か
function isPrimaryCalendarId(id: string): boolean {
  return id.includes("@") && !/\.calendar\.google\.com$/i.test(id);
}

serve(async (req) => {
  const ctx = await requireMember(req);

  const { data: settings, error } = await ctx.db
    .from("user_settings")
    .select("work_calendar_id, holiday_calendar_id")
    .eq("user_id", ctx.userId)
    .maybeSingle();
  if (error) throw error;
  const work = settings?.work_calendar_id || "";
  const holiday = settings?.holiday_calendar_id || "";
  if (!work || !holiday) {
    throw new AppError(400, "勤務用と休日用のカレンダーIDを入力して保存してください。", "not_configured");
  }

  // メインのカレンダー(ID=メールアドレス)は、ログイン中の本人のものだけ使える
  for (const [id, name] of [[work, "勤務用"], [holiday, "休日用"]]) {
    if (isPrimaryCalendarId(id) && id.toLowerCase() !== ctx.email) {
      throw new AppError(
        400,
        `${name}カレンダーIDがメールアドレスの形です。自分以外のメインのカレンダーは使えません。新しく作ったカレンダーのIDを使ってください。`,
        "foreign_primary",
      );
    }
  }

  // ほかの利用者が検証済みで使っているカレンダーは使えない
  const ids = [...new Set([work, holiday])];
  let taken = false;
  for (const column of ["work_calendar_id", "holiday_calendar_id"]) {
    const { data: others, error: othersError } = await ctx.admin
      .from("user_settings")
      .select("user_id")
      .neq("user_id", ctx.userId)
      .not("verified_at", "is", null)
      .in(column, ids)
      .limit(1);
    if (othersError) throw othersError;
    if (others && others.length > 0) taken = true;
  }
  if (taken) {
    throw new AppError(400, "このカレンダーIDはほかの利用者が登録しています。自分のカレンダーのIDか確認してください。", "taken");
  }

  // 日本時間の今日に終日のテスト予定を書いて、すぐ消す
  const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  for (const [id, name] of new Map([[work, "勤務用カレンダー"], [holiday, "休日用カレンダー"]])) {
    const label = work === holiday ? "カレンダー" : name;
    try {
      const ev = await insertAllDayEvent(id, {
        date: today,
        endDate: addDays(today, 1),
        title: "shiftflow 接続テスト(すぐ消えます)",
        kind: "test",
      });
      await deleteEvent(id, ev.id);
    } catch (err) {
      throw calendarAccessError(err, label);
    }
  }

  const { error: updateError } = await ctx.admin
    .from("user_settings")
    .update({ verified_at: new Date().toISOString() })
    .eq("user_id", ctx.userId)
    .eq("work_calendar_id", work)
    .eq("holiday_calendar_id", holiday);
  if (updateError) throw updateError;

  return { ok: true };
});
