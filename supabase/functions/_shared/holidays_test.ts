// 祝日の取り直しのテスト(Supabase・Google は偽物)
//   deno test supabase/functions --allow-read --allow-env

import { assert, assertEquals } from "jsr:@std/assert@1";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.117.2";
import { ensureHolidayYears } from "./holidays.ts";
import { retryPolicy } from "./google.ts";

// テスト用の使い捨て鍵でサービスアカウントを用意する(shift-calendar_test.ts と同じ)
const pair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
Deno.env.set(
  "GOOGLE_SERVICE_ACCOUNT_JSON",
  JSON.stringify({
    client_email: "sa@example.iam.gserviceaccount.com",
    private_key: `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8))}\n-----END PRIVATE KEY-----\n`,
  }),
);

const thisYear = new Date(Date.now() + 9 * 3600_000).getUTCFullYear();

function fakeAdmin(rows: { year: number; source: string; fetched_at: string }[]) {
  const writes: string[] = [];
  const admin = {
    from(table: string) {
      return {
        select: () => ({ in: () => Promise.resolve({ data: rows, error: null }) }),
        upsert: () => (writes.push(table), Promise.resolve({ error: null })),
        delete: () => ({ gte: () => ({ lte: () => ({ not: () => (writes.push(table + ":delete"), Promise.resolve({ error: null })) }) }) }),
      };
    },
  } as unknown as SupabaseClient;
  return { admin, writes };
}

function googleDown() {
  let calls = 0;
  globalThis.fetch = (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.host === "oauth2.googleapis.com") return Promise.resolve(Response.json({ access_token: "token", expires_in: 3600 }));
    calls++;
    return Promise.resolve(new Response("busy", { status: 503 }));
  };
  return () => calls;
}

Deno.test("祝日の取り直し(前回の分がある)が失敗しても、短い時間で諦めて前回の分を使う(登録の時間枠を使い込まない)", async () => {
  const saved = { baseMs: [...retryPolicy.baseMs], jitter: retryPolicy.jitter };
  retryPolicy.baseMs = [1500, 1500, 1500, 1500, 1500];
  retryPolicy.jitter = 0;
  try {
    const calls = googleDown();
    const old = new Date(Date.now() - 40 * 86400_000).toISOString(); // 30日より前(取り直す)
    const { admin, writes } = fakeAdmin([{ year: thisYear, source: "google", fetched_at: old }]);
    const t0 = Date.now();
    await ensureHolidayYears(admin, [thisYear]); // 例外にならない
    const ms = Date.now() - t0;
    assert(ms < 4500, `待ちすぎ: ${ms}ms`); // 区切らないと、1.5秒×5回=7.5秒待つ
    assert(calls() <= 3, `試行が多すぎ: ${calls()}`);
    assertEquals(writes, []); // 前回の分はそのまま
  } finally {
    retryPolicy.baseMs = saved.baseMs;
    retryPolicy.jitter = saved.jitter;
  }
});

Deno.test("祝日を初めて取る年が取れないときは、503(holiday_unavailable)", async () => {
  const saved = { baseMs: [...retryPolicy.baseMs], jitter: retryPolicy.jitter };
  retryPolicy.baseMs = [1, 1, 1, 1, 1];
  retryPolicy.jitter = 0;
  try {
    googleDown();
    const { admin } = fakeAdmin([]);
    let err: { status?: number; code?: string } | null = null;
    try {
      await ensureHolidayYears(admin, [thisYear]);
    } catch (e) {
      err = e as { status?: number; code?: string };
    }
    assertEquals([err?.status, err?.code], [503, "holiday_unavailable"]);
  } finally {
    retryPolicy.baseMs = saved.baseMs;
    retryPolicy.jitter = saved.jitter;
  }
});
