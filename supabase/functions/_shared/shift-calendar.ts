// 利用者の勤務用・休日用・非番の時間用カレンダーへの登録・削除。
// カレンダーIDは必ず user_settings から読む(リクエスト本文の値は使わない)。

import { addDays, daysInMonth, dateKey, MasterSet, masterOn } from "./plan.js";
import type { Context } from "./auth.ts";
import { AppError } from "./http.ts";
import { APP_TAG, calendarAccessError, deleteEvent, insertAllDayEvent, insertTimedEvent, listEvents, runPool, withRetryBudget } from "./google.ts";

// holiday は空でもよい(休日用のカレンダーを使わない人。種別が「休日」の予定は登録しない)
// offduty は空でもよい(非番を2件で登録するときの時間の予定を入れるカレンダー。空なら勤務用に入れる)
export type Calendars = {
  work: string;
  holiday: string;
  offduty?: string;
  officeId?: number | null;
  splitDayEvents?: boolean;
  splitOffdutyEvents?: boolean;
  titleDayTime?: boolean;
  titleOffdutyTime?: boolean;
  timedEvents?: boolean;
};

// 非番の時間の予定を入れるカレンダー(非番用が空なら勤務用)
export function offdutyCalendarOf(calendars: Calendars): string {
  return calendars.offduty || calendars.work;
}

const CONCURRENCY = 4;

// 登録・削除の全体で、Google の混雑の待ちを含めて収める時間。ロックの150秒より短くする
const WORK_BUDGET_MS = 120_000;

export async function loadVerifiedCalendars(ctx: Context): Promise<Calendars> {
  const { data, error } = await ctx.db
    .from("user_settings")
    .select("work_calendar_id, holiday_calendar_id, offduty_calendar_id, verified_at, office_id, split_day_events, split_offduty_events, title_day_time, title_offduty_time, timed_events")
    .eq("user_id", ctx.userId)
    .maybeSingle();
  if (error) throw error;
  if (!data || !data.work_calendar_id) {
    throw new AppError(400, "設定画面でカレンダーIDを登録してください。", "not_configured");
  }
  if (!data.verified_at) {
    throw new AppError(400, "設定画面で「接続テスト」を行ってください。", "not_verified");
  }
  return {
    work: data.work_calendar_id,
    holiday: data.holiday_calendar_id,
    offduty: data.offduty_calendar_id || "",
    officeId: data.office_id,
    splitDayEvents: !!data.split_day_events,
    splitOffdutyEvents: !!data.split_offduty_events,
    titleDayTime: !!data.title_day_time,
    titleOffdutyTime: !!data.title_offduty_time,
    timedEvents: !!data.timed_events,
  };
}

// 二重実行防止のロックを取って fn を実行する
export async function withUserLock<T>(ctx: Context, fn: () => Promise<T>): Promise<T> {
  const { data, error } = await ctx.admin.rpc("acquire_user_lock", { p_user_id: ctx.userId, p_seconds: 150 });
  if (error) throw error;
  if (!data) {
    throw new AppError(409, "登録または削除を実行中です。少し待ってからもう一度お試しください。", "busy");
  }
  try {
    return await withRetryBudget(WORK_BUDGET_MS, fn);
  } finally {
    await ctx.admin.rpc("release_user_lock", { p_user_id: ctx.userId });
  }
}

// エラーに出すカレンダーの名前。同じIDを2つ以上の用途に使っているときは「カレンダー」
function label(calendars: Calendars, id: string): string {
  const names = [
    calendars.work === id && "勤務用",
    calendars.holiday === id && "休日用",
    calendars.offduty === id && "非番の時間用",
  ].filter(Boolean);
  return names.length === 1 ? `${names[0]}カレンダー` : "カレンダー";
}

// このアプリが作った予定(印の付いた終日予定)
// carried: 前の月から対象月の1日にまたがる、時間つきの予定(時間つきで登録した月末の泊)。
// 対象月の予定ではないので、削除の対象にはしない。対象月の1日の「〜」を作るかどうかを決めるためだけに使う(Z1)
export type AppEvent = { calendarId: string; eventId: string; date: string; tag: string; carried?: boolean; timed?: boolean };

// 対象月と翌月1日・2日の、このアプリが作った予定の一覧。手で入れた予定(印が無いもの)は含めない
// (翌月2日は、翌月1日が非番になって、翌月2日が非番でなくなったときに、残った非番を消すため)
export async function listAppEvents(calendars: Calendars, year: number, month: number): Promise<AppEvent[]> {
  const first = dateKey(year, month, 1);
  const nextSecond = addDays(dateKey(year, month, daysInMonth(year, month)), 2);

  const found: AppEvent[] = [];
  for (const calendarId of new Set([calendars.work, calendars.holiday, calendars.offduty || ""].filter(Boolean))) {
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
      if (!tag || !date || date > nextSecond) continue;
      if (date < first) {
        const end = ev.end?.dateTime;
        if (ev.start?.dateTime && end && Date.parse(end) > Date.parse(`${first}T00:00:00+09:00`)) {
          found.push({ calendarId, eventId: ev.id, date, tag, carried: true });
        }
        continue;
      }
      found.push({ calendarId, eventId: ev.id, date, tag, ...(ev.start?.dateTime ? { timed: true } : {}) });
    }
  }
  return found;
}

// 対象月の、このアプリが作った予定を削除して件数を返す。
// 翌月1日は、この月の月末の泊から作られる非番(勤務用・非番の時間用カレンダーの offduty)だけを対象にする。
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
  // 非番の時間の予定(非番を2件で登録したときの2件目)は、非番の時間用カレンダーにある
  const isOffduty = (e: AppEvent) =>
    e.tag === "offduty" && (e.calendarId === calendars.work || e.calendarId === offdutyCalendarOf(calendars));
  const targets = events.filter((e) => !e.carried).filter((e) =>
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
  // 番号の予定のあとに続けて作る、時間の予定(出勤・非番を2件に分ける設定のとき)
  // (時間つき。startMin / endMin はその日の0時からの分。calendar が "offduty" なら非番の時間用カレンダー、ほかは勤務用)
  second?: { title: string; description: string; startMin: number; endMin: number; calendar?: "work" | "offduty" };
  // 終日ではなく時間つきで作るとき(勤務を時間つきの予定で登録する設定。startMin / endMin は date の0時からの分。翌日にまたがってよい)
  timed?: { startMin: number; endMin: number };
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
      if (e.timed) {
        await insertTimedEvent(calendarId, { date: e.date, ...e.timed, title, description, kind: e.kind });
        return;
      }
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
      const secondId = e.second.calendar === "offduty" ? offdutyCalendarOf(calendars) : calendars.work;
      try {
        await insertTimedEvent(secondId, {
          date: e.date,
          startMin: e.second.startMin,
          endMin: e.second.endMin,
          title: e.second.title,
          description: e.second.description,
          kind: e.kind,
        });
      } catch (err) {
        throw calendarAccessError(err, label(calendars, secondId));
      }
    }
  });
  const seconds = targets.filter((e) => e.second).length;
  return { created: targets.length + seconds, skipped: events.length - targets.length };
}

// 登録する予定を決める。翌月1日の非番(月末が泊)は必ず作る。
// 翌月1日の記録の予定(月末が泊でないとき)は、翌月1日にアプリの予定があるときだけ作り直す
// (泊から戻したときに翌月1日が空にならないように。ただし翌月をリセットした人の翌月1日に、勝手に予定を作らない)。
// retryNextFirst: 前の登録が途中で失敗して、翌月1日のアプリの予定を消したまま(作り直せていない)とき。
// このときは、翌月1日にアプリの予定が残っていなくても作り直す(user_settings.next_first_pending の印。register-month が読む)
export function eventsToRegister(
  planned: PlannedEvent[],
  existing: AppEvent[],
  nextFirst: string,
  retryNextFirst = false,
): PlannedEvent[] {
  const nextFirstHasApp = retryNextFirst || existing.some((e) => e.date === nextFirst);
  return planned.filter((e) => e.date !== nextFirst || e.kind === "offduty" || nextFirstHasApp);
}

// 月末の泊が変わって翌月1日の非番が変わるときに、消す翌月の記録(月の中で泊を入れ直したときの画面の動きと同じにする)。
//   翌月1日が非番になる: 翌月1日の番号(とそのメモ)を消す。残すと、あとで月末を泊から戻したとき、消えたはずの番号が戻る。
//     その番号が泊なら翌月2日は非番でなくなるので、翌月2日の非番のために書き換えたメモ(番号の無い記録)も消す
//   翌月1日が非番でなくなる(月末を泊から戻した・月をリセットした): 翌月1日の非番のために書き換えたメモ(番号の無い記録)を消す
//     月末が今回はじめて泊になった(newlyOffduty)なら、番号の無い翌月1日のメモも消す(W6。画面が、新しく非番になった日のメモを消すのと同じ)。
//     前から泊だった(利用者が非番のメモを手で書いた)ときは残す
// lastCode は登録(リセット)する前の月末の番号。memoOnly の記録は、番号の無いものだけを消す
// 時間つきの設定で、翌月1日に時間つきのアプリの予定が(翌月の登録で)すでにあるか(R1)。あるときは、この月の登録で翌月1日を作り直さない。
// 翌月1日の泊の1件は、翌月2日の退勤時間と組になっているので、この月の登録だけでは作り直せず、終日の泊に戻ってしまうため。
// 翌月1日が非番になるとき(この月の月末が泊)は、今までどおり作り直す。
// 前の登録が途中で止まったあとの登録し直しでも残す: 翌月1日の時間つきの予定は、翌月の登録か、前回の途中までの自分の登録で作ったもので、
// どちらでも中身は同じ。作り直すと終日の泊に戻り、翌月2日の退勤時間が消えてしまう(R1・AA12)
export function shouldKeepTimedNextFirst(
  { timedEvents, nextFirstOffduty, existing, nextFirst }: {
    timedEvents: boolean;
    nextFirstOffduty: boolean;
    existing: AppEvent[];
    nextFirst: string;
  },
): boolean {
  return timedEvents && !nextFirstOffduty && existing.some((e) => e.date === nextFirst && !!e.timed);
}

export function staleNextMonthRecords(
  { nextFirst, lastCode, nextFirstOffduty, nextFirstCode, master, newlyOffduty = false }: {
    nextFirst: string;
    lastCode: string;
    nextFirstOffduty: boolean;
    nextFirstCode: string;
    newlyOffduty?: boolean;
    master: Record<string, any>; // indexMaster() の結果、または MasterSet(日ごとのマスタ)
  },
): { date: string; memoOnly: boolean }[] {
  if (nextFirstOffduty) {
    if (!nextFirstCode) return newlyOffduty ? [{ date: nextFirst, memoOnly: true }] : [];
    const stale = [{ date: nextFirst, memoOnly: false }];
    if (masterOn(master, nextFirst)[nextFirstCode]?.type === "泊") stale.push({ date: addDays(nextFirst, 1), memoOnly: true });
    return stale;
  }
  return masterOn(master, addDays(nextFirst, -1))[lastCode]?.type === "泊" ? [{ date: nextFirst, memoOnly: true }] : [];
}

// 翌月1日が今回はじめて非番になったか(登録する前の月末が泊でなく、今回の月末が泊)。
// そのとき翌月1日の番号の無いメモは、非番のメモに使わない(W6)
export function nextFirstNewlyOffduty(
  { last, lastCode, nextFirstOffduty, master }: { last: string; lastCode: string; nextFirstOffduty: boolean; master: Record<string, any> },
): boolean {
  return nextFirstOffduty && masterOn(master, last)[lastCode]?.type !== "泊";
}

// 区所のマスタを、切替日(ダイヤ改正・ダイヤ修正)ごとに読む。日ごとに、その日のマスタを引ける(MasterSet)
export async function loadMasterSet(ctx: Context, officeId: number): Promise<MasterSet> {
  const [periodsRes, rowsRes] = await Promise.all([
    ctx.db.from("master_periods").select("id, starts_on, name").eq("office_id", officeId),
    ctx.db.from("shift_master").select("*").eq("office_id", officeId).order("sort_order"),
  ]);
  if (periodsRes.error) throw periodsRes.error;
  if (rowsRes.error) throw rowsRes.error;
  return new MasterSet(periodsRes.data || [], rowsRes.data || []);
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
// 非番・休日(手入力の「〜」「非番」「休」なども)、メモの1行目が時間でないもの(手で書き換えたとき)は、1件のまま
export const SECOND_EVENT_MINUTES = 60;

// メモの1行目の時間(「10:15〜19:02」「9:01」)を、その日の0時からの分にする。時間として読めなければ null。
// 手で書き換えたメモも読めるよう、全角の数字・コロン、「～」「~」「-」「ー」「―」「−」などの横棒、「→」「から」、間の空白も受け付ける
// (スマホや PC の日本語入力では、「〜」が全角の「～」に、「-」が「ー」になることが多い)。
// 出勤が24時以降(25:00 など)は読まない。翌日の時間の予定になり、月末だと翌月1日に入って、
// 登録し直しても消えずに増えていくため(その日は1件のまま)。退勤の分が読めなければ、出勤だけとみなす
export function parseTimeRange(text: string): { start: number; end: number | null } | null {
  const s = normalizeTimeText(text);
  const m = s.match(/^(\d{1,2}):(\d{2})(?:〜(?:(\d{1,2}):(\d{2}))?)?$/);
  if (!m) return null;
  const [sh, sm] = [Number(m[1]), Number(m[2])];
  if (sh > 23 || sm > 59) return null;
  const start = sh * 60 + sm;
  if (m[3] === undefined) return { start, end: null };
  const [eh, em] = [Number(m[3]), Number(m[4])];
  return { start, end: eh > 47 || em > 59 ? null : eh * 60 + em };
}

// 全角の数字・コロンを半角に、横棒・「から」などを「〜」にして、空白を取る(parseTimeRange・parseOffdutyTime で使う)
function normalizeTimeText(text: string): string {
  return text
    .replace(/[０-９：]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/から|[〜～~∼〰\-－−ー―—–‐‑‒─ｰ→⇒]/g, "〜")
    .replace(/\s+/g, "");
}

// 手入力の番号のうち、非番・休みを表すものは、メモに時間があっても分けない
// (泊の翌日に手で「〜」や「非番」と入れて、メモに退勤時間を書く使い方があるため)。
//   記号だけのもの(「〜」「-」「ー」「→」「・」など。文字も数字も無い)・「非」「明」だけのもの・「非番」「明け」「明番」を含むもの・
//   「休」を含むもの(公休・年休など)。ただし「休出」「休日出勤」「休日勤務」のように「出」「勤」も含むものは出勤なので分ける
//   (「明」は、明石・有明のような駅名の番号を非番にしないよう、それだけのときと「明け」「明番」だけを見る)
export function isOffTitle(title: string): boolean {
  const t = title.trim();
  return isOffdutyTitle(t) || (/休/.test(t) && !/[出勤]/.test(t));
}

// isOffTitle のうち、非番を表すもの(休みを表す「休」は含めない)。非番を2件で登録する設定で、手入力の非番に使う
export function isOffdutyTitle(title: string): boolean {
  const t = title.trim();
  if (!/[\p{L}\p{N}]/u.test(t.replace(/[ーｰ]/g, ""))) return true;
  return t === "非" || t === "明" || /非番|明け|明番/.test(t);
}

export function splitDayEvents(events: PlannedEvent[], master: Record<string, any>): PlannedEvent[] {
  return events.map((e) => {
    if (e.calendar !== "work" || e.kind !== "day") return e;
    // マスタにない番号(手入力)は日勤と同じ扱い(休日の番号は休日用カレンダーなので、上で外れる)
    const m = masterOn(master, e.date);
    if (!m[e.title] && isOffTitle(e.title)) return e;
    const type = m[e.title]?.type ?? "日勤";
    if (type !== "日勤" && type !== "泊") return e;
    const time = e.description.split("\n")[0].trim();
    const range = parseTimeRange(time);
    if (!range) return e;
    const startMin = range.start;
    let endMin = range.end === null || type === "泊" ? startMin + SECOND_EVENT_MINUTES : range.end;
    // 退勤が出勤より前の時刻(「22:00〜6:00」など日をまたぐもの)も1時間にする。わざと翌日まで伸ばさない
    // (時間の予定は時間を確かめるためのもので、翌日まで伸ばすと翌日の予定の並びが変わるため)
    if (endMin <= startMin) endMin = startMin + SECOND_EVENT_MINUTES;
    return { ...e, second: { title: time, description: "", startMin, endMin } };
  });
}

// 非番を2件に分ける設定のとき、非番の予定に、退勤時間の予定(時間つき)を付ける。
// 1件目=今までどおり勤務用の終日の「〜」(メモ=退勤時間)。2件目=退勤時間から1時間の時間つきの予定で、タイトルは時間だけ(例「9:02」)。
// 2件目は非番の時間用カレンダー(空なら勤務用)に入れる(色を変えたい人向け)。
// 対象は、自動の非番(泊の翌日)と、手入力の非番(マスタにない番号で「〜」「非番」「明け」など。「休」を含むものは休みなので除く)。
// メモの1行目が退勤時間として読めないもの(手で書き換えたとき・24時以降)は、1件のまま
export function splitOffdutyEvents(events: PlannedEvent[], master: Record<string, any>): PlannedEvent[] {
  return events.map((e) => {
    if (e.calendar !== "work" || e.second) return e;
    const manual = e.kind === "day" && !masterOn(master, e.date)[e.title] && isOffdutyTitle(e.title);
    if (e.kind !== "offduty" && !manual) return e;
    const end = parseOffdutyTime(e.description.split("\n")[0]);
    if (end === null) return e;
    return {
      ...e,
      second: { title: formatMinutes(end), description: "", startMin: end, endMin: end + SECOND_EVENT_MINUTES, calendar: "offduty" },
    };
  });
}

// 非番のメモの1行目の退勤時間(「9:02」「〜9:02」「8:30〜9:02」なら後ろ)を、その日の0時からの分にする。読めなければ null。
// 全角・「～」「-」なども parseTimeRange と同じに読む。24時以降は読まない(翌日の予定になるため)
export function parseOffdutyTime(text: string): number | null {
  const m = normalizeTimeText(text).match(/^〜?(?:\d{1,2}:\d{2}〜)?(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const [h, min] = [Number(m[1]), Number(m[2])];
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// タイトルに時間を付ける設定のとき、勤務用の終日の予定のタイトルの後ろに、メモの1行目の時間を半角の括弧で付ける。
//   出勤(day): 日勤・泊の番号に出勤時間(例「1(10:00)」。日勤も出勤時間だけ)。対象は splitDayEvents と同じ
//   非番(offduty): 自動の非番と手入力の非番に退勤時間(例「〜(9:00)」)。対象は splitOffdutyEvents と同じ
// メモは変えない。時間は「H:MM」にそろえる(全角で書いても半角)。時間として読めないメモの日は番号のまま。
// 時間のあとに言葉があっても(「10:00 早出」)、先頭の時間を読む(titleTimeOf)。
// 名前がもう「(10:00)」のような時間で終わっているとき(手入力で括弧まで書いた)は、二重にしない。
// 番号でマスタを引くので、splitDayEvents・splitOffdutyEvents のあとに通す(2件目の予定はそのまま)
export function addTimeToTitles(
  events: PlannedEvent[],
  master: Record<string, any>,
  { day = false, offduty = false }: { day?: boolean; offduty?: boolean },
): PlannedEvent[] {
  return events.map((e) => {
    if (e.calendar !== "work" || TITLE_TIME_END.test(e.title)) return e;
    const firstLine = e.description.split("\n")[0];
    const m = masterOn(master, e.date);
    const manual = e.kind === "day" && !m[e.title];
    let min: number | null = null;
    if (e.kind === "offduty" || (manual && isOffdutyTitle(e.title))) {
      if (offduty) min = titleTimeOf(firstLine, true);
    } else if (e.kind === "day" && day && !(manual && isOffTitle(e.title))) {
      const type = m[e.title]?.type ?? "日勤";
      if (type === "日勤" || type === "泊") min = titleTimeOf(firstLine, false);
    }
    return min === null ? e : { ...e, title: `${e.title}(${formatMinutes(min)})` };
  });
}

// 名前の終わりの「(10:00)」(全角の括弧・数字も)。手入力でもう時間を付けている
const TITLE_TIME_END = /[(（]\s*[0-9０-９]{1,2}\s*[:：]\s*[0-9０-９]{2}\s*[)）]$/;

// 名前に付ける時間(その日の0時からの分)。メモの1行目の先頭の時間を読み、後ろの言葉は見ない(「10:00 早出」→ 10:00)。
// 出勤は最初の時間(「10:15〜19:02」→ 10:15)。非番は退勤時間で、「8:30〜9:02」のように2つあれば後ろ、先頭の「〜」も読む。
// 全角・「～」「-」なども parseTimeRange と同じに読む。24時以降・時間で始まらないものは null
function titleTimeOf(text: string, offduty: boolean): number | null {
  const s = normalizeTimeText(text);
  const m = offduty ? s.match(/^〜?(?:\d{1,2}:\d{2}〜(?=\d))?(\d{1,2}):(\d{2})(?!\d)/) : s.match(/^(\d{1,2}):(\d{2})(?!\d)/);
  if (!m) return null;
  const [h, min] = [Number(m[1]), Number(m[2])];
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function formatMinutes(min: number): string {
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;
}

// 勤務を時間つきの予定で登録する設定のとき、勤務用の出勤の予定を、終日ではなく時間つきにする
// (TimeTree など、時間つきの予定で勤務を見る人向け)。「2件で登録」「名前に時間」の設定は使わない。
//   泊: 出勤時間から翌日の非番の退勤時間までの1件。タイトルは番号、メモは泊地(メモの1行目の時間のあとの言葉と、2行目)。
//       翌日の非番(「〜」)は作らない。月末の泊は、翌月1日の退勤時間までの1件(翌月1日の非番は作らない)。
//   日勤: 出勤時間から退勤時間まで。メモは今のまま(「10:15〜19:02」)。退勤が出勤より前なら翌日の退勤まで。
//   手入力の番号(マスタにない): メモに「10:00〜18:00」なら日勤と同じ。メモが出勤時間だけ(「10:00 大阪」)で、
//       翌日が手入力の非番(「〜」「非番」など)でメモに退勤時間があれば、泊と同じ1件(メモは時間のあとの言葉)。
//       月末の手入力の泊(翌日が翌月1日)はまとめない(翌月の登録からは、前の月の手入力の泊かどうか分からないため)。
//   月の1日の非番(前の月の月末が泊)は、前の月の月末から1日にまたがる時間つきの泊の1件がカレンダーにあるとき
//   (prevStayTimed。listAppEvents の carried)だけ作らない。前の月の泊が終日で登録されているときは作る(Z1)。
//   時間として読めない日(メモを手で書き換えたとき・24時以降の出勤)は、今までどおり終日。泊は泊・非番の2件とも終日のまま。
//   休日・休日用カレンダーの予定・手入力の休み(「公休」など)は終日のまま
export function toTimedEvents(
  events: PlannedEvent[],
  master: Record<string, any>,
  { first, nextFirst, prevStayTimed = false }: { first: string; nextFirst: string; prevStayTimed?: boolean },
): PlannedEvent[] {
  const byDate = new Map(events.filter((e) => e.calendar === "work").map((e) => [e.date, e]));
  const dropped = new Set<PlannedEvent>();
  const out: PlannedEvent[] = [];
  for (const e of events) {
    if (dropped.has(e)) continue;
    if (e.calendar !== "work") {
      out.push(e);
      continue;
    }
    if (e.kind === "offduty") {
      // 前の月の月末の泊から続く非番は、前の月の登録の泊の1件に入っている
      if (e.date === first && prevStayTimed && offdutyEndOf(e) !== null) continue;
      out.push(e);
      continue;
    }
    const m = masterOn(master, e.date);
    const manual = !m[e.title];
    if (e.kind !== "day" || (manual && isOffTitle(e.title))) {
      out.push(e);
      continue;
    }
    const type = m[e.title]?.type ?? "日勤";
    const lines = e.description.split("\n");
    const head = leadingTime(lines[0], parseTimeRange);
    if (!head || (type !== "日勤" && type !== "泊")) {
      out.push(e);
      continue;
    }
    const range = head.value;
    const next = byDate.get(addDays(e.date, 1));
    const stay = type === "泊" || (manual && range.end === null && next?.date !== nextFirst);
    if (stay) {
      // 泊: 翌日の非番(マスタの泊なら自動の非番、手入力なら手入力の非番)の退勤時間まで
      const pair = type === "泊"
        ? next?.kind === "offduty"
        : next?.kind === "day" && !masterOn(master, next.date)[next.title] && isOffdutyTitle(next.title);
      const nextLines = next ? next.description.split("\n") : [];
      const off = pair ? leadingTime(nextLines[0], parseOffdutyTime) : null;
      if (!off || !next) {
        out.push(e);
        continue;
      }
      const end = off.value;
      dropped.add(next);
      // メモは泊地(泊の日のメモの時間のあとの言葉と2行目)のあとに、非番のメモの時間のあとの言葉と2行目を続ける(Z2)
      const description = [head.rest, ...lines.slice(1), off.rest, ...nextLines.slice(1)]
        .map((l) => l.trim()).filter(Boolean).join("\n");
      out.push({ ...e, description, timed: { startMin: range.start, endMin: 1440 + end } });
      continue;
    }
    if (range.end === null) {
      out.push(e);
      continue;
    }
    const endMin = range.end <= range.start ? range.end + 1440 : range.end;
    out.push({ ...e, timed: { startMin: range.start, endMin } });
  }
  return out;
}

// 非番の予定のメモの1行目の退勤時間(分)。読めなければ null
function offdutyEndOf(e: PlannedEvent): number | null {
  return leadingTime(e.description.split("\n")[0], parseOffdutyTime)?.value ?? null;
}

// 1行の先頭の時間と、そのあとの言葉(「10:00 大阪」→ 10:00 と「大阪」)。時間と言葉は空白(全角も)で区切る。
// 「10:00 〜 18:00 早出」のように時間の中に空白があっても、読める一番長い先頭を時間とみなす。
// 空白が無くても(「10:00大阪」「9:00〜18:00早出」)、先頭の時間(と「〜」で続く時間)を読む(Z3)
function leadingTime<T>(line: string, parse: (text: string) => T | null): { value: T; rest: string } | null {
  const words = line.trim().split(/\s+/);
  for (let k = words.length; k >= 1; k--) {
    const value = parse(words.slice(0, k).join(""));
    if (value !== null) return { value, rest: words.slice(k).join(" ") };
  }
  const m = line.trim().match(LEADING_TIME);
  if (!m) return null;
  const value = parse(m[1]);
  return value === null ? null : { value, rest: m[2].trim() };
}

// 先頭の時間(「〜」で続くもう1つの時間も)と、そのあと。数字は全角も。時間のすぐあとに数字が続くもの(「10:005」)は読まない
const TIME = "[0-9０-９]{1,2}\\s*[:：]\\s*[0-9０-９]{2}(?![0-9０-９])";
const SEP = "(?:から|[〜～~∼〰\\-－−ー―—–‐‑‒─ｰ→⇒])";
const LEADING_TIME = new RegExp(`^((?:${SEP}\\s*)?${TIME}(?:\\s*${SEP}\\s*${TIME})?)(.*)$`);
