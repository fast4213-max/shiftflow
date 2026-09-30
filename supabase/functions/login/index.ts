// 社員番号 + PIN でログインして、セッション(トークン)を返す。
// 失敗が続いたら、その社員番号を15分ロックする(総当たり対策)。

import { adminClient, anonClient } from "../_shared/auth.ts";
import { readBody, serve } from "../_shared/http.ts";
import { loginWithPin } from "../_shared/login-core.ts";

serve(async (req) => {
  const session = await loginWithPin({ admin: adminClient(), anon: anonClient() }, await readBody(req));
  return { session };
});
