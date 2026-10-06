// ログイン中の利用者を JWT から取り出す。リクエスト本文の値は信用しない。

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.117.2";
import { AppError } from "./http.ts";

export type Context = {
  userId: string;
  employeeNo: string | null; // 管理者は null
  isAdmin: boolean;
  // 利用者の権限で DB を触る(RLS が効く)
  db: SupabaseClient;
  // service_role で DB を触る(検証済みフラグ・ロック・祝日キャッシュなど、利用者に書かせない所だけ)
  admin: SupabaseClient;
};

function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`環境変数 ${name} がありません`);
  return v;
}

// 鍵は旧方式(SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY)を優先し、
// 無ければ新方式(SUPABASE_SECRET_KEYS / SUPABASE_PUBLISHABLE_KEYS: {"default": "..."} の JSON)から取る
function key(legacy: string, keys: string): string {
  const v = Deno.env.get(legacy);
  if (v) return v;
  const raw = Deno.env.get(keys);
  if (raw) {
    try {
      const obj = JSON.parse(raw);
      const found = obj.default || Object.values(obj)[0];
      if (typeof found === "string" && found) return found;
    } catch {
      return raw;
    }
  }
  throw new Error(`環境変数 ${legacy} / ${keys} がありません`);
}

export function adminClient(): SupabaseClient {
  return createClient(env("SUPABASE_URL"), key("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEYS"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function anonClient(token?: string): SupabaseClient {
  return createClient(env("SUPABASE_URL"), key("SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEYS"), {
    ...(token ? { global: { headers: { Authorization: `Bearer ${token}` } } } : {}),
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Supabase Auth のエラーが、一時的な障害(通信できない・5xx・混雑)か。
// そうなら「ログインが切れた」とは言わない(言うと、画面がこの端末のログインを消して、入力中の内容も失う)
export function isTransientAuthError(error: { status?: number; name?: string } | null | undefined): boolean {
  if (!error) return false;
  const status = error.status ?? 0;
  return status === 0 || status === 429 || status >= 500 || error.name === "AuthRetryableFetchError";
}

const UNAVAILABLE = () => new AppError(503, "ただいまログインを確認できません。少し待ってから、もう一度お試しください。", "auth_unavailable");

// トークンから、ログイン中の利用者(プロフィールがある人)を調べる。admin は service_role のクライアント。
// 本当にログインが無い(トークンが無効・ユーザーが消えた・プロフィールが無い)ときだけ 401・403。
// Auth や DB の一時的な障害は 503(auth_unavailable)にして、画面はログインを消さない
export async function memberFromToken(admin: SupabaseClient, token: string): Promise<Omit<Context, "db">> {
  const { data, error } = await admin.auth.getUser(token);
  if (error) {
    if (isTransientAuthError(error)) throw UNAVAILABLE();
    throw new AppError(401, "ログインし直してください。", "unauthenticated");
  }
  if (!data.user) throw new AppError(401, "ログインし直してください。", "unauthenticated");

  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("employee_no, role")
    .eq("user_id", data.user.id)
    .maybeSingle();
  if (profileError) {
    console.error("profile lookup failed", (profileError as { code?: string }).code);
    throw UNAVAILABLE();
  }
  if (!profile) throw new AppError(403, "このアカウントは利用できません。", "not_member");

  return {
    userId: data.user.id,
    employeeNo: profile.employee_no,
    isAdmin: profile.role === "admin",
    admin,
  };
}

// ログイン中の利用者(プロフィールがある人)。リクエスト本文の値は信用しない
export async function requireMember(req: Request): Promise<Context> {
  const header = req.headers.get("Authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "");
  if (!token) throw new AppError(401, "ログインしてください。", "unauthenticated");
  const member = await memberFromToken(adminClient(), token);
  return { ...member, db: anonClient(token) };
}

export async function requireAdmin(req: Request): Promise<Context> {
  const ctx = await requireMember(req);
  if (!ctx.isAdmin) throw new AppError(403, "管理者だけが実行できます。", "not_admin");
  return ctx;
}
