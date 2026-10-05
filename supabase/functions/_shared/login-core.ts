// ログイン・新規登録・管理者ログインの本体。
// Edge Function の入口(index.ts)から呼ぶ。偽の Supabase を渡してテストできるよう、クライアントは引数で受け取る。

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.117.2";
import {
  ADMIN_EMAIL,
  emailFor,
  passwordFor,
  randomPassword,
  randomPin,
  safeEqual,
  validateEmployeeNo,
  validateName,
  validatePin,
} from "./accounts.ts";
import { assertNotLocked, clearFailures, recordFailure } from "./attempts.ts";
import { AppError } from "./http.ts";

export type Session = { access_token: string; refresh_token: string };
type Deps = { admin: SupabaseClient; anon: SupabaseClient };

// パスワードでサインインする。社員番号・PINの間違い(Supabase Auth の 400 など)は null を返す。
// 混雑(429)や Supabase 側の障害・通信エラーは、PINが正しくても入れないので、間違いとして数えずにエラーにする
// (ログインは全員この関数から Supabase Auth を呼ぶので、Auth から見ると同じ接続元になり、回数の制限に一緒にかかる)
export async function signIn(anon: SupabaseClient, email: string, password: string): Promise<Session | null> {
  const { data, error } = await anon.auth.signInWithPassword({ email, password });
  if (error) {
    const status = error.status ?? 0;
    if (status >= 400 && status < 500 && status !== 429) return null;
    console.error("signIn failed", status, error.message);
    throw new AppError(503, "ただいまログインできません。少し待ってからもう一度お試しください。", "auth_unavailable");
  }
  if (!data.session) return null;
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

// アクセストークン(JWT)から、そのログインのセッションIDを取り出す(読めなければ null)
export function sessionIdOf(accessToken: string): string | null {
  try {
    const part = accessToken.split(".")[1] ?? "";
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "="));
    const id = JSON.parse(json).session_id;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

// その人のログイン状態(セッション)を消す。keepSessionId のセッションだけは残す。
// 消せなかったときは false を返す(PINの再設定・変更そのものは止めない。画面で知らせる)
export async function revokeSessions(admin: SupabaseClient, userId: string, keepSessionId: string | null): Promise<boolean> {
  const { error } = await admin.rpc("revoke_user_sessions", { p_user_id: userId, p_keep_session: keepSessionId });
  if (error) {
    console.error("revoke_user_sessions failed", error.message);
    return false;
  }
  return true;
}

// 自分のPINを変える(今のPINを確かめてから)。変えたら、新しいPINで入り直したログインを返し、
// それ以外のログイン(ほかの端末・今のPINを確かめたときのもの・この端末の前のログイン)は消す。
// PINを変えたあとに入り直せなかったとき(Supabase Auth の混雑など)は、エラーにしない(PINはもう変わっているので)。
// ログインを全部消して session: null を返し、画面は「新しいPINでログインし直してください」にする
export async function changePin(
  { admin, anon }: Deps,
  user: { userId: string; employeeNo: string },
  body: Record<string, unknown>,
): Promise<{ ok: true; session: Session | null; sessionsCleared: boolean }> {
  const current = validatePin(body.current_pin, "今のPIN");
  const next = validatePin(body.new_pin, "新しいPIN");
  const email = emailFor(user.employeeNo);

  const key = `emp:${user.employeeNo}`;
  await assertNotLocked(admin, key);
  if (!(await signIn(anon, email, passwordFor(current)))) {
    await recordFailure(admin, key);
    throw new AppError(401, "今のPINが違います。", "bad_credentials");
  }
  await clearFailures(admin, key);

  const { error: updateError } = await admin.auth.admin.updateUserById(user.userId, { password: passwordFor(next) });
  if (updateError) throw updateError;

  let session: Session | null = null;
  try {
    session = await signIn(anon, email, passwordFor(next));
  } catch (err) {
    console.error("sign in with the new PIN failed", err instanceof Error ? err.message : err);
  }
  if (!session) {
    return { ok: true, session: null, sessionsCleared: await revokeSessions(admin, user.userId, null) };
  }
  // 新しいログインのセッションIDが分からないときは、消すとこの端末まで出てしまうので消さない(画面で知らせる)
  const keep = sessionIdOf(session.access_token);
  if (!keep) {
    console.error("session_id not found in the access token");
    return { ok: true, session, sessionsCleared: false };
  }
  return { ok: true, session, sessionsCleared: await revokeSessions(admin, user.userId, keep) };
}

// 管理者が、利用者に仮のPINを発行する。その人のロック(失敗回数)と、ログイン状態(全部の端末)も消す
export async function resetPin(
  admin: SupabaseClient,
  target: { user_id: string; employee_no: string },
): Promise<{ ok: true; pin: string; sessionsCleared: boolean }> {
  const pin = randomPin();
  const { error: updateError } = await admin.auth.admin.updateUserById(target.user_id, { password: passwordFor(pin) });
  if (updateError) throw updateError;
  await admin.rpc("auth_attempt_reset", { p_key: `emp:${target.employee_no}` });
  const sessionsCleared = await revokeSessions(admin, target.user_id, null);
  return { ok: true, pin, sessionsCleared };
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
    // PINを変えた・再設定したあとは、スマホに保存した古いPINが自動で入ることがある(4桁の数字なので画面では見分けられない)
    throw new AppError(
      401,
      "社員番号かPINが違います。まだ登録していない場合は「新規登録」から登録してください。" +
        "PINを変えた・再設定したあとは、スマホに保存した古いPINが自動で入ることがあるので、手で入力してください。",
      "bad_credentials",
    );
  }
  await clearFailures(admin, key);
  return session;
}

function alreadyRegistered(): AppError {
  return new AppError(409, "この社員番号はすでに登録されています。ログインしてください。PINを忘れたときは管理者に連絡してください。", "already_registered");
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
    throw alreadyRegistered();
  }

  const email = emailFor(employeeNo);
  let created = await admin.auth.admin.createUser({ email, password: passwordFor(pin), email_confirm: true });
  if (created.error || !created.data.user) {
    // 前回の登録が途中で止まって、ユーザーだけ残っている場合(プロフィールが無い = 誰も登録していない)は、
    // 消してから作り直す。そのまま使うと、そのユーザーで先にログインしていた人(Supabase の新規登録を
    // オンにしていたときに他人が作ったなど)が、本人の登録後もそのまま入れてしまう
    const left = await findUserByEmail(admin, email);
    if (!left) throw created.error ?? new Error("ユーザーを作れませんでした");
    // 同じ社員番号の登録が同時に進んで、相手がもうプロフィールまで作っていたら触らない
    const { data: owner, error: ownerError } = await admin
      .from("profiles").select("user_id").eq("user_id", left.id).maybeSingle();
    if (ownerError) throw ownerError;
    if (owner) throw alreadyRegistered();
    const removed = await admin.auth.admin.deleteUser(left.id);
    if (removed.error) throw removed.error;
    created = await admin.auth.admin.createUser({ email, password: passwordFor(pin), email_confirm: true });
    if (created.error || !created.data.user) throw created.error ?? new Error("ユーザーを作れませんでした");
  }
  const userId = created.data.user.id;

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
