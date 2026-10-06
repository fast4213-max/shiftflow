// お問い合わせ(利用者): 送信・返事を見る(ログイン前)・これまでのお問い合わせ(ログイン後)。
// ログイン前でも呼べる(config.toml で verify_jwt = false)。ログイン後の送信(mode: "member")はログインを確かめ、
// 社員番号・名前・所属は DB から取る(画面から来た値は使わない)。

import { requireMember } from "../_shared/auth.ts";
import { listMine, submitInquiry, viewInquiry } from "../_shared/contact-core.ts";
import { contactDeps } from "../_shared/contact-deps.ts";
import { AppError, clientIp, readBody, serve } from "../_shared/http.ts";

serve(async (req) => {
  const body = await readBody(req);
  const deps = contactDeps();
  switch (body.action) {
    case "submit": {
      // ログイン後の画面から来たのにログインが切れていたら、ログイン前として送らずにエラーにする(C3)
      const userId = body.mode === "member" ? (await requireMember(req)).userId : null;
      return await submitInquiry(deps, body, { ip: clientIp(req), userId });
    }
    case "view":
      return await viewInquiry(deps, body, clientIp(req));
    case "mine": {
      const ctx = await requireMember(req);
      return { inquiries: await listMine(deps, ctx.userId) };
    }
  }
  throw new AppError(400, "操作の指定が正しくありません。", "bad_input");
});
