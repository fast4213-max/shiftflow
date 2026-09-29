// ログイン・新規登録・管理者ログインの本体。
// Edge Function の入口(index.ts)から呼ぶ。偽の Supabase を渡してテストできるよう、クライアントは引数で受け取る。

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  ADMIN_EMAIL,
  emailFor,
  passwordFor,
  randomPassword,
  safeEqual,
  validateEmployeeNo,
  validateName,
  validatePin,
} from "./accounts.ts";
import { assertNotLocked, clearFailures, recordFailure } from "./attempts.ts";
import { AppError } from "./http.ts";

export type Session = { access_token: string; refresh_token: string };
type Deps = { admin: SupabaseClient; anon: SupabaseClient };

async function signIn(anon: SupabaseClient, email: string, password: string): Promise<Session | null> {
  const { data, error } = await anon.auth.signInWithPassword({ email, password });
  if (error || !data.session) return null;
  return { access_token: data.session.access_token, refresh_token: data.session.refresh_token };
}

// 同じメールのユーザーを探す(登録の途中で失敗して残ったユーザーの後始末用)
async function findUserByEmail(admin: SupabaseClient, email: string): Promise<{ id: string } | null> {
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const found = data.users.find((u) => (u.email || "").toLowerCase() === email);
    if (found) return { id: found.id };
    if (data.users.length < 200) break;
  }
  return null;
}

// 社員番号 + PIN でログインする
export async function loginWithPin({ admin, anon }: Deps, body: Record<string, unknown>): Promise<Session> {
  const employeeNo = validateEmployeeNo(body.employee_no);
  const pin = validatePin(body.pin);
  const key = `emp:${employeeNo}`;

  await assertNotLocked(admin, key);
  const session = await signIn(anon, emailFor(employeeNo), passwordFor(pin));
  if (!session) {
    await recordFailure(admin, key);
    throw new AppError(401, "社員番号かPINが違います。まだ登録していない場合は「新規登録」から登録してください。", "bad_credentials");
  }
  await clearFailures(admin, key);
  return session;
}

// 新規登録(共通パスワードを確かめてから作る)。登録したらすぐ使える
export async function signUp({ admin }: { admin: SupabaseClient }, body: Record<string, unknown>, ip: string) {
  const employeeNo = validateEmployeeNo(body.employee_no);
  const familyName = validateName(body.family_name, "名字");
  const givenName = validateName(body.given_name, "名前");
  const pin = validatePin(body.pin);
  const shared = String(body.shared_password ?? "");
  if (!shared) throw new AppError(400, "共通パスワードを入力してください。", "bad_shared_password");

  const key = `signup:${ip}`;
  await assertNotLocked(admin, key);
  const { data: check, error: checkError } = await admin.rpc("check_signup_password", { p_password: shared });
  if (checkError) throw checkError;
  if (check === "not_set") {
    throw new AppError(503, "登録の受付をまだ開始していません。管理者に連絡してください。", "signup_closed");
  }
  if (check !== "ok") {
    await recordFailure(admin, key);
    throw new AppError(403, "共通パスワードが違います。", "bad_shared_password");
  }
  await clearFailures(admin, key);

  const { data: existing, error: existingError } = await admin
    .from("profiles").select("user_id").eq("employee_no", employeeNo).maybeSingle();
  if (existingError) throw existingError;
  if (existing) {
    throw new AppError(409, "この社員番号はすでに登録されています。ログインしてください。PINを忘れたときは管理者に連絡してください。", "already_registered");
  }

  const email = emailFor(employeeNo);
  let userId: string;
  const created = await admin.auth.admin.createUser({ email, password: passwordFor(pin), email_confirm: true });
  if (created.error || !created.data.user) {
    // 前回の登録が途中で止まって、ユーザーだけ残っている場合はそれを使う(プロフィールが無い = 誰も登録していない)
    const left = await findUserByEmail(admin, email);
    if (!left) throw created.error ?? new Error("ユーザーを作れませんでした");
    const updated = await admin.auth.admin.updateUserById(left.id, { password: passwordFor(pin), email_confirm: true });
    if (updated.error) throw updated.error;
    userId = left.id;
  } else {
    userId = created.data.user.id;
  }

  const { error: profileError } = await admin.from("profiles").insert({
    user_id: userId,
    employee_no: employeeNo,
    family_name: familyName,
    given_name: givenName,
  });
  if (profileError) {
    await admin.auth.admin.deleteUser(userId);
    throw profileError;
  }
  return { ok: true };
}

// 管理用パスワードでログインする。パスワードは Edge Function のシークレット ADMIN_PASSWORD
export async function adminLogin(
  { admin, anon }: Deps,
  body: Record<string, unknown>,
  secret: string | undefined,
): Promise<Session> {
  if (!secret || secret.length < 12) {
    throw new AppError(503, "管理用パスワードが設定されていません(12文字以上)。README の手順でシークレット ADMIN_PASSWORD を設定してください。", "admin_not_set");
  }
  const key = "admin";
  await assertNotLocked(admin, key);
  if (!(await safeEqual(String(body.password ?? ""), secret))) {
    await recordFailure(admin, key);
    throw new AppError(401, "パスワードが違います。", "bad_credentials");
  }
  await clearFailures(admin, key);

  // 管理用ユーザーを用意する(初回に作る)
  let userId: string | null = null;
  const { data: profile, error: profileError } = await admin
    .from("profiles").select("user_id").eq("role", "admin").maybeSingle();
  if (profileError) throw profileError;
  userId = profile?.user_id ?? null;

  if (!userId) {
    const created = await admin.auth.admin.createUser({ email: ADMIN_EMAIL, password: randomPassword(), email_confirm: true });
    if (created.error || !created.data.user) {
      const left = await findUserByEmail(admin, ADMIN_EMAIL);
      if (!left) throw created.error ?? new Error("管理用ユーザーを作れませんでした");
      userId = left.id;
    } else {
      userId = created.data.user.id;
    }
    const { error } = await admin.from("profiles").insert({ user_id: userId, role: "admin" });
    if (error) throw error;
  }

  // ログインのたびに使い捨てのパスワードに変えて、そのパスワードでサインインする
  const password = randomPassword();
  const updated = await admin.auth.admin.updateUserById(userId, { password, email_confirm: true });
  if (updated.error) throw updated.error;
  const session = await signIn(anon, ADMIN_EMAIL, password);
  if (!session) throw new Error("管理用ユーザーでログインできませんでした");
  return session;
}
