// ログイン・登録の失敗回数のロック(5回失敗で15分)。DB の関数を service_role で呼ぶ。

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { AppError } from "./http.ts";

function lockError(until: string): AppError {
  const minutes = Math.max(1, Math.ceil((new Date(until).getTime() - Date.now()) / 60000));
  return new AppError(429, `続けて間違えたため、あと${minutes}分ほど使えません。時間をおいてやり直してください。`, "locked");
}

export async function assertNotLocked(admin: SupabaseClient, key: string): Promise<void> {
  const { data, error } = await admin.rpc("auth_attempt_locked_until", { p_key: key });
  if (error) throw error;
  if (data) throw lockError(data);
}

// 失敗を記録する。ロックされたらそのエラーを投げる。されなければ何もしない(呼び出し側が通常のエラーを投げる)
export async function recordFailure(admin: SupabaseClient, key: string): Promise<void> {
  const { data, error } = await admin.rpc("auth_attempt_fail", { p_key: key, p_max: 5, p_minutes: 15 });
  if (error) throw error;
  if (data) throw lockError(data);
}

export async function clearFailures(admin: SupabaseClient, key: string): Promise<void> {
  const { error } = await admin.rpc("auth_attempt_reset", { p_key: key });
  if (error) throw error;
}
