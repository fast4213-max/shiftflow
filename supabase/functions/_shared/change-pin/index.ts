// 自分のPINを変える(いまのPINを確かめてから)。管理者が仮のPINを発行したあとに使う。

import { anonClient, requireMember } from "../_shared/auth.ts";
import { emailFor, passwordFor, validatePin } from "../_shared/accounts.ts";
import { assertNotLocked, clearFailures, recordFailure } from "../_shared/attempts.ts";
import { AppError, readBody, serve } from "../_shared/http.ts";

serve(async (req) => {
  const ctx = await requireMember(req);
  if (!ctx.employeeNo) throw new AppError(400, "この操作は利用者だけができます。");
  const body = await readBody(req);
  const current = validatePin(body.current_pin, "いまのPIN");
  const next = validatePin(body.new_pin, "新しいPIN");

  const key = `emp:${ctx.employeeNo}`;
  await assertNotLocked(ctx.admin, key);
  const { data, error } = await anonClient().auth.signInWithPassword({
    email: emailFor(ctx.employeeNo),
    password: passwordFor(current),
  });
  if (error || !data.session) {
    await recordFailure(ctx.admin, key);
    throw new AppError(401, "いまのPINが違います。", "bad_credentials");
  }
  await clearFailures(ctx.admin, key);

  const { error: updateError } = await ctx.admin.auth.admin.updateUserById(ctx.userId, { password: passwordFor(next) });
  if (updateError) throw updateError;
  return { ok: true };
});
