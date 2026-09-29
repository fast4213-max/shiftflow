// 管理用パスワードでログインして、管理者のセッション(トークン)を返す。
// パスワードは Supabase のシークレット ADMIN_PASSWORD(12文字以上)。

import { adminClient, anonClient } from "../_shared/auth.ts";
import { readBody, serve } from "../_shared/http.ts";
import { adminLogin } from "../_shared/login-core.ts";

serve(async (req) => {
  const session = await adminLogin(
    { admin: adminClient(), anon: anonClient() },
    await readBody(req),
    Deno.env.get("ADMIN_PASSWORD"),
  );
  return { session };
});
