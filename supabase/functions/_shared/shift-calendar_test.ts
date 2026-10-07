// カレンダー操作のテスト(Google への通信は偽物に差し替える)
//   deno test supabase/functions --allow-read --allow-env

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createEvents, deleteAppEvents, eventsToRegister, listAppEvents, parseTimeRange, isOffTitle, splitDayEvents, staleNextMonthRecords } from "./shift-calendar.ts";
import { AppError, entriesFrom, yearMonthOf } from "./http.ts";
import {
  calendarAccessError,
  clearsVerification,
  GoogleError,
  isPrimaryCalendarId,
  nextRetryDelay,
  resetGoogleCacheForTest,
  retryPolicy,
  withRetryBudget,
} from "./google.ts";
import { buildPlan, indexMaster } from "./plan.js";

// テスト用の使い捨て鍵でサービスアカウントを用意する
const pair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8))}\n-----END PRIVATE KEY-----\n`;
Deno.env.set("GOOGLE_SERVICE_ACCOUNT_JSON", JSON.stringify({ client_email: "sa@example.iam.gserviceaccount.com", private_key: pem }));

type Call = { method: string; url: URL; body?: any };

function mockFetch(handler: (c: Call) => Response | undefined) {
  const calls: Call[] = [];
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method || "GET";
    if (url.host === "oauth2.googleapis.com") {
      const assertion = new URLSearchParams(String(init?.body)).get("assertion")!;
      assertEquals(assertion.split(".").length, 3);
      return Promise.resolve(Response.json({ access_token: "token", expires_in: 3600 }));
    }
    const call: Call = { method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return Promise.resolve(handler(call) || new Response(null, { status: 204 }));
  };
  return calls;
}

const tag = (kind: string) => ({ private: { shiftflow: kind } });

Deno.test("deleteAppEvents: アプリの予定だけ、月内+翌月1日の非番だけを消す", async () => {
  const work = "work@group.calendar.google.com";
  const holiday = "holiday@group.calendar.google.com";
  const calls = mockFetch((c) => {
    if (c.method !== "GET") return;
    if (c.url.pathname.includes(encodeURIComponent(work))) {
      return Response.json({
        items: [
          { id: "prev", start: { date: "2026-09-30" }, extendedProperties: tag("day") },
          { id: "a", start: { date: "2026-10-01" }, extendedProperties: tag("offduty") },
          { id: "manual", start: { date: "2026-10-05" } },
          { id: "b", start: { date: "2026-10-31" }, extendedProperties: tag("day") },
          { id: "c", start: { date: "2026-11-01" }, extendedProperties: tag("offduty") },
          { id: "next-day", start: { date: "2026-11-01" }, extendedProperties: tag("day") },
          { id: "next-2-off", start: { date: "2026-11-02" }, extendedProperties: tag("offduty") },
          { id: "timed", start: { dateTime: "2026-10-10T10:00:00+09:00" }, extendedProperties: tag("day") },
        ],
      });
    }
    return Response.json({
      items: [
        { id: "h", start: { date: "2026-10-10" }, extendedProperties: tag("day") },
        { id: "h-next", start: { date: "2026-11-01" }, extendedProperties: tag("day") },
      ],
    });
  });

  const count = await deleteAppEvents({ work, holiday }, 2026, 10);
  const deleted = calls.filter((c) => c.method === "DELETE").map((c) => c.url.pathname.split("/").pop()).sort();
  // 時間つきの予定(出勤を2件で登録したときの2件目。印あり)も消す
  assertEquals(deleted, ["a", "b", "c", "h", "timed"]);
  assertEquals(count, 5);
});

Deno.test("deleteAppEvents: 月末が泊のときは、翌月1日のアプリの予定を全部消す(非番と重ならない)", async () => {
  const work = "work@group.calendar.google.com";
  const holiday = "holiday@group.calendar.google.com";
  const calls = mockFetch((c) => {
    if (c.method !== "GET") return;
    if (c.url.pathname.includes(encodeURIComponent(work))) {
      return Response.json({
        items: [
          { id: "c", start: { date: "2026-11-01" }, extendedProperties: tag("offduty") },
          { id: "next-day", start: { date: "2026-11-01" }, extendedProperties: tag("day") },
          { id: "next-manual", start: { date: "2026-11-01" } },
          { id: "next-2", start: { date: "2026-11-02" }, extendedProperties: tag("day") },
        ],
      });
    }
    return Response.json({ items: [{ id: "h-next", start: { date: "2026-11-01" }, extendedProperties: tag("day") }] });
  });

  const count = await deleteAppEvents({ work, holiday }, 2026, 10, { clearNextFirst: true });
  const deleted = calls.filter((c) => c.method === "DELETE").map((c) => c.url.pathname.split("/").pop()).sort();
  assertEquals(deleted, ["c", "h-next", "next-day"]);
  assertEquals(count, 3);
});

Deno.test("deleteAppEvents: 翌月1日が非番になるときは、翌月2日の非番(勤務用)も消す。翌月2日の他の予定は消さない", async () => {
  const work = "work@group.calendar.google.com";
  const holiday = "holiday@group.calendar.google.com";
  const calls = mockFetch((c) => {
    if (c.method !== "GET") return;
    if (c.url.pathname.includes(encodeURIComponent(work))) {
      return Response.json({
        items: [
          { id: "next-1", start: { date: "2026-11-01" }, extendedProperties: tag("day") },
          { id: "next-2-off", start: { date: "2026-11-02" }, extendedProperties: tag("offduty") },
          { id: "next-2-day", start: { date: "2026-11-02" }, extendedProperties: tag("day") },
          { id: "next-2-manual", start: { date: "2026-11-02" } },
          { id: "next-3-off", start: { date: "2026-11-03" }, extendedProperties: tag("offduty") },
        ],
      });
    }
    return Response.json({ items: [{ id: "h-next-2", start: { date: "2026-11-02" }, extendedProperties: tag("offduty") }] });
  });

  const count = await deleteAppEvents({ work, holiday }, 2026, 10, { clearNextFirst: true, clearNextSecondOffduty: true });
  const deleted = calls.filter((c) => c.method === "DELETE").map((c) => c.url.pathname.split("/").pop()).sort();
  assertEquals(deleted, ["next-1", "next-2-off"]);
  assertEquals(count, 2);
});

Deno.test("staleNextMonthRecords: 月末の泊が変わって翌月1日の非番が変わるときに消す、翌月の記録", () => {
  const master = indexMaster([
    { code: "101", kind: "泊" },
    { code: "201", kind: "日勤" },
    { code: "公休", kind: "休日" },
  ]);
  const base = { nextFirst: "2026-11-01", master };
  // 月末を泊にした(翌月1日が非番になる): 翌月1日の番号を消す。泊だったなら翌月2日の非番のメモも消す
  assertEquals(staleNextMonthRecords({ ...base, lastCode: "", nextFirstOffduty: true, nextFirstCode: "201" }), [
    { date: "2026-11-01", memoOnly: false },
  ]);
  assertEquals(staleNextMonthRecords({ ...base, lastCode: "201", nextFirstOffduty: true, nextFirstCode: "101" }), [
    { date: "2026-11-01", memoOnly: false },
    { date: "2026-11-02", memoOnly: true },
  ]);
  // 翌月1日に番号が無い(非番のメモだけ・記録なし)なら、何も消さない(非番のメモに使う)
  assertEquals(staleNextMonthRecords({ ...base, lastCode: "101", nextFirstOffduty: true, nextFirstCode: "" }), []);
  // 月末を泊から戻した・リセットした(翌月1日が非番でなくなる): 翌月1日の非番のメモ(番号の無い記録)を消す
  assertEquals(staleNextMonthRecords({ ...base, lastCode: "101", nextFirstOffduty: false, nextFirstCode: "" }), [
    { date: "2026-11-01", memoOnly: true },
  ]);
  // もともと非番でなかった(月末が泊でない)なら、翌月1日のメモは本人が書いたものなので残す
  assertEquals(staleNextMonthRecords({ ...base, lastCode: "201", nextFirstOffduty: false, nextFirstCode: "" }), []);
  assertEquals(staleNextMonthRecords({ ...base, lastCode: "", nextFirstOffduty: false, nextFirstCode: "201" }), []);
});

Deno.test("createEvents: 終日予定(終了日は翌日)に印を付けて作る", async () => {
  const calls = mockFetch((c) => (c.method === "POST" ? Response.json({ id: "new" }) : undefined));
  const result = await createEvents({ work: "w", holiday: "h" }, [
    { date: "2026-10-31", calendar: "work", kind: "day", title: "101", description: "9:00\n泊地A" },
    { date: "2026-11-01", calendar: "work", kind: "offduty", title: "〜", description: "9:30" },
    { date: "2026-10-10", calendar: "holiday", kind: "day", title: "公休", description: "" },
  ]);
  assertEquals(result, { created: 3, skipped: 0 });
  const posts = calls.filter((c) => c.method === "POST");
  assertEquals(posts.length, 3);
  const first = posts.find((c) => c.body.summary === "101")!;
  assertEquals(first.body, {
    summary: "101",
    description: "9:00\n泊地A",
    start: { date: "2026-10-31" },
    end: { date: "2026-11-01" },
    extendedProperties: { private: { shiftflow: "day" } },
  });
  const off = posts.find((c) => c.body.summary === "公休")!;
  assert(off.url.pathname.includes("/calendars/h/"));
  assertEquals(off.body.description, undefined);
});

Deno.test("書き込み権限がないと、共有設定を確認するメッセージになる", async () => {
  mockFetch(() => Response.json({ error: { code: 403, message: "You need to have writer access to this calendar.", errors: [{ reason: "requiredAccessLevel" }] } }, { status: 403 }));
  const err = await assertRejects(
    () => createEvents({ work: "w", holiday: "h" }, [{ date: "2026-10-01", calendar: "work", kind: "day", title: "x", description: "" }]),
    AppError,
  );
  assert(err.message.includes("勤務用カレンダーに書き込めません"));
  assert(err.message.includes("すべての予定の詳細の変更や表示ができます"));
});

Deno.test("1件失敗したら残りは作らず、作っている途中の分が終わってからエラーにする", async () => {
  let active = 0;
  let maxActive = 0;
  const started: string[] = [];
  const finished: string[] = [];
  // 1件目の作成だけ失敗させ、他は少し時間をかけて成功させる
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host === "oauth2.googleapis.com") return Response.json({ access_token: "token", expires_in: 3600 });
    const body = JSON.parse(String(init?.body));
    started.push(body.summary);
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, body.summary === "d1" ? 5 : 30));
    active--;
    finished.push(body.summary);
    if (body.summary === "d1") {
      return Response.json({ error: { code: 403, errors: [{ reason: "requiredAccessLevel" }] } }, { status: 403 });
    }
    return Response.json({ id: body.summary });
  };
  const events = Array.from({ length: 12 }, (_, i) => ({
    date: `2026-10-${String(i + 1).padStart(2, "0")}`,
    calendar: "work",
    kind: "day",
    title: `d${i + 1}`,
    description: "",
  }));
  await assertRejects(() => createEvents({ work: "w", holiday: "h" }, events), AppError);
  // 同時に4件まで。失敗の時点で動いていた3件は終わってからエラーになり、残り(8件)は始めない
  assertEquals(maxActive, 4);
  assertEquals(started.length, 4);
  assertEquals(finished.sort(), started.sort());
  assertEquals(active, 0);
});

Deno.test("レート制限は待って再試行する", async () => {
  const saved = [...retryPolicy.baseMs];
  retryPolicy.baseMs = [20];
  let n = 0;
  const calls = mockFetch((c) => {
    if (c.method !== "POST") return;
    n++;
    if (n === 1) return Response.json({ error: { code: 403, errors: [{ reason: "rateLimitExceeded" }] } }, { status: 403 });
    return Response.json({ id: "ok" });
  });
  try {
    await createEvents({ work: "w", holiday: "h" }, [{ date: "2026-10-01", calendar: "work", kind: "day", title: "x", description: "" }]);
  } finally {
    retryPolicy.baseMs = saved;
  }
  assertEquals(calls.filter((c) => c.method === "POST").length, 2);
});

Deno.test("nextRetryDelay: 待ち時間は長くなり、±25%ずらし、回数が尽きる・期限を超えるなら null", () => {
  const base = retryPolicy.baseMs;
  assertEquals(base.reduce((a, b) => a + b, 0), 67000); // 合計は約1分(1分で上限が戻る)
  for (let i = 0; i < base.length; i++) {
    assertEquals(nextRetryDelay(i, 0, 1e12, 0), Math.round(base[i] * 0.75));
    assertEquals(nextRetryDelay(i, 0, 1e12, 0.5), base[i]);
    assertEquals(nextRetryDelay(i, 0, 1e12, 1), Math.round(base[i] * 1.25));
  }
  assertEquals(nextRetryDelay(base.length, 0, 1e12), null); // 回数が尽きた
  assertEquals(nextRetryDelay(0, 1000, 2999, 0.5), null); // 待つと期限(2999)を超える
  assertEquals(nextRetryDelay(0, 1000, 3000, 0.5), 2000); // ちょうどなら待つ
});

Deno.test("混んでいても、期限の中なら待って再試行して成功する(期限が無いときの15秒を超えて待てる)", async () => {
  const saved = [...retryPolicy.baseMs];
  retryPolicy.baseMs = [20, 20, 20];
  try {
    let n = 0;
    const calls = mockFetch((c) => {
      if (c.method !== "POST") return;
      n++;
      return n <= 3 ? Response.json({ error: { code: 429 } }, { status: 429 }) : Response.json({ id: "ok" });
    });
    await withRetryBudget(60_000, () =>
      createEvents({ work: "w", holiday: "h" }, [{ date: "2026-10-01", calendar: "work", kind: "day", title: "x", description: "" }])
    );
    assertEquals(calls.filter((c) => c.method === "POST").length, 4);
  } finally {
    retryPolicy.baseMs = saved;
  }
});

Deno.test("期限が近いと、待たずに諦めてエラーにする(ロックの150秒を超えない)", async () => {
  const saved = [...retryPolicy.baseMs];
  retryPolicy.baseMs = [5000, 5000];
  try {
    const calls = mockFetch((c) => (c.method === "POST" ? Response.json({ error: { code: 429 } }, { status: 429 }) : undefined));
    const started = Date.now();
    await assertRejects(
      () =>
        withRetryBudget(1000, () =>
          createEvents({ work: "w", holiday: "h" }, [{ date: "2026-10-01", calendar: "work", kind: "day", title: "x", description: "" }])),
      AppError,
    );
    assertEquals(calls.filter((c) => c.method === "POST").length, 1); // 5秒待つと期限を超えるので再試行しない
    assert(Date.now() - started < 1000);
  } finally {
    retryPolicy.baseMs = saved;
  }
});

Deno.test("期限が無い呼び出しは、呼び出しごとに15秒までで諦める", async () => {
  const saved = [...retryPolicy.baseMs];
  retryPolicy.baseMs = [10, 20000];
  try {
    const calls = mockFetch((c) => (c.method === "POST" ? Response.json({ error: { code: 429 } }, { status: 429 }) : undefined));
    await assertRejects(
      () => createEvents({ work: "w", holiday: "h" }, [{ date: "2026-10-01", calendar: "work", kind: "day", title: "x", description: "" }]),
      AppError,
    );
    assertEquals(calls.filter((c) => c.method === "POST").length, 2); // 10ms 待って1回、20秒は期限(15秒)を超えるので諦める
  } finally {
    retryPolicy.baseMs = saved;
  }
});

Deno.test("休日用のカレンダーが空なら、「休日」の予定は作らない(勤務・非番は作る)", async () => {
  const calls = mockFetch((c) => (c.method === "POST" ? Response.json({ id: "new" }) : undefined));
  const result = await createEvents({ work: "w", holiday: "" }, [
    { date: "2026-10-05", calendar: "work", kind: "day", title: "101", description: "9:00" },
    { date: "2026-10-06", calendar: "work", kind: "offduty", title: "〜", description: "9:30" },
    { date: "2026-10-07", calendar: "holiday", kind: "day", title: "公休", description: "" },
    { date: "2026-10-08", calendar: "holiday", kind: "day", title: "年休", description: "" },
  ]);
  assertEquals(result, { created: 2, skipped: 2 });
  const posts = calls.filter((c) => c.method === "POST");
  assertEquals(posts.map((c) => c.body.summary).sort(), ["101", "〜"]);
  posts.forEach((c) => assert(c.url.pathname.includes("/calendars/w/")));
});

Deno.test("休日用のカレンダーが空でも、削除は勤務用だけを見る(空のIDで呼ばない)", async () => {
  const calls = mockFetch((c) =>
    c.method === "GET"
      ? Response.json({ items: [{ id: "a", start: { date: "2026-10-05" }, extendedProperties: tag("day") }] })
      : undefined
  );
  const count = await deleteAppEvents({ work: "w", holiday: "" }, 2026, 10);
  assertEquals(count, 1);
  const gets = calls.filter((c) => c.method === "GET");
  assertEquals(gets.length, 1);
  assert(gets[0].url.pathname.includes("/calendars/w/"));
});

Deno.test("eventsToRegister: 翌月1日の非番は必ず作り、翌月1日の記録の予定はアプリの予定があるときだけ作り直す", () => {
  const planned = [
    { date: "2026-10-31", calendar: "work", kind: "day", title: "201", description: "" },
    { date: "2026-11-01", calendar: "work", kind: "day", title: "201", description: "" },
  ];
  const offduty = [
    { date: "2026-10-31", calendar: "work", kind: "day", title: "101", description: "" },
    { date: "2026-11-01", calendar: "work", kind: "offduty", title: "〜", description: "" },
  ];
  const onNextFirst = [{ calendarId: "w", eventId: "x", date: "2026-11-01", tag: "offduty" }];
  // 泊から戻した(翌月1日に非番が残っている) → 翌月1日の予定を作り直す
  assertEquals(eventsToRegister(planned, onNextFirst, "2026-11-01"), planned);
  // 翌月をリセットした・まだ登録していない(翌月1日にアプリの予定が無い) → 作らない
  assertEquals(eventsToRegister(planned, [], "2026-11-01"), [planned[0]]);
  // 前の登録が途中で失敗して、翌月1日の予定を消したまま(印あり)→ 残っていなくても作り直す
  assertEquals(eventsToRegister(planned, [], "2026-11-01", true), planned);
  assertEquals(eventsToRegister(planned, [], "2026-11-01", false), [planned[0]]);
  // 月末が泊 → 非番は必ず作る
  assertEquals(eventsToRegister(offduty, [], "2026-11-01"), offduty);
});

Deno.test("splitDayEvents: 勤務用の出勤(日勤・泊)だけ、出勤時間の予定(時間つき)を付ける", () => {
  const master = indexMaster([
    { code: "25", kind: "日勤", weekday_start: "10:00", weekday_end: "18:30", holiday_start: "", holiday_end: "", stay: "" },
    { code: "40", kind: "泊", weekday_start: "9:01", weekday_end: "", holiday_start: "", holiday_end: "", stay: "品川" },
    { code: "休", kind: "休日", weekday_start: "", weekday_end: "", holiday_start: "", holiday_end: "", stay: "" },
  ]);
  const ev = (title: string, description: string, over: Record<string, string> = {}) =>
    ({ date: "2026-10-01", calendar: "work", kind: "day", title, description, ...over });
  const out = splitDayEvents([
    ev("25", "10:00〜18:30"),
    ev("40", "9:01\n品川"),
    ev("休", "", { calendar: "holiday" }),
    ev("〜", "7:00", { kind: "offduty" }),
    ev("手入力", "メモ"),
    ev("2001", "10:00-23:00"), // マスタにない番号(手入力)でも、メモが時間なら分ける
    ev("25", "遅れて出勤"), // メモを時間でないものに書き換えた
    ev("25", "5:00〜4:00"), // 退勤が出勤より前なら1時間(日をまたぐ勤務も、翌日まで伸ばさない)
  ], master);
  assertEquals(out[0].second, { title: "10:00〜18:30", description: "", startMin: 600, endMin: 1110 });
  assertEquals(out[1].second, { title: "9:01", description: "", startMin: 541, endMin: 601 }); // 泊は出勤から1時間
  assertEquals(out[2].second, undefined);
  assertEquals(out[3].second, undefined);
  assertEquals(out[4].second, undefined);
  assertEquals(out[5].second, { title: "10:00-23:00", description: "", startMin: 600, endMin: 1380 });
  assertEquals(out[6].second, undefined);
  assertEquals(out[7].second, { title: "5:00〜4:00", description: "", startMin: 300, endMin: 360 });
});

Deno.test("parseTimeRange: 手で書き換えたメモの全角・「～」なども時間として読む。24時以降の出勤は読まない", () => {
  assertEquals(parseTimeRange("10:15〜19:02"), { start: 615, end: 1142 });
  assertEquals(parseTimeRange("9:01"), { start: 541, end: null });
  // 日本語入力で入りやすい形(全角の「～」、全角の数字・コロン、「-」「ー」、間の空白)
  assertEquals(parseTimeRange("8:00～17:00"), { start: 480, end: 1020 });
  assertEquals(parseTimeRange("１０：００〜１８：３０"), { start: 600, end: 1110 });
  assertEquals(parseTimeRange("8:00 - 17:00"), { start: 480, end: 1020 });
  assertEquals(parseTimeRange("8:00ー17:00"), { start: 480, end: 1020 });
  assertEquals(parseTimeRange("8:00~17:00"), { start: 480, end: 1020 });
  for (const dash of ["〜", "～", "~", "-", "－", "−", "ー", "―", "—", "–", "‐", "─"]) {
    assertEquals(parseTimeRange(`8:00${dash}17:00`), { start: 480, end: 1020 }, dash);
  }
  // 退勤を消した・読めない(出勤だけとみなす)
  assertEquals(parseTimeRange("9:00〜"), { start: 540, end: null });
  assertEquals(parseTimeRange("9:00〜17:75"), { start: 540, end: null });
  // 退勤は24時を超えてもよい(日をまたぐ)
  assertEquals(parseTimeRange("15:00〜25:30"), { start: 900, end: 1530 });
  // 出勤が24時以降・時刻でない(翌日の予定になってしまうので読まない)
  assertEquals(parseTimeRange("25:00"), null);
  assertEquals(parseTimeRange("24:30〜26:00"), null);
  assertEquals(parseTimeRange("9:75"), null);
  assertEquals(parseTimeRange("研修"), null);
  assertEquals(parseTimeRange("9時〜17時"), null);
  assertEquals(parseTimeRange(""), null);
});

Deno.test("splitDayEvents: 全角の「～」で書き換えたメモでも時間の予定を作り、24時以降の出勤は1件のまま(翌月1日に入らない)", () => {
  const master = indexMaster([
    { code: "25", kind: "日勤", weekday_start: "10:00", weekday_end: "18:30", holiday_start: "", holiday_end: "", stay: "" },
    { code: "40", kind: "泊", weekday_start: "9:01", weekday_end: "", holiday_start: "", holiday_end: "", stay: "品川" },
  ]);
  const ev = (title: string, description: string) => ({ date: "2026-10-31", calendar: "work", kind: "day", title, description });
  const out = splitDayEvents([ev("25", "8:00～17:00"), ev("40", "２３：３０\n品川"), ev("25", "25:00"), ev("40", "24:10\n品川")], master);
  assertEquals(out[0].second, { title: "8:00～17:00", description: "", startMin: 480, endMin: 1020 });
  assertEquals(out[1].second, { title: "２３：３０", description: "", startMin: 1410, endMin: 1470 });
  assertEquals(out[2].second, undefined);
  assertEquals(out[3].second, undefined);
});

Deno.test("createEvents: 番号は終日、2件目は日本時間の時間つきで作る", async () => {
  const posted: any[] = [];
  mockFetch((c) => {
    if (c.method === "POST") {
      posted.push(c.body);
      return Response.json({ id: "x" });
    }
  });
  const result = await createEvents({ work: "w@group.calendar.google.com", holiday: "" }, [
    { date: "2026-10-01", calendar: "work", kind: "day", title: "25", description: "10:00〜18:30", second: { title: "10:00〜18:30", description: "", startMin: 600, endMin: 1110 } },
    { date: "2026-10-02", calendar: "work", kind: "day", title: "40", description: "23:30", second: { title: "23:30", description: "", startMin: 1410, endMin: 1470 } },
    { date: "2026-10-03", calendar: "work", kind: "offduty", title: "〜", description: "9:30" },
  ]);
  // 件数は、時間の予定も数える(リセットで消した件数と合うように)
  assertEquals(result, { created: 5, skipped: 0 });
  assertEquals(posted.length, 5);
  const allDay = posted.filter((b) => b.start.date);
  const timed = posted.filter((b) => b.start.dateTime);
  assertEquals(allDay.map((b) => b.summary).sort(), ["25", "40", "〜"]);
  assertEquals(allDay.find((b) => b.summary === "25").description, "10:00〜18:30");
  const t25 = timed.find((b) => b.summary === "10:00〜18:30");
  assertEquals(t25.start, { dateTime: "2026-10-01T10:00:00", timeZone: "Asia/Tokyo" });
  assertEquals(t25.end, { dateTime: "2026-10-01T18:30:00", timeZone: "Asia/Tokyo" });
  assertEquals(t25.extendedProperties, tag("day")); // 印が付く(あとで消せる)
  // 24時を超えたら翌日
  const t40 = timed.find((b) => b.summary === "23:30");
  assertEquals(t40.end, { dateTime: "2026-10-03T00:30:00", timeZone: "Asia/Tokyo" });
});

Deno.test("手入力の番号: メモの時間から、buildPlan → splitDayEvents で終日+時間の2件になる(退勤がなければ1時間)", () => {
  const plan = buildPlan({
    year: 2026, month: 11, prevLastCode: "", nextFirstEntry: null, master: {}, holidays: [],
    entries: { "2026-11-09": { code: "2001", memo: "10:00-23:00" }, "2026-11-10": { code: "2000", memo: "１０：００―" }, "2026-11-11": { code: "2004", memo: "" } },
  });
  const out = splitDayEvents(plan.events, {});
  assertEquals(out.map((e) => [e.title, e.description, e.second?.startMin, e.second?.endMin]), [
    ["2001", "10:00-23:00", 600, 1380],
    ["2000", "１０：００―", 600, 660],
    ["2004", "", undefined, undefined],
  ]);
});

Deno.test("手入力の「〜」「-」「非番」「休」は、メモが時間でも1件のまま(泊の翌日に手で入れた非番)", () => {
  const ev = (title: string) => ({ date: "2026-11-10", calendar: "work", kind: "day", title, description: "9:30" });
  const out = splitDayEvents(["〜", "～", "-", "ー", "非番", "明け", "公休", "年休", "2001"].map(ev), {});
  assertEquals(out.map((e) => e.second !== undefined), [false, false, false, false, false, false, false, false, true]);
  assertEquals(isOffTitle("-"), true);
  assertEquals(isOffTitle("201"), false);
});

Deno.test("手入力の非番・休みの判定: 記号だけ・「明」「明番」も非番。「休出」「休日出勤」など出勤を表すもの・駅名の「明石」は勤務なので分ける", () => {
  for (const t of ["→", "・", "×", "／", "…", "明", "明番", "非", "非番明け", "代休", "有休", "休み"]) assertEquals(isOffTitle(t), true, t);
  for (const t of ["休出", "休日出勤", "休日勤務", "休勤", "2001", "研修", "A1", "ー1", "非常勤", "明石", "有明2"]) assertEquals(isOffTitle(t), false, t);
  const ev = (title: string) => ({ date: "2026-11-10", calendar: "work", kind: "day", title, description: "9:00-17:00" });
  const out = splitDayEvents(["休出", "休日出勤", "明", "→"].map(ev), {});
  assertEquals(out.map((e) => e.second?.endMin), [1020, 1020, undefined, undefined]);
});

Deno.test("parseTimeRange: 区切りの「→」「から」も読む", () => {
  for (const s of ["10:00→23:00", "10:00から23:00", "10:00 から 23:00", "10:00⇒23:00", "10:00〰23:00", "10:00∼23:00"]) {
    assertEquals(parseTimeRange(s), { start: 600, end: 1380 }, s);
  }
  assertEquals(parseTimeRange("10:00から"), { start: 600, end: null });
});

Deno.test("カレンダーのエラー: 回数制限は403でも「混んでいます」(502)、権限の403は「共有設定を確認」(400)", () => {
  for (const reason of ["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded"]) {
    const e = calendarAccessError(new GoogleError(403, reason, "limit"), "勤務用カレンダー");
    assertEquals([e.status, e.code], [502, "calendar_error"]);
  }
  for (const [status, reason] of [[403, "requiredAccessLevel"], [404, "notFound"], [403, "forbidden"]] as const) {
    const e = calendarAccessError(new GoogleError(status, reason, "x"), "勤務用カレンダー");
    assertEquals([e.status, e.code], [400, "calendar_access"]);
  }
  // Google 側の設定の不備(API が無効・サービスアカウントの停止や鍵の失効)は、利用者の共有設定のせいにしない(L)
  for (const [status, reason, message] of [
    [403, "accessNotConfigured", "Google Calendar API has not been used in project 123 before or it is disabled"],
    [403, "forbidden", "Google Calendar API has not been used in project 1 before"],
    [403, "SERVICE_DISABLED", "x"],
    [401, "authError", "Invalid Credentials"],
  ] as const) {
    const e = calendarAccessError(new GoogleError(status, reason, message), "勤務用カレンダー");
    assertEquals([e.status, e.code], [503, "calendar_setup"], `${status} ${reason}`);
    assert(!e.message.includes("共有設定"));
    assertEquals(clearsVerification(e), false); // 検証済みは外さない
  }
  assertEquals(calendarAccessError(new GoogleError(429, "rateLimitExceeded", "x"), "x").code, "calendar_error");
  assertEquals(calendarAccessError(new GoogleError(503, "", "x"), "x").code, "calendar_error");
});

Deno.test("接続テストの失敗: 検証済みを外すのは書けないとき(calendar_access)だけ。混雑・障害・通信エラーでは外さない", () => {
  assertEquals(clearsVerification(calendarAccessError(new GoogleError(403, "requiredAccessLevel", "x"), "x")), true);
  assertEquals(clearsVerification(calendarAccessError(new GoogleError(403, "rateLimitExceeded", "x"), "x")), false);
  assertEquals(clearsVerification(calendarAccessError(new GoogleError(500, "", "x"), "x")), false);
  assertEquals(clearsVerification(calendarAccessError(new TypeError("network"), "x")), false);
});

Deno.test("接続テスト: メインのカレンダー(メールアドレスの形)と primary は使えない。追加したカレンダーのIDは使える(P)", () => {
  for (const id of ["primary", "PRIMARY", " primary ", "taro@gmail.com", "Taro@Example.co.jp"]) assertEquals(isPrimaryCalendarId(id), true, id);
  for (const id of ["abc123@group.calendar.google.com", "ABC@group.calendar.google.com", "c_abc123", "primary2"]) assertEquals(isPrimaryCalendarId(id), false, id);
});

Deno.test("Google が応答しない・通信エラーのとき: 読む・消すは再試行し、作る(POST)は二重に作らないよう再試行しない", async () => {
  const saved = { ...retryPolicy, baseMs: [...retryPolicy.baseMs] };
  retryPolicy.baseMs = [1, 1, 1, 1, 1];
  try {
    for (const method of ["GET", "DELETE"]) {
      let tries = 0;
      globalThis.fetch = (input: string | URL | Request, _init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.host === "oauth2.googleapis.com") return Promise.resolve(Response.json({ access_token: "token", expires_in: 3600 }));
        tries++;
        if (tries <= 2) return Promise.reject(new DOMException("signal timed out", "TimeoutError"));
        return Promise.resolve(method === "GET" ? Response.json({ items: [] }) : new Response(null, { status: 204 }));
      };
      if (method === "GET") await listAppEvents({ work: "w", holiday: "" }, 2026, 10);
      else await deleteAppEvents({ work: "w", holiday: "" }, 2026, 10, { existing: [{ calendarId: "w", eventId: "x", date: "2026-10-05", tag: "day" }] });
      assertEquals(tries, 3, method);
    }
    // POST: 1回で失敗(二重に作らない)。画面には「操作に失敗しました」(502 calendar_error)
    let posts = 0;
    globalThis.fetch = (input: string | URL | Request, _init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.host === "oauth2.googleapis.com") return Promise.resolve(Response.json({ access_token: "token", expires_in: 3600 }));
      posts++;
      return Promise.reject(new DOMException("signal timed out", "TimeoutError"));
    };
    const err = await assertRejects(
      () => createEvents({ work: "w", holiday: "" }, [{ date: "2026-10-01", calendar: "work", kind: "day", title: "201", description: "" }]),
      AppError,
    ) as AppError;
    assertEquals([posts, err.code], [1, "calendar_error"]);
  } finally {
    retryPolicy.baseMs = saved.baseMs;
  }
});

Deno.test("Google の鍵の失効など(トークンが取れない 4xx)は、再試行せずに「管理者に連絡」(503 calendar_setup)にする(S3)", async () => {
  resetGoogleCacheForTest();
  let tokenCalls = 0;
  let apiCalls = 0;
  globalThis.fetch = (input: string | URL | Request, _init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host === "oauth2.googleapis.com") {
      tokenCalls++;
      return Promise.resolve(Response.json({ error: "invalid_grant" }, { status: 400 }));
    }
    apiCalls++;
    return Promise.resolve(Response.json({ items: [] }));
  };
  const started = Date.now();
  try {
    const err = await assertRejects(() => listAppEvents({ work: "w", holiday: "" }, 2026, 10), AppError) as AppError;
    assertEquals([err.status, err.code, tokenCalls, apiCalls], [503, "calendar_setup", 1, 0]);
    assert(Date.now() - started < 1000);
  } finally {
    resetGoogleCacheForTest();
  }
});

Deno.test("Google の鍵の中身が壊れているときも、再試行せずに「管理者に連絡」(503 calendar_setup)にする(T2)", async () => {
  const saved = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON")!;
  Deno.env.set(
    "GOOGLE_SERVICE_ACCOUNT_JSON",
    JSON.stringify({ client_email: "sa@example.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\nbm90IGEga2V5\n-----END PRIVATE KEY-----\n" }),
  );
  resetGoogleCacheForTest();
  let fetchCalls = 0;
  globalThis.fetch = () => {
    fetchCalls++;
    return Promise.resolve(Response.json({ items: [] }));
  };
  const started = Date.now();
  try {
    const err = await assertRejects(() => listAppEvents({ work: "w", holiday: "" }, 2026, 10), AppError) as AppError;
    assertEquals([err.status, err.code, fetchCalls], [503, "calendar_setup", 0]);
    assert(Date.now() - started < 1000);
  } finally {
    Deno.env.set("GOOGLE_SERVICE_ACCOUNT_JSON", saved);
    resetGoogleCacheForTest();
  }
});

Deno.test("年月・入力の件数の 400 には code が付く(画面が「保存の前に止まった」と分かる。S23)", () => {
  const codeOf = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return (e as AppError).code;
    }
  };
  assertEquals(codeOf(() => yearMonthOf({ year: 1999, month: 1 })), "bad_period");
  assertEquals(codeOf(() => entriesFrom({ entries: Object.fromEntries(Array.from({ length: 63 }, (_, i) => [String(i), {}])) })), "bad_entries");
});
