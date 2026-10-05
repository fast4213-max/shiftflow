// 接続テスト: 登録済みの勤務用・休日用カレンダーにテスト予定を書いて即削除する。
// 両方とも書ければ検証済みにする。カレンダーIDは user_settings から読む(本文は見ない)。

import { requireMember } from "../_shared/auth.ts";
import { calendarAccessError, clearsVerification, deleteEvent, insertAllDayEvent } from "../_shared/google.ts";
import { AppError, serve } from "../_shared/http.ts";
import { addDays } from "../_shared/plan.js";

// メインのカレンダーのID(メールアドレスの形。"xxx@group.calendar.google.com" などの追加カレンダーではないもの)
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
  // 休日用は空でもよい(休日用のカレンダーを使わない人。その場合、種別が「休日」の予定は登録しない)
  if (!work) {
    throw new AppError(400, "勤務用のカレンダーIDを入力して保存してください。", "not_configured");
  }

  // メインのカレンダー(ID=メールアドレス)は使えない。社員番号のログインでは本人のものか確かめられないため、
  // このアプリ用に新しく作ったカレンダーを使ってもらう
  for (const [id, name] of [[work, "勤務用"], [holiday, "休日用"]]) {
    if (id && isPrimaryCalendarId(id)) {
      throw new AppError(
        400,
        `${name}カレンダーIDがメールアドレスの形です。メインのカレンダーは使えません。このアプリ用に新しく作ったカレンダーのIDを入れてください。`,
        "primary_calendar",
      );
    }
  }

  // 他の利用者が検証済みで使っているカレンダーは使えない
  const ids = [...new Set([work, holiday].filter(Boolean))];
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
    throw new AppError(400, "このカレンダーIDは他の利用者が登録しています。自分のカレンダーのIDか確認してください。", "taken");
  }

  // 日本時間の今日に終日のテスト予定を書いて、すぐ消す
  const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const testTargets = new Map([[work, "勤務用カレンダー"]]);
  if (holiday && !testTargets.has(holiday)) testTargets.set(holiday, "休日用カレンダー");
  for (const [id, name] of testTargets) {
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
      const failure = calendarAccessError(err, label);
      // 書けなくなったカレンダー(共有を外したなど)は、検証済みも外す(設定画面で「テスト済み」と出続けないように)。
      // 混雑・障害のときは、カレンダーの状態は分からないので外さない
      if (clearsVerification(failure)) {
        await ctx.admin.from("user_settings").update({ verified_at: null }).eq("user_id", ctx.userId);
      }
      throw failure;
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
