// 管理者だけ: 利用者の削除と、PIN の再設定(仮のPINを発行。その人のログイン中の端末もログアウトさせる)。

import { requireAdmin } from "../_shared/auth.ts";
import { AppError, readBody, serve } from "../_shared/http.ts";
import { removeUserFiles } from "../_shared/calendar-files.ts";
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
    // 夫婦でカレンダーを使っていたら、先にやめるときと同じ片付けをする(招待された側が作ったものを、その人のカレンダーへ。docs/share/DESIGN.md)
    //   相手の予定に足した写真は行ごと消えるので、そのファイルも消す(消す人のフォルダの分は、下の removeUserFiles で消える)
    const { data: gone, error: coupleError } = await ctx.admin.rpc("cal_couple_end_for", { p_user: userId });
    if (coupleError) throw coupleError;
    const rest = (Array.isArray(gone) ? gone : []).filter((p) => typeof p === "string" && !p.startsWith(`${userId}/`));
    if (rest.length) {
      const removed = await ctx.admin.storage.from("calendar").remove(rest);
      if (removed.error) console.error("cross photo files not removed", removed.error.message);
    }
    // カレンダーの写真・画像のファイルを先に消す(利用者を消すと行は消えるが、ファイルは残ってしまうため。消せなければ利用者も消さない)
    await removeUserFiles(ctx.admin, userId);
    // プロフィール・設定・勤務記録・カレンダーの予定などは一緒に消える(Googleカレンダーに登録済みの予定は残る)
    const { error: deleteError } = await ctx.admin.auth.admin.deleteUser(userId);
    if (deleteError) throw deleteError;
    return { ok: true };
  }

  if (body.action === "reset-pin") {
    return await resetPin(ctx.admin, target);
  }

  throw new AppError(400, "操作の指定が正しくありません。");
});
