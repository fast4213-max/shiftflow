// 利用者の勤務用・休日用カレンダーへの登録・削除。
// カレンダーIDは必ず user_settings から読む(リクエスト本文の値は使わない)。

import { addDays, daysInMonth, dateKey } from "./plan.js";
import type { Context } from "./auth.ts";
import { AppError } from "./http.ts";
import { APP_TAG, calendarAccessError, deleteEvent, insertAllDayEvent, listEvents, runPool } from "./google.ts";

// holiday は空でもよい(休日用のカレンダーを使わない人。種別が「休日」の予定は登録しない)
export type Calendars = { work: string; holiday: string; officeId?: number | null; splitDayEvents?: boolean };

const CONCURRENCY = 4;

export async function loadVerifiedCalendars(ctx: Context): Promise<Calendars> {
  const { data, error } = await ctx.db
    .from("user_settings")
    .select("work_calendar_id, holiday_calendar_id, verified_at, office_id, split_day_events")
    .eq("user_id", ctx.userId)
    .maybeSingle();
  if (error) throw error;
  if (!data || !data.work_calendar_id) {
    throw new AppError(400, "設定画面でカレンダーIDを登録してください。", "not_configured");
  }
  if (!data.verified_at) {
    throw new AppError(400, "設定画面で「接続テスト」を行ってください。", "not_verified");
  }
  return { work: data.work_calendar_id, holiday: data.holiday_calendar_id, officeId: data.office_id, splitDayEvents: !!data.split_day_events };
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

// このアプリが作った予定(印の付いた終日予定)
export type AppEvent = { calendarId: string; eventId: string; date: string; tag: string };

// 対象月と翌月1日・2日の、このアプリが作った予定の一覧。手で入れた予定(印が無いもの)は含めない
// (翌月2日は、翌月1日が非番になって、翌月2日が非番でなくなったときに、残った非番を消すため)
export async function listAppEvents(calendars: Calendars, year: number, month: number): Promise<AppEvent[]> {
  const first = dateKey(year, month, 1);
  const nextSecond = addDays(dateKey(year, month, daysInMonth(year, month)), 2);

  const found: AppEvent[] = [];
  for (const calendarId of new Set([calendars.work, calendars.holiday].filter(Boolean))) {
    let items;
    try {
      // カレンダーのタイムゾーンに左右されないよう前後1日広めに取り、終日予定の日付で絞る
      items = await listEvents(
        calendarId,
        `${addDays(first, -1)}T00:00:00+09:00`,
        `${addDays(nextSecond, 2)}T00:00:00+09:00`,
      );
    } catch (err) {
      throw calendarAccessError(err, label(calendars, calendarId));
    }
    for (const ev of items) {
      const tag = ev.extendedProperties?.private?.[APP_TAG];
      const date = ev.start?.date;
      if (!tag || !date || date < first || date > nextSecond) continue;
      found.push({ calendarId, eventId: ev.id, date, tag });
    }
  }
  return found;
}

// 対象月の、このアプリが作った予定を削除して件数を返す。
// 翌月1日は、この月の月末の泊から作られる非番(勤務用カレンダーの offduty)だけを対象にする。
// clearNextFirst のとき(翌月1日の予定も作り直すとき)は、翌月1日のアプリの予定を全部消す
// (翌月を先に登録していた場合の、1日の勤務・休日の予定と重ならないように)。
// clearNextSecondOffduty のとき(翌月1日が非番になるとき)は、翌月2日の非番も消す。翌月1日が非番なら
// 翌月2日は非番にならないので、翌月1日が泊だったときに翌月の登録で作った非番が残らないように。
// 手で入れた予定(印が無いもの)は消さない。existing に listAppEvents の結果を渡すと、読み直さずにそれを使う。
export async function deleteAppEvents(
  calendars: Calendars,
  year: number,
  month: number,
  { clearNextFirst = false, clearNextSecondOffduty = false, existing }: {
    clearNextFirst?: boolean;
    clearNextSecondOffduty?: boolean;
    existing?: AppEvent[];
  } = {},
): Promise<number> {
  const nextFirst = addDays(dateKey(year, month, daysInMonth(year, month)), 1);
  const nextSecond = addDays(nextFirst, 1);
  const events = existing ?? await listAppEvents(calendars, year, month);
  const isOffduty = (e: AppEvent) => e.calendarId === calendars.work && e.tag === "offduty";
  const targets = events.filter((e) =>
    e.date < nextFirst ||
    (e.date === nextFirst && (clearNextFirst || isOffduty(e))) ||
    (e.date === nextSecond && clearNextSecondOffduty && isOffduty(e))
  );

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
  // 番号の予定のあとに続けて作る、時間の予定(出勤を終日2件に分ける設定のとき)
  second?: { title: string; description: string };
};

// 同じ日の2件(番号・時間)を、作った順(番号が先)にカレンダーで並べるための待ち時間。
// Googleは作成時刻を秒単位で見ているらしく、ほぼ同時に作った2件は並びが決まらない(逆になることがある)ので、
// 番号を全部作ってから、この時間をおいて時間の予定を作る(同じ日の2件は数秒以上あく)
const SECOND_EVENT_DELAY_MS = 2000;

// 予定を作る。休日用のカレンダーが無い人の「休日」の予定は作らない(skipped に数える)
export async function createEvents(
  calendars: Calendars,
  events: PlannedEvent[],
): Promise<{ created: number; skipped: number }> {
  const targets = events.filter((e) => e.calendar !== "holiday" || calendars.holiday);
  const insert = async (e: PlannedEvent, title: string, description: string) => {
    const calendarId = e.calendar === "holiday" ? calendars.holiday : calendars.work;
    try {
      await insertAllDayEvent(calendarId, {
        date: e.date,
        endDate: addDays(e.date, 1),
        title,
        description,
        kind: e.kind,
      });
    } catch (err) {
      throw calendarAccessError(err, label(calendars, calendarId));
    }
  };
  await runPool(targets, CONCURRENCY, (e) => insert(e, e.title, e.description));
  const seconds = targets.filter((e) => e.second);
  if (seconds.length) {
    await new Promise((r) => setTimeout(r, SECOND_EVENT_DELAY_MS));
    await runPool(seconds, CONCURRENCY, (e) => insert(e, e.second!.title, e.second!.description));
  }
  return { created: targets.length, skipped: events.length - targets.length };
}

// 登録する予定を決める。翌月1日の非番(月末が泊)は必ず作る。
// 翌月1日の記録の予定(月末が泊でないとき)は、翌月1日にアプリの予定があるときだけ作り直す
// (泊から戻したときに翌月1日が空にならないように。ただし翌月をリセットした人の翌月1日に、勝手に予定を作らない)。
export function eventsToRegister(planned: PlannedEvent[], existing: AppEvent[], nextFirst: string): PlannedEvent[] {
  const nextFirstHasApp = existing.some((e) => e.date === nextFirst);
  return planned.filter((e) => e.date !== nextFirst || e.kind === "offduty" || nextFirstHasApp);
}

// 月末の泊が変わって翌月1日の非番が変わるときに、消す翌月の記録(月の中で泊を入れ直したときの画面の動きと同じにする)。
//   翌月1日が非番になる: 翌月1日の番号(とそのメモ)を消す。残すと、あとで月末を泊から戻したとき、消えたはずの番号が戻る。
//     その番号が泊なら翌月2日は非番でなくなるので、翌月2日の非番のために書き換えたメモ(番号の無い記録)も消す
//   翌月1日が非番でなくなる(月末を泊から戻した・月をリセットした): 翌月1日の非番のために書き換えたメモ(番号の無い記録)を消す
// lastCode は登録(リセット)する前の月末の番号。memoOnly の記録は、番号の無いものだけを消す
export function staleNextMonthRecords(
  { nextFirst, lastCode, nextFirstOffduty, nextFirstCode, master }: {
    nextFirst: string;
    lastCode: string;
    nextFirstOffduty: boolean;
    nextFirstCode: string;
    master: Record<string, any>; // indexMaster() の結果
  },
): { date: string; memoOnly: boolean }[] {
  if (nextFirstOffduty) {
    if (!nextFirstCode) return [];
    const stale = [{ date: nextFirst, memoOnly: false }];
    if (master[nextFirstCode]?.type === "泊") stale.push({ date: addDays(nextFirst, 1), memoOnly: true });
    return stale;
  }
  return master[lastCode]?.type === "泊" ? [{ date: nextFirst, memoOnly: true }] : [];
}

// staleNextMonthRecords の記録を消す(利用者の権限で消すので、本人の記録だけが対象)
export async function deleteRecords(ctx: Context, records: { date: string; memoOnly: boolean }[]): Promise<void> {
  for (const r of records) {
    let query = ctx.db.from("shift_records").delete().eq("date", r.date);
    if (r.memoOnly) query = query.eq("code", "");
    const { error } = await query;
    if (error) throw error;
  }
}

// 出勤を終日2件に分ける設定のとき、勤務用の出勤(日勤・泊)の予定に、時間の予定を付ける。
// 1件目=番号(メモは今のまま)、2件目=時間(メモの1行目。例「10:15〜19:02」)。非番・休日・手入力は変えない。
export function splitDayEvents(events: PlannedEvent[], master: Record<string, any>): PlannedEvent[] {
  return events.map((e) => {
    if (e.calendar !== "work" || e.kind !== "day") return e;
    const type = master[e.title]?.type;
    if (type !== "日勤" && type !== "泊") return e;
    const time = e.description.split("\n")[0].trim();
    return time ? { ...e, second: { title: time, description: "" } } : e;
  });
}
