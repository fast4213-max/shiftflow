// ログインの確認(requireMember の中身)のテスト。Supabase は偽物。
//   deno test supabase/functions --allow-read --allow-env

import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.117.2";
import { isTransientAuthError, key, memberFromToken } from "./auth.ts";
import { AppError, entriesFrom } from "./http.ts";

function fakeAdmin(opts: {
  userError?: { status?: number; name?: string; message: string } | null;
  user?: { id: string } | null;
  profile?: { employee_no: string | null; role: string } | null;
  profileError?: { code: string } | null;
}) {
  return {
    auth: {
      getUser: () =>
        Promise.resolve({
          data: { user: opts.userError ? null : opts.user === undefined ? { id: "u1" } : opts.user },
          error: opts.userError ?? null,
        }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve({
              data: opts.profile === undefined ? { employee_no: "1234567", role: "user" } : opts.profile,
              error: opts.profileError ?? null,
            }),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

async function codeOf(p: Promise<unknown>): Promise<[number, string]> {
  const err = await assertRejects(() => p, AppError) as AppError;
  return [err.status, err.code];
}

Deno.test("一時的な Auth の障害は、ログイン切れ(401)にしない(A)", async () => {
  for (const userError of [
    { status: 503, message: "unavailable" },
    { status: 502, message: "bad gateway" },
    { status: 429, message: "rate limit" },
    { status: 0, name: "AuthRetryableFetchError", message: "fetch failed" },
    { name: "AuthRetryableFetchError", message: "fetch failed" },
  ]) {
    assertEquals(await codeOf(memberFromToken(fakeAdmin({ userError }), "t")), [503, "auth_unavailable"], JSON.stringify(userError));
  }
});

Deno.test("本当にログインが無いとき(トークン無効・セッションなし)は 401", async () => {
  for (const userError of [
    { status: 401, message: "invalid JWT" },
    { status: 403, message: "session_not_found" },
    { status: 400, message: "bad" },
  ]) {
    assertEquals(await codeOf(memberFromToken(fakeAdmin({ userError }), "t")), [401, "unauthenticated"]);
  }
  assertEquals(await codeOf(memberFromToken(fakeAdmin({ user: null }), "t")), [401, "unauthenticated"]);
});

Deno.test("プロフィールが無ければ 403(not_member)。DB の一時的な障害は 503(ログインを消さない)", async () => {
  assertEquals(await codeOf(memberFromToken(fakeAdmin({ profile: null }), "t")), [403, "not_member"]);
  assertEquals(await codeOf(memberFromToken(fakeAdmin({ profileError: { code: "57P01" } }), "t")), [503, "auth_unavailable"]);
});

Deno.test("ログイン中なら、利用者の情報を返す(管理者も見分ける)", async () => {
  const user = await memberFromToken(fakeAdmin({}), "t");
  assertEquals([user.userId, user.employeeNo, user.isAdmin], ["u1", "1234567", false]);
  const admin = await memberFromToken(fakeAdmin({ profile: { employee_no: null, role: "admin" } }), "t");
  assertEquals([admin.employeeNo, admin.isAdmin], [null, true]);
  assertEquals(isTransientAuthError(null), false);
});

Deno.test("登録の入力(entries): 無い・配列・文字は 400。空のオブジェクトと日付の対応は通す", () => {
  for (const bad of [undefined, null, [], "x", 5, true]) {
    let err: AppError | null = null;
    try {
      entriesFrom({ entries: bad });
    } catch (e) {
      err = e as AppError;
    }
    assertEquals([err?.status, err?.code], [400, "bad_entries"], String(bad));
  }
  assertEquals(entriesFrom({ entries: {} }), {});
  assertEquals(entriesFrom({ entries: { "2026-10-01": { code: "101" } } }), { "2026-10-01": { code: "101" } });
  const many = Object.fromEntries(Array.from({ length: 63 }, (_, i) => [String(i), {}]));
  let tooMany: AppError | null = null;
  try {
    entriesFrom({ entries: many });
  } catch (e) {
    tooMany = e as AppError;
  }
  assertEquals(tooMany?.status, 400);
});

Deno.test("鍵: 新方式(SUPABASE_*_KEYS)を優先し、無ければ旧方式を使う(R2)", () => {
  const names = ["TEST_NEW_KEYS", "TEST_OLD_KEY"];
  const saved = names.map((n) => Deno.env.get(n));
  try {
    Deno.env.set("TEST_OLD_KEY", "old");
    assertEquals(key("TEST_OLD_KEY", "TEST_NEW_KEYS"), "old");
    Deno.env.set("TEST_NEW_KEYS", JSON.stringify({ default: "new" }));
    assertEquals(key("TEST_OLD_KEY", "TEST_NEW_KEYS"), "new");
    Deno.env.set("TEST_NEW_KEYS", JSON.stringify({ a: "first" }));
    assertEquals(key("TEST_OLD_KEY", "TEST_NEW_KEYS"), "first");
    Deno.env.set("TEST_NEW_KEYS", "plain-key");
    assertEquals(key("TEST_OLD_KEY", "TEST_NEW_KEYS"), "plain-key");
    Deno.env.set("TEST_NEW_KEYS", "{}");
    assertEquals(key("TEST_OLD_KEY", "TEST_NEW_KEYS"), "old");
    Deno.env.delete("TEST_OLD_KEY");
    let err = "";
    try {
      key("TEST_OLD_KEY", "TEST_NEW_KEYS");
    } catch (e) {
      err = (e as Error).message;
    }
    assertEquals(err.includes("TEST_NEW_KEYS"), true);
  } finally {
    names.forEach((n, i) => (saved[i] === undefined ? Deno.env.delete(n) : Deno.env.set(n, saved[i]!)));
  }
});
