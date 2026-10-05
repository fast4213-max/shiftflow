// 管理者だけ: 利用者の削除と、PIN の再設定(仮のPINを発行。その人のログイン中の端末もログアウトさせる)。

import { requireAdmin } from "../_shared/auth.ts";
import { AppError, readBody, serve } from "../_shared/http.ts";
import { resetPin } from "../_shared/login-core.ts";

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
    return await resetPin(ctx.admin, target);
  }

  throw new AppError(400, "操作の指定が正しくありません。");
});
