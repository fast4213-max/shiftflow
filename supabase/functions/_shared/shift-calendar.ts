// 利用者の勤務用・休日用カレンダーへの登録・削除。
// カレンダーIDは必ず user_settings から読む(リクエスト本文の値は使わない)。

import { addDays, daysInMonth, dateKey } from "./plan.js";
import type { Context } from "./auth.ts";
import { AppError } from "./http.ts";
import { APP_TAG, calendarAccessError, deleteEvent, insertAllDayEvent, insertTimedEvent, listEvents, runPool } from "./google.ts";

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
        { timeZone: "Asia/Tokyo" },
      );
    } catch (err) {
      throw calendarAccessError(err, label(calendars, calendarId));
    }
    for (const ev of items) {
      const tag = ev.extendedProperties?.private?.[APP_TAG];
      // 終日の予定はその日付、時間つきの予定(出勤を2件で登録したときの2件目)は日本時間の日付
      const date = ev.start?.date || ev.start?.dateTime?.slice(0, 10);
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
  // (時間つき。startMin / endMin はその日の0時からの分)
  second?: { title: string; description: string; startMin: number; endMin: number };
};

// 予定を作る。休日用のカレンダーが無い人の「休日」の予定は作らない(skipped に数える)。
// created は作った予定の数(出勤を2件で登録する人の時間の予定も数える。リセットで消した件数と合うように)
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
  await runPool(targets, CONCURRENCY, async (e) => {
    await insert(e, e.title, e.description);
    if (e.second) {
      try {
        await insertTimedEvent(calendars.work, {
          date: e.date,
          startMin: e.second.startMin,
          endMin: e.second.endMin,
          title: e.second.title,
          description: e.second.description,
          kind: e.kind,
        });
      } catch (err) {
        throw calendarAccessError(err, label(calendars, calendars.work));
      }
    }
  });
  const seconds = targets.filter((e) => e.second).length;
  return { created: targets.length + seconds, skipped: events.length - targets.length };
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

// 出勤を2件に分ける設定のとき、勤務用の出勤(日勤・泊)の予定に、出勤時間の予定(時間つき)を付ける。
// 1件目=終日で、タイトルは番号・メモは今のまま(時間)。2件目=出勤時間から始まる時間つきの予定(タイトルはメモの1行目。例「10:15〜19:02」)。
// 終日の予定は時間つきの予定より上に出るので、番号が上・時間が下に並ぶ。
// 日勤は退勤まで、泊は出勤から1時間(泊の翌日は、終日の非番にメモで退勤時間が入る)。
// 非番・休日・手入力、メモの1行目が時間でないもの(手で書き換えたとき)は、1件のまま
export const SECOND_EVENT_MINUTES = 60;

// メモの1行目の時間(「10:15〜19:02」「9:01」)を、その日の0時からの分にする。時間として読めなければ null。
// 手で書き換えたメモも読めるよう、全角の数字・コロン、「～」「~」「-」「ー」、間の空白も受け付ける
// (スマホや PC の日本語入力では、「〜」が全角の「～」に、「-」が「ー」になることが多い)。
// 出勤が24時以降(25:00 など)は読まない。翌日の時間の予定になり、月末だと翌月1日に入って、
// 登録し直しても消えずに増えていくため(その日は1件のまま)。退勤の分が読めなければ、出勤だけとみなす
export function parseTimeRange(text: string): { start: number; end: number | null } | null {
  const s = text
    .replace(/[０-９：]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[〜～~\-－−ー]/g, "〜")
    .replace(/\s+/g, "");
  const m = s.match(/^(\d{1,2}):(\d{2})(?:〜(?:(\d{1,2}):(\d{2}))?)?$/);
  if (!m) return null;
  const [sh, sm] = [Number(m[1]), Number(m[2])];
  if (sh > 23 || sm > 59) return null;
  const start = sh * 60 + sm;
  if (m[3] === undefined) return { start, end: null };
  const [eh, em] = [Number(m[3]), Number(m[4])];
  return { start, end: eh > 47 || em > 59 ? null : eh * 60 + em };
}

export function splitDayEvents(events: PlannedEvent[], master: Record<string, any>): PlannedEvent[] {
  return events.map((e) => {
    if (e.calendar !== "work" || e.kind !== "day") return e;
    const type = master[e.title]?.type;
    if (type !== "日勤" && type !== "泊") return e;
    const time = e.description.split("\n")[0].trim();
    const range = parseTimeRange(time);
    if (!range) return e;
    const startMin = range.start;
    let endMin = range.end === null || type === "泊" ? startMin + SECOND_EVENT_MINUTES : range.end;
    if (endMin <= startMin) endMin = startMin + SECOND_EVENT_MINUTES;
    return { ...e, second: { title: time, description: "", startMin, endMin } };
  });
}
