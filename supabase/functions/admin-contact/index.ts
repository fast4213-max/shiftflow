// 管理者だけ: お問い合わせの一覧・詳細・返事(画面 / メール)・送り直し・状態の変更・当てはまらないメールへの返事

import { requireAdmin } from "../_shared/auth.ts";
import {
  adminGet,
  adminList,
  adminReply,
  adminReplyUnmatched,
  adminResend,
  adminSetStatus,
} from "../_shared/contact-core.ts";
import { contactDeps } from "../_shared/contact-deps.ts";
import { AppError, readBody, serve } from "../_shared/http.ts";

serve(async (req) => {
  await requireAdmin(req);
  const body = await readBody(req);
  const deps = contactDeps();
  switch (body.action) {
    case "list":
      return await adminList(deps, body.filter);
    case "get":
      return await adminGet(deps, body.id);
    case "reply":
      return await adminReply(deps, body);
    case "resend":
      return await adminResend(deps, body);
    case "status":
      return await adminSetStatus(deps, body);
    case "reply-unmatched":
      return await adminReplyUnmatched(deps, body);
  }
  throw new AppError(400, "操作の指定が正しくありません。", "bad_input");
});
