// 社員番号 + PIN でログインして、セッション(トークン)を返す。
// 失敗が続いたら、その社員番号を15分ロックする。長い期間でも数え、多ければ24時間ロックして Discord に知らせる(総当たり対策)。

import { adminClient, anonClient } from "../_shared/auth.ts";
import { readBody, serve } from "../_shared/http.ts";
import { pinLockNotifier } from "../_shared/lock-notify.ts";
import { loginWithPin } from "../_shared/login-core.ts";

serve(async (req) => {
  const admin = adminClient();
  const session = await loginWithPin({ admin, anon: anonClient(), notifyLock: pinLockNotifier(admin) }, await readBody(req));
  return { session };
});
