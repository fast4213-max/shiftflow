// ログイン・新規登録・管理者ログインのテスト(Supabase は偽物に差し替える)
//   deno test supabase/functions --allow-read --allow-env

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { adminLogin, changePin, loginWithPin, resetPin, sessionIdOf, signUp } from "./login-core.ts";
import { AppError } from "./http.ts";
import { emailFor, passwordFor, randomPin, toHalfWidth } from "./accounts.ts";

type User = { id: string; email: string; password: string };
type Profile = { user_id: string; employee_no: string | null; role: string; family_name?: string; given_name?: string };

// 最小限の偽物: DB の関数(rpc)、profiles、Supabase Auth のユーザー
// racingSignUp: 同じ社員番号の登録が同時に進んでいる(社員番号の確認の時点では、相手のプロフィールがまだ見えない)
// authStatus: Supabase Auth のサインインが、この HTTP ステータスで失敗する(429 = 回数の制限、5xx = 障害)
// failRevoke: ログイン状態(セッション)を消す DB の関数が失敗する
function fakes(
  opts: {
    sharedPassword?: string | null;
    failProfileInsert?: boolean;
    racingSignUp?: boolean;
    authStatus?: number;
    failRevoke?: boolean;
  } = {},
) {
  const attempts = new Map<string, { count: number; lockedUntil: number | null }>();
  const users: User[] = [];
  const profiles: Profile[] = [];
  // ログイン状態(Supabase Auth のセッション)
  const sessions: { id: string; userId: string }[] = [];
  const shared = opts.sharedPassword === undefined ? "kyotsu-pass-1" : opts.sharedPassword;
  let seq = 0;

  const admin = {
    rpc(name: string, args: Record<string, unknown>) {
      const key = String(args.p_key ?? "");
      const a = attempts.get(key);
      switch (name) {
        case "auth_attempt_locked_until":
          return Promise.resolve({ data: a?.lockedUntil && a.lockedUntil > Date.now() ? new Date(a.lockedUntil).toISOString() : null, error: null });
        case "auth_attempt_fail": {
          const cur = a ?? { count: 0, lockedUntil: null };
          cur.count++;
          attempts.set(key, cur);
          if (cur.count >= Number(args.p_max)) {
            cur.count = 0;
            cur.lockedUntil = Date.now() + Number(args.p_minutes) * 60000;
            return Promise.resolve({ data: new Date(cur.lockedUntil).toISOString(), error: null });
          }
          return Promise.resolve({ data: null, error: null });
        }
        case "auth_attempt_reset":
          attempts.delete(key);
          return Promise.resolve({ data: null, error: null });
        case "check_signup_password":
          return Promise.resolve({ data: shared === null ? "not_set" : args.p_password === shared ? "ok" : "wrong", error: null });
        case "revoke_user_sessions": {
          if (opts.failRevoke) return Promise.resolve({ data: null, error: new Error("permission denied for table sessions") });
          const before = sessions.length;
          for (let i = sessions.length - 1; i >= 0; i--) {
            if (sessions[i].userId === args.p_user_id && sessions[i].id !== args.p_keep_session) sessions.splice(i, 1);
          }
          return Promise.resolve({ data: before - sessions.length, error: null });
        }
      }
      throw new Error("unexpected rpc " + name);
    },
    from(table: string) {
      assertEquals(table, "profiles");
      const filters: [string, unknown][] = [];
      const builder = {
        select: () => builder,
        eq: (col: string, val: unknown) => (filters.push([col, val]), builder),
        maybeSingle: () => {
          if (opts.racingSignUp && filters.some(([c]) => c === "employee_no")) {
            return Promise.resolve({ data: null, error: null });
          }
          const row = profiles.find((p) => filters.every(([c, v]) => (p as Record<string, unknown>)[c] === v));
          return Promise.resolve({ data: row ?? null, error: null });
        },
        insert: (row: Profile) => {
          if (opts.failProfileInsert) return Promise.resolve({ error: new Error("insert failed") });
          profiles.push(row);
          return Promise.resolve({ error: null });
        },
      };
      return builder;
    },
    auth: {
      admin: {
        createUser({ email, password }: { email: string; password: string }) {
          if (users.some((u) => u.email === email)) return Promise.resolve({ data: { user: null }, error: new Error("already registered") });
          const user = { id: `id-${++seq}`, email, password };
          users.push(user);
          return Promise.resolve({ data: { user }, error: null });
        },
        updateUserById(id: string, attrs: { password?: string }) {
          const u = users.find((x) => x.id === id)!;
          if (attrs.password) u.password = attrs.password;
          return Promise.resolve({ data: { user: u }, error: null });
        },
        deleteUser(id: string) {
          const i = users.findIndex((x) => x.id === id);
          if (i >= 0) users.splice(i, 1);
          return Promise.resolve({ data: null, error: null });
        },
        listUsers() {
          return Promise.resolve({ data: { users }, error: null });
        },
      },
    },
  };

  // Supabase Auth のエラー(supabase-js の AuthApiError と同じく status を持つ)
  const authError = (status: number, message: string) => Object.assign(new Error(message), { status });
  const anon = {
    auth: {
      signInWithPassword({ email, password }: { email: string; password: string }) {
        if (opts.authStatus) {
          return Promise.resolve({ data: { session: null }, error: authError(opts.authStatus, "Request rate limit reached") });
        }
        const u = users.find((x) => x.email === email && x.password === password);
        if (!u) return Promise.resolve({ data: { session: null }, error: authError(400, "Invalid login credentials") });
        // 本物と同じく、アクセストークン(JWT)の中にセッションIDを入れる
        const sid = `s-${++seq}`;
        sessions.push({ id: sid, userId: u.id });
        const payload = btoa(JSON.stringify({ sub: u.id, session_id: sid })).replace(/=+$/, "");
        return Promise.resolve({ data: { session: { access_token: `at-${u.id}.${payload}.sig`, refresh_token: `rt-${u.id}` } }, error: null });
      },
    },
  };

  return {
    deps: { admin: admin as unknown as SupabaseClient, anon: anon as unknown as SupabaseClient },
    users,
    profiles,
    attempts,
    sessions,
  };
}

const reg = {
  employee_no: "1234567",
  family_name: "山田",
  given_name: "太郎",
  pin: "4829",
  shared_password: "kyotsu-pass-1",
};

async function code(fn: () => Promise<unknown>): Promise<string> {
  const err = await assertRejects(fn, AppError);
  return err.code;
}

Deno.test("PIN/社員番号の補助: 全角の数字を半角にする・仮のPINは4桁", () => {
  assertEquals(toHalfWidth(" １２３４５６７ "), "1234567");
  assertEquals(emailFor("1234567"), "1234567@users.shiftflow.invalid");
  assert(/^\d{4}$/.test(randomPin()));
});

Deno.test("新規登録 → その社員番号+PINでログインできる", async () => {
  const f = fakes();
  await signUp(f.deps, reg, "1.2.3.4");
  assertEquals(f.profiles.length, 1);
  assertEquals(f.profiles[0].employee_no, "1234567");
  assertEquals(f.profiles[0].family_name, "山田");
  const session = await loginWithPin(f.deps, { employee_no: "1234567", pin: "4829" });
  assert(session.access_token.startsWith("at-id-1."));
  // 全角でもログインできる
  await loginWithPin(f.deps, { employee_no: "１２３４５６７", pin: "４８２９" });
});

Deno.test("新規登録: 入力チェック", async () => {
  const f = fakes();
  assertEquals(await code(() => signUp(f.deps, { ...reg, employee_no: "12345" }, "ip")), "bad_employee_no");
  assertEquals(await code(() => signUp(f.deps, { ...reg, employee_no: "abcdefg" }, "ip")), "bad_employee_no");
  assertEquals(await code(() => signUp(f.deps, { ...reg, family_name: "  " }, "ip")), "bad_name");
  assertEquals(await code(() => signUp(f.deps, { ...reg, given_name: "あ".repeat(31) }, "ip")), "bad_name");
  assertEquals(await code(() => signUp(f.deps, { ...reg, pin: "123" }, "ip")), "bad_pin");
  assertEquals(await code(() => signUp(f.deps, { ...reg, pin: "123a" }, "ip")), "bad_pin");
  assertEquals(await code(() => signUp(f.deps, { ...reg, shared_password: "" }, "ip")), "bad_shared_password");
  assertEquals(f.users.length, 0);
});

Deno.test("新規登録: 共通パスワードが未設定なら受け付けない / 違えば拒否", async () => {
  const closed = fakes({ sharedPassword: null });
  assertEquals(await code(() => signUp(closed.deps, reg, "ip")), "signup_closed");
  assertEquals(closed.users.length, 0);

  const f = fakes();
  assertEquals(await code(() => signUp(f.deps, { ...reg, shared_password: "wrong" }, "ip")), "bad_shared_password");
  assertEquals(f.users.length, 0);
});

Deno.test("新規登録: 共通パスワードを5回間違えるとそのIPはロックされ、正しくても通らない", async () => {
  const f = fakes();
  for (let i = 0; i < 4; i++) {
    assertEquals(await code(() => signUp(f.deps, { ...reg, shared_password: "wrong" }, "9.9.9.9")), "bad_shared_password");
  }
  assertEquals(await code(() => signUp(f.deps, { ...reg, shared_password: "wrong" }, "9.9.9.9")), "locked");
  assertEquals(await code(() => signUp(f.deps, reg, "9.9.9.9")), "locked");
  // 別のIPは影響を受けない
  await signUp(f.deps, reg, "8.8.8.8");
  assertEquals(f.profiles.length, 1);
});

Deno.test("新規登録: 同じ社員番号は二重に登録できない", async () => {
  const f = fakes();
  await signUp(f.deps, reg, "ip");
  assertEquals(await code(() => signUp(f.deps, { ...reg, pin: "1111" }, "ip")), "already_registered");
  // 元のPINのまま(乗っ取られない)
  await loginWithPin(f.deps, { employee_no: "1234567", pin: "4829" });
  assertEquals(await code(() => loginWithPin(f.deps, { employee_no: "1234567", pin: "1111" })), "bad_credentials");
});

Deno.test("新規登録: プロフィールの作成に失敗したらユーザーも消す", async () => {
  const f = fakes({ failProfileInsert: true });
  await assertRejects(() => signUp(f.deps, reg, "ip"));
  assertEquals(f.users.length, 0);
});

Deno.test("新規登録: 前回の途中で止まってユーザーだけ残っていたら、消して作り直して登録できる", async () => {
  const f = fakes();
  f.users.push({ id: "left-over", email: emailFor("1234567"), password: passwordFor("0000") });
  await signUp(f.deps, reg, "ip");
  // 残っていたユーザーは使わない(そのユーザーのログイン状態を引き継がせない)
  assertEquals(f.users.map((u) => u.id), [f.profiles[0].user_id]);
  assert(f.profiles[0].user_id !== "left-over");
  await loginWithPin(f.deps, { employee_no: "1234567", pin: "4829" });
  assertEquals(await code(() => loginWithPin(f.deps, { employee_no: "1234567", pin: "0000" })), "bad_credentials");
});

Deno.test("新規登録: 同時に同じ社員番号で登録されても、先に登録できた人のPINを変えたり消したりしない", async () => {
  const f = fakes({ racingSignUp: true });
  f.users.push({ id: "first", email: emailFor("1234567"), password: passwordFor("4829") });
  f.profiles.push({ user_id: "first", employee_no: "1234567", role: "user", family_name: "山田", given_name: "太郎" });
  assertEquals(await code(() => signUp(f.deps, { ...reg, pin: "1111" }, "ip")), "already_registered");
  assertEquals(f.users.length, 1);
  await loginWithPin(f.deps, { employee_no: "1234567", pin: "4829" });
});

Deno.test("ログイン: 登録が無い・PINが違うと弾く。形式の間違いは失敗に数えない", async () => {
  const f = fakes();
  await signUp(f.deps, reg, "ip");
  assertEquals(await code(() => loginWithPin(f.deps, { employee_no: "7654321", pin: "4829" })), "bad_credentials");
  assertEquals(await code(() => loginWithPin(f.deps, { employee_no: "1234567", pin: "0000" })), "bad_credentials");
  for (let i = 0; i < 10; i++) {
    assertEquals(await code(() => loginWithPin(f.deps, { employee_no: "1234567", pin: "12" })), "bad_pin");
  }
  // まだロックされていない
  await loginWithPin(f.deps, { employee_no: "1234567", pin: "4829" });
});

Deno.test("ログイン: 5回間違えるとその社員番号は15分ロック。正しいPINでもロック中は入れない", async () => {
  const f = fakes();
  await signUp(f.deps, reg, "ip");
  for (let i = 0; i < 4; i++) {
    assertEquals(await code(() => loginWithPin(f.deps, { employee_no: "1234567", pin: "0000" })), "bad_credentials");
  }
  assertEquals(await code(() => loginWithPin(f.deps, { employee_no: "1234567", pin: "0000" })), "locked");
  assertEquals(await code(() => loginWithPin(f.deps, { employee_no: "1234567", pin: "4829" })), "locked");
  // 別の社員番号には影響しない
  await signUp(f.deps, { ...reg, employee_no: "2345678" }, "ip2");
  await loginWithPin(f.deps, { employee_no: "2345678", pin: "4829" });
});

Deno.test("ログイン: Supabase Auth の回数の制限・障害は、PINの間違いとして数えない(ロックしない)", async () => {
  for (const status of [429, 500, 503]) {
    const f = fakes();
    await signUp(f.deps, reg, "ip");
    const down = fakes({ authStatus: status });
    // 同じ利用者・同じ失敗回数の記録を使い、Auth だけが失敗する状態にする
    const deps = { admin: f.deps.admin, anon: down.deps.anon };
    for (let i = 0; i < 6; i++) {
      assertEquals(await code(() => loginWithPin(deps, { employee_no: "1234567", pin: "4829" })), "auth_unavailable");
    }
    assertEquals(f.attempts.size, 0);
    // Auth が戻れば、すぐ入れる
    await loginWithPin(f.deps, { employee_no: "1234567", pin: "4829" });
  }
});

Deno.test("管理者ログイン: Supabase Auth が使えないときは、分かるエラーにする", async () => {
  const f = fakes();
  const secret = "admin-secret-1234";
  await adminLogin(f.deps, { password: secret }, secret);
  const down = fakes({ authStatus: 429 });
  assertEquals(await code(() => adminLogin({ admin: f.deps.admin, anon: down.deps.anon }, { password: secret }, secret)), "auth_unavailable");
});

Deno.test("ログイン: 成功すると失敗回数が0に戻る", async () => {
  const f = fakes();
  await signUp(f.deps, reg, "ip");
  for (let i = 0; i < 4; i++) await code(() => loginWithPin(f.deps, { employee_no: "1234567", pin: "0000" }));
  await loginWithPin(f.deps, { employee_no: "1234567", pin: "4829" });
  for (let i = 0; i < 4; i++) {
    assertEquals(await code(() => loginWithPin(f.deps, { employee_no: "1234567", pin: "0000" })), "bad_credentials");
  }
});

Deno.test("管理者ログイン: パスワード未設定・短すぎると使えない", async () => {
  const f = fakes();
  assertEquals(await code(() => adminLogin(f.deps, { password: "x" }, undefined)), "admin_not_set");
  assertEquals(await code(() => adminLogin(f.deps, { password: "short" }, "short")), "admin_not_set");
});

Deno.test("管理者ログイン: 正しいパスワードでセッションが返り、管理用ユーザーは1人だけ作られる", async () => {
  const f = fakes();
  const secret = "admin-secret-1234";
  const s1 = await adminLogin(f.deps, { password: secret }, secret);
  assert(s1.access_token);
  assertEquals(f.profiles.filter((p) => p.role === "admin").length, 1);
  assertEquals(f.profiles[0].employee_no, undefined);
  await adminLogin(f.deps, { password: secret }, secret);
  assertEquals(f.users.length, 1);
  assertEquals(f.profiles.length, 1);
});

Deno.test("管理者ログイン: 違うパスワードは弾き、5回でロック", async () => {
  const f = fakes();
  const secret = "admin-secret-1234";
  for (let i = 0; i < 4; i++) assertEquals(await code(() => adminLogin(f.deps, { password: "nope" }, secret)), "bad_credentials");
  assertEquals(await code(() => adminLogin(f.deps, { password: "nope" }, secret)), "locked");
  assertEquals(await code(() => adminLogin(f.deps, { password: secret }, secret)), "locked");
  assertEquals(f.users.length, 0);
});

Deno.test("管理者ログイン: 管理用ユーザーだけ残っていてもプロフィールを作り直して入れる", async () => {
  const f = fakes();
  const secret = "admin-secret-1234";
  f.users.push({ id: "left-admin", email: "admin@admin.shiftflow.invalid", password: "old" });
  const s = await adminLogin(f.deps, { password: secret }, secret);
  assert(s.access_token.startsWith("at-left-admin."));
  assertEquals(f.profiles[0].user_id, "left-admin");
});

Deno.test("セッションID: アクセストークン(JWT)から取り出す。読めなければ null", () => {
  const payload = btoa(JSON.stringify({ session_id: "abc-123" })).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  assertEquals(sessionIdOf(`h.${payload}.s`), "abc-123");
  assertEquals(sessionIdOf("not-a-jwt"), null);
  assertEquals(sessionIdOf("h.@@@.s"), null);
});

Deno.test("PINの変更: 今のPINが正しければ変わり、新しいPINのログインだけが残る(ほかの端末・確かめたときのログインは消える)", async () => {
  const f = fakes();
  await signUp(f.deps, reg, "1.1.1.1");
  const phone = await loginWithPin(f.deps, { employee_no: reg.employee_no, pin: reg.pin });
  await loginWithPin(f.deps, { employee_no: reg.employee_no, pin: reg.pin }); // ほかの端末
  const userId = f.users[0].id;
  const result = await changePin(f.deps, { userId, employeeNo: reg.employee_no }, { current_pin: reg.pin, new_pin: "１１１１" });
  assertEquals(result.sessionsCleared, true);
  assertEquals(f.sessions.map((s) => s.id), [sessionIdOf(result.session.access_token)]);
  assert(sessionIdOf(phone.access_token) !== sessionIdOf(result.session.access_token));
  // 新しいPINで入れて、前のPINでは入れない
  await loginWithPin(f.deps, { employee_no: reg.employee_no, pin: "1111" });
  assertEquals(await code(() => loginWithPin(f.deps, { employee_no: reg.employee_no, pin: reg.pin })), "bad_credentials");
});

Deno.test("PINの変更: 今のPINが違えば変えない・ログインも消さない。5回でロック", async () => {
  const f = fakes();
  await signUp(f.deps, reg, "1.1.1.1");
  await loginWithPin(f.deps, { employee_no: reg.employee_no, pin: reg.pin });
  const user = { userId: f.users[0].id, employeeNo: reg.employee_no };
  assertEquals(await code(() => changePin(f.deps, user, { current_pin: "0000", new_pin: "1111" })), "bad_credentials");
  assertEquals(f.sessions.length, 1);
  assertEquals(f.users[0].password, passwordFor(reg.pin));
  for (let i = 0; i < 3; i++) await code(() => changePin(f.deps, user, { current_pin: "0000", new_pin: "1111" }));
  assertEquals(await code(() => changePin(f.deps, user, { current_pin: "0000", new_pin: "1111" })), "locked");
});

Deno.test("PINの再設定(管理者): 仮のPINで入れるようになり、その人のログインは全部消える。ほかの人のログインは残る", async () => {
  const f = fakes();
  await signUp(f.deps, reg, "1.1.1.1");
  await signUp(f.deps, { ...reg, employee_no: "7654321" }, "1.1.1.1");
  await loginWithPin(f.deps, { employee_no: reg.employee_no, pin: reg.pin });
  await loginWithPin(f.deps, { employee_no: reg.employee_no, pin: reg.pin });
  await loginWithPin(f.deps, { employee_no: "7654321", pin: reg.pin });
  // 間違えてロック寸前の状態も消える
  for (let i = 0; i < 4; i++) await code(() => loginWithPin(f.deps, { employee_no: reg.employee_no, pin: "0000" }));
  const target = f.users.find((u) => u.email === emailFor(reg.employee_no))!;
  const result = await resetPin(f.deps.admin, { user_id: target.id, employee_no: reg.employee_no });
  assertEquals(result.sessionsCleared, true);
  assert(/^\d{4}$/.test(result.pin));
  assertEquals(f.sessions.filter((s) => s.userId === target.id).length, 0);
  assertEquals(f.sessions.filter((s) => s.userId !== target.id).length, 1);
  assertEquals(f.attempts.has(`emp:${reg.employee_no}`), false);
  await loginWithPin(f.deps, { employee_no: reg.employee_no, pin: result.pin });
});

Deno.test("PINの再設定・変更: ログインを消せなかったときも、PINは変わる(画面で知らせる)", async () => {
  const f = fakes({ failRevoke: true });
  await signUp(f.deps, reg, "1.1.1.1");
  await loginWithPin(f.deps, { employee_no: reg.employee_no, pin: reg.pin });
  const target = f.users[0];
  const reset = await resetPin(f.deps.admin, { user_id: target.id, employee_no: reg.employee_no });
  assertEquals(reset.sessionsCleared, false);
  await loginWithPin(f.deps, { employee_no: reg.employee_no, pin: reset.pin });
  const changed = await changePin(f.deps, { userId: target.id, employeeNo: reg.employee_no }, { current_pin: reset.pin, new_pin: "2222" });
  assertEquals(changed.sessionsCleared, false);
  await loginWithPin(f.deps, { employee_no: reg.employee_no, pin: "2222" });
});

Deno.test("ログイン: PINが違うときの文に、保存した古いPINの案内が入る", async () => {
  const f = fakes();
  await signUp(f.deps, reg, "1.1.1.1");
  const err = await assertRejects(() => loginWithPin(f.deps, { employee_no: reg.employee_no, pin: "0000" }), AppError);
  assert(err.message.includes("古いPIN"));
});
