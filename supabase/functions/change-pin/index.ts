// 自分のPINを変える(今のPINを確かめてから)。管理者が仮のPINを発行したあとに使う。
// 変えたら、ほかの端末のログインは消し、この端末には新しいPINでのログインを返す(画面が入れ替える)。

import { anonClient, requireMember } from "../_shared/auth.ts";
import { AppError, readBody, serve } from "../_shared/http.ts";
import { changePin } from "../_shared/login-core.ts";

serve(async (req) => {
  const ctx = await requireMember(req);
  if (!ctx.employeeNo) throw new AppError(400, "この操作は利用者だけができます。");
  return await changePin(
    { admin: ctx.admin, anon: anonClient() },
    { userId: ctx.userId, employeeNo: ctx.employeeNo },
    await readBody(req),
  );
});
