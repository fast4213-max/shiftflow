// アプリ内カレンダー用: 勤務の記録(shift_records)から、画面に出す勤務の予定を作る。
// Google に登録するときと同じ組み立て(plan.js の buildPlan と、shift-calendar.ts の 2件・名前に時間・時間つき)を使うので、
// カレンダーの表記は、利用者の設定どおり・Google に入る予定と同じになる(Google には何も書かない)。

import { addDays, buildPlan, codeOf, dateKey, daysInMonth } from "./plan.js";
import { addTimeToTitles, type PlannedEvent, splitDayEvents, splitOffdutyEvents, toTimedEvents } from "./shift-calendar.ts";

export type ShiftViewSettings = {
  splitDayEvents?: boolean;
  splitOffdutyEvents?: boolean;
  titleDayTime?: boolean;
  titleOffdutyTime?: boolean;
  timedEvents?: boolean;
};

export type ViewEvent = {
  date: string;
  endDate: string;
  allDay: boolean;
  startTime: string; // "HH:MM"(終日は "")
  endTime: string;
  calendar: "work" | "holiday" | "offduty";
  kind: string; // "day" | "offduty"
  title: string;
  description: string;
};

export type RecordMap = Record<string, { code?: string; memo?: string } | undefined>;

const hhmm = (min: number): string => `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

// 計画された予定 1件 → 画面の予定(時間の予定が付いているときは、そのぶんも)
// 名前の終わりが「(10:00)」のような時間か(名前に時間を付ける設定のとき)
const TITLE_TIME_END = /[(（]\s*[0-9０-９]{1,2}\s*[:：]\s*[0-9０-９]{2}\s*[)）]$/;

// 出勤・非番を2件で登録する設定のとき、Google には「番号」と「時間」の2件が入る。
// アプリ内のカレンダーでは、同じ日に2本並ぶと二重に見えるので、1本にまとめる(名前のあとに時間を続ける。例: 「〜 9:54」「25 10:15〜19:02」)。
// 名前に時間がもう付いている(「〜(9:54)」)ときは、続けない
export function toViewEvents(e: PlannedEvent): ViewEvent[] {
  const out: ViewEvent[] = [];
  const calendar = e.calendar as ViewEvent["calendar"];
  if (e.second) {
    const title = TITLE_TIME_END.test(e.title) ? e.title : `${e.title} ${e.second.title}`.trim();
    return toViewEvents({ ...e, title, second: undefined });
  }
  if (e.timed) {
    out.push({
      date: e.date,
      endDate: addDays(e.date, Math.floor(e.timed.endMin / 1440)),
      allDay: false,
      startTime: hhmm(e.timed.startMin),
      endTime: hhmm(e.timed.endMin),
      calendar,
      kind: e.kind,
      title: e.title,
      description: e.description,
    });
  } else {
    out.push({ date: e.date, endDate: e.date, allDay: true, startTime: "", endTime: "", calendar, kind: e.kind, title: e.title, description: e.description });
  }
  return out;
}

// months: 連続した月(古い順)。records: 前月の末日〜最後の月の翌月1日の記録。
// 各月を register-month と同じ順で組み立て、その月の日の予定だけを集める(翌月1日の予定は、翌月の組み立てで出る)
export function buildShiftView(
  { months, records, master, holidays, settings }: {
    months: { year: number; month: number }[];
    records: RecordMap;
    master: unknown;
    holidays: string[];
    settings: ShiftViewSettings;
  },
): ViewEvent[] {
  const out: ViewEvent[] = [];
  let prevStayTimed = false;
  for (const { year, month } of months) {
    const first = dateKey(year, month, 1);
    const last = dateKey(year, month, daysInMonth(year, month));
    const prevLast = addDays(first, -1);
    const nextFirst = addDays(last, 1);
    const entries: Record<string, { code: string; memo: string }> = {};
    for (let d = first; d <= last; d = addDays(d, 1)) {
      const r = records[d];
      if (r && (r.code || r.memo)) entries[d] = { code: r.code || "", memo: r.memo || "" };
    }
    const nextFirstRecord = records[nextFirst];
    const plan = buildPlan({
      year,
      month,
      entries,
      prevLastCode: codeOf(records[prevLast]),
      nextFirstEntry: nextFirstRecord ? { code: nextFirstRecord.code || "", memo: nextFirstRecord.memo || "" } : undefined,
      master,
      holidays,
    });

    let events: PlannedEvent[];
    if (settings.timedEvents) {
      events = toTimedEvents(plan.events, master as Record<string, any>, { first, nextFirst, prevStayTimed });
    } else {
      const daySplit = settings.splitDayEvents ? splitDayEvents(plan.events, master as Record<string, any>) : plan.events;
      const split = settings.splitOffdutyEvents ? splitOffdutyEvents(daySplit, master as Record<string, any>) : daySplit;
      events = addTimeToTitles(split, master as Record<string, any>, { day: !!settings.titleDayTime, offduty: !!settings.titleOffdutyTime });
    }

    const mine = events.filter((e) => e.date >= first && e.date <= last);
    // 月末の泊が、時間つきで翌月1日の朝まで続く1件になっているか(翌月の1日の非番を、また作らないため)
    prevStayTimed = mine.some((e) => e.date === last && !!e.timed && e.timed.endMin >= 1440);
    for (const e of mine) out.push(...toViewEvents(e));
  }
  return out;
}

// 画面の月の範囲(months)の、勤務の予定。1か月前から組み立てて、前の月の末日からの分だけ残す。
// (前の月の末日が泊で、時間つきの設定のとき、泊は翌月1日の朝までの1件になる。前の月を組み立てないと、
//  範囲の最初の月の1日に、余計な「〜」が出て、泊の続きが出なくなるため。M6)
export function buildShiftViewWithCarry(
  { months, ...rest }: {
    months: { year: number; month: number }[];
    records: RecordMap;
    master: unknown;
    holidays: string[];
    settings: ShiftViewSettings;
  },
): ViewEvent[] {
  const first = months[0];
  const prev = first.month === 1 ? { year: first.year - 1, month: 12 } : { year: first.year, month: first.month - 1 };
  const keepFrom = addDays(dateKey(first.year, first.month, 1), -1);
  return buildShiftView({ months: [prev, ...months], ...rest }).filter((e) => e.date >= keepFrom);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// 実在する日付か(2000〜2100年。「2026-13-45」などは通さない)
export function validIso(s: string): boolean {
  if (!DATE.test(s)) return false;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  return y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

// from〜to にかかる月(古い順)
export function monthsBetween(from: string, to: string): { year: number; month: number }[] {
  const out: { year: number; month: number }[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const endY = Number(to.slice(0, 4));
  const endM = Number(to.slice(5, 7));
  while (y < endY || (y === endY && m <= endM)) {
    out.push({ year: y, month: m });
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

