// ログイン中の利用者を JWT から取り出す。リクエスト本文の値は信用しない。

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { AppError } from "./http.ts";

export type Context = {
  userId: string;
  email: string;
  isAdmin: boolean;
  // 利用者の権限で DB を触る(RLS が効く)
  db: SupabaseClient;
  // service_role で DB を触る(検証済みフラグ・ロック・祝日キャッシュなど、利用者に書かせない所だけ)
  admin: SupabaseClient;
};

function env(name: string, ...fallbacks: string[]): string {
  for (const n of [name, ...fallbacks]) {
    const v = Deno.env.get(n);
    if (v) return v;
  }
  throw new Error(`環境変数 ${name} がありません`);
}

export function adminClient(): SupabaseClient {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function requireMember(req: Request): Promise<Context> {
  const header = req.headers.get("Authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "");
  if (!token) throw new AppError(401, "ログインしてください。", "unauthenticated");

  const admin = adminClient();
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) throw new AppError(401, "ログインし直してください。", "unauthenticated");

  const email = (data.user.email || "").toLowerCase();
  const { data: member } = await admin.from("members").select("is_admin").eq("email", email).maybeSingle();
  if (!member) throw new AppError(403, "このアカウントは利用が許可されていません。", "not_member");

  const db = createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return { userId: data.user.id, email, isAdmin: !!member.is_admin, db, admin };
}
