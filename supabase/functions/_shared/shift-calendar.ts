// 利用者の勤務用・休日用カレンダーへの登録・削除。
// カレンダーIDは必ず user_settings から読む(リクエスト本文の値は使わない)。

import { addDays, daysInMonth, dateKey } from "./plan.js";
import type { Context } from "./auth.ts";
import { AppError } from "./http.ts";
import { APP_TAG, calendarAccessError, deleteEvent, insertAllDayEvent, listEvents, runPool } from "./google.ts";

export type Calendars = { work: string; holiday: string };

const CONCURRENCY = 4;

export async function loadVerifiedCalendars(ctx: Context): Promise<Calendars> {
  const { data, error } = await ctx.db
    .from("user_settings")
    .select("work_calendar_id, holiday_calendar_id, verified_at")
    .eq("user_id", ctx.userId)
    .maybeSingle();
  if (error) throw error;
  if (!data || !data.work_calendar_id || !data.holiday_calendar_id) {
    throw new AppError(400, "設定画面でカレンダーIDを登録してください。", "not_configured");
  }
  if (!data.verified_at) {
    throw new AppError(400, "設定画面で「接続テスト」を行ってください。", "not_verified");
  }
  return { work: data.work_calendar_id, holiday: data.holiday_calendar_id };
}

// 二重実行防止のロックを取って fn を実行する
export async function withUserLock<T>(ctx: Context, fn: () => Promise<T>): Promise<T> {
  const { data, error } = await ctx.admin.rpc("acquire_user_lock", { p_user_id: ctx.userId, p_seconds: 150 });
  if (error) throw error;
  if (!data) {
    throw new AppError(409, "登録または削除を実行中です。少し待ってからもう一度お試しください。", "busy");
  }
  try {
    return await fn();
  } finally {
    await ctx.admin.rpc("release_user_lock", { p_user_id: ctx.userId });
  }
}

function label(calendars: Calendars, id: string): string {
  if (calendars.work === id && calendars.holiday === id) return "カレンダー";
  return calendars.work === id ? "勤務用カレンダー" : "休日用カレンダー";
}

// 対象月の、このアプリが作った予定を削除して件数を返す。
// 翌月1日は、この月の月末の泊から作られる非番(勤務用カレンダーの offduty)だけを対象にする。
// 手で入れた予定(印が無いもの)は消さない。
export async function deleteAppEvents(calendars: Calendars, year: number, month: number): Promise<number> {
  const first = dateKey(year, month, 1);
  const nextFirst = addDays(dateKey(year, month, daysInMonth(year, month)), 1);

  const targets: { calendarId: string; eventId: string }[] = [];
  for (const calendarId of new Set([calendars.work, calendars.holiday])) {
    let items;
    try {
      // カレンダーのタイムゾーンに左右されないよう前後1日広めに取り、終日予定の日付で絞る
      items = await listEvents(
        calendarId,
        `${addDays(first, -1)}T00:00:00+09:00`,
        `${addDays(nextFirst, 2)}T00:00:00+09:00`,
      );
    } catch (err) {
      throw calendarAccessError(err, label(calendars, calendarId));
    }
    for (const ev of items) {
      const tag = ev.extendedProperties?.private?.[APP_TAG];
      const date = ev.start?.date;
      if (!tag || !date) continue;
      const inMonth = date >= first && date < nextFirst;
      const nextOffduty = calendarId === calendars.work && date === nextFirst && tag === "offduty";
      if (inMonth || nextOffduty) targets.push({ calendarId, eventId: ev.id });
    }
  }

  await runPool(targets, CONCURRENCY, async (t) => {
    try {
      await deleteEvent(t.calendarId, t.eventId);
    } catch (err) {
      throw calendarAccessError(err, label(calendars, t.calendarId));
    }
  });
  return targets.length;
}

export type PlannedEvent = {
  date: string;
  calendar: string; // "work" | "holiday"
  kind: string;
  title: string;
  description: string;
};

export async function createEvents(calendars: Calendars, events: PlannedEvent[]): Promise<number> {
  await runPool(events, CONCURRENCY, async (e) => {
    const calendarId = e.calendar === "holiday" ? calendars.holiday : calendars.work;
    try {
      await insertAllDayEvent(calendarId, {
        date: e.date,
        endDate: addDays(e.date, 1),
        title: e.title,
        description: e.description,
        kind: e.kind,
      });
    } catch (err) {
      throw calendarAccessError(err, label(calendars, calendarId));
    }
  });
  return events.length;
}
