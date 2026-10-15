// ログイン・登録の失敗回数のロック(5回失敗で15分)。DB の関数を service_role で呼ぶ。
// PIN(社員番号ごと)は、長い期間でも数える(AD1)。短いロックが解けるたびに数え直しになるため

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.117.2";
import { AppError } from "./http.ts";

// PIN の長い期間のロック: 前の失敗から24時間以内に続けて20回間違えたら、24時間使えない。
// 管理者が PIN を再設定すると解ける(clearPinFailures)
export const PIN_DAY = { max: 20, windowMinutes: 1440, lockMinutes: 1440 };

// 長いロックがかかったときに知らせる先(Discord など)。失敗しても、ログインの処理は止めない
export type LockNotifier = (employeeNo: string, until: string) => Promise<void>;

function lockError(until: string): AppError {
  const minutes = Math.max(1, Math.ceil((new Date(until).getTime() - Date.now()) / 60000));
  if (minutes > 60) {
    return new AppError(
      429,
      `続けて間違えたため、あと${Math.ceil(minutes / 60)}時間ほど使えません。PINを忘れたときは、管理者にPINの再設定を頼んでください(再設定すると、すぐ使えます)。`,
      "locked",
    );
  }
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

// ---------- PIN(社員番号ごと。ログインと PIN の変更で同じ数え方) ----------

const pinKey = (employeeNo: string) => `emp:${employeeNo}`;
const pinDayKey = (employeeNo: string) => `emp-day:${employeeNo}`;

export async function assertPinNotLocked(admin: SupabaseClient, employeeNo: string): Promise<void> {
  await assertNotLocked(admin, pinDayKey(employeeNo));
  await assertNotLocked(admin, pinKey(employeeNo));
}

// 長い期間の数えを先に記録する(短いロックのエラーを先に投げると、長い期間の数えが漏れるため)
export async function recordPinFailure(admin: SupabaseClient, employeeNo: string, notify?: LockNotifier): Promise<void> {
  const { data, error } = await admin.rpc("auth_attempt_fail_window", {
    p_key: pinDayKey(employeeNo),
    p_max: PIN_DAY.max,
    p_window_minutes: PIN_DAY.windowMinutes,
    p_lock_minutes: PIN_DAY.lockMinutes,
  });
  if (error) throw error;
  if (data) {
    if (notify) {
      await notify(employeeNo, data).catch((err) => console.error("lock notify failed", err instanceof Error ? err.message : err));
    }
    throw lockError(data);
  }
  await recordFailure(admin, pinKey(employeeNo));
}

export async function clearPinFailures(admin: SupabaseClient, employeeNo: string): Promise<void> {
  await clearFailures(admin, pinKey(employeeNo));
  await clearFailures(admin, pinDayKey(employeeNo));
}
