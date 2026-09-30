// カレンダー操作のテスト(Google への通信は偽物に差し替える)
//   deno test supabase/functions --allow-read --allow-env

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createEvents, deleteAppEvents } from "./shift-calendar.ts";
import { AppError } from "./http.ts";

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
  assertEquals(deleted, ["a", "b", "c", "h"]);
  assertEquals(count, 4);
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

Deno.test("レート制限は待って再試行する", async () => {
  let n = 0;
  const calls = mockFetch((c) => {
    if (c.method !== "POST") return;
    n++;
    if (n === 1) return Response.json({ error: { code: 403, errors: [{ reason: "rateLimitExceeded" }] } }, { status: 403 });
    return Response.json({ id: "ok" });
  });
  await createEvents({ work: "w", holiday: "h" }, [{ date: "2026-10-01", calendar: "work", kind: "day", title: "x", description: "" }]);
  assertEquals(calls.filter((c) => c.method === "POST").length, 2);
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
