// 管理者だけ: 利用者の削除と、PIN の再設定(仮のPINを発行)。

import { requireAdmin } from "../_shared/auth.ts";
import { passwordFor, randomPin } from "../_shared/accounts.ts";
import { AppError, readBody, serve } from "../_shared/http.ts";

serve(async (req) => {
  const ctx = await requireAdmin(req);
  const body = await readBody(req);
  const userId = String(body.user_id ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new AppError(400, "利用者の指定が正しくありません。");

  const { data: target, error } = await ctx.admin
    .from("profiles").select("user_id, employee_no, role").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  if (!target || target.role !== "user") throw new AppError(404, "利用者が見つかりません。", "not_found");

  if (body.action === "delete") {
    // プロフィール・設定・勤務記録は一緒に消える(カレンダーに登録済みの予定は残る)
    const { error: deleteError } = await ctx.admin.auth.admin.deleteUser(userId);
    if (deleteError) throw deleteError;
    return { ok: true };
  }

  if (body.action === "reset-pin") {
    const pin = randomPin();
    const { error: updateError } = await ctx.admin.auth.admin.updateUserById(userId, { password: passwordFor(pin) });
    if (updateError) throw updateError;
    await ctx.admin.rpc("auth_attempt_reset", { p_key: `emp:${target.employee_no}` });
    return { ok: true, pin };
  }

  throw new AppError(400, "操作の指定が正しくありません。");
});
