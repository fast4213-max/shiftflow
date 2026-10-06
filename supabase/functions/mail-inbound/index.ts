// 専用 Gmail の GAS から呼ばれる(ログインなし。合言葉 MAIL_RELAY_SECRET で確かめる)。
//   mail        受信メールの取り込み(問い合わせに当てはめて、Discord に知らせる)
//   heartbeat   GAS が動いている知らせ(管理画面に「最後に確認: ○分前」を出す)
//   maintenance 1日1回: 古い問い合わせ・Discord の通知を消す

import { checkHookSecret, ingestMails, maintenance, recordHeartbeat } from "../_shared/contact-core.ts";
import { contactDeps } from "../_shared/contact-deps.ts";
import { AppError, readBody, serve } from "../_shared/http.ts";

serve(async (req) => {
  const body = await readBody(req);
  await checkHookSecret(body, Deno.env.get("MAIL_RELAY_SECRET"));
  const deps = contactDeps();
  switch (body.action) {
    case "mail": {
      const result = await ingestMails(deps, body);
      await recordHeartbeat(deps, body);
      return { ok: true, ...result };
    }
    case "heartbeat":
      await recordHeartbeat(deps, body);
      return { ok: true };
    case "maintenance":
      return { ok: true, ...(await maintenance(deps, body)) };
  }
  throw new AppError(400, "操作の指定が正しくありません。", "bad_input");
});
