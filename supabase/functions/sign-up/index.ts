// 新規登録: 共通パスワードを確かめて、社員番号・名前・PINで利用者を作る。登録したらすぐ使える。

import { adminClient } from "../_shared/auth.ts";
import { readBody, serve } from "../_shared/http.ts";
import { signUp } from "../_shared/login-core.ts";

function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for") || req.headers.get("cf-connecting-ip") || "";
  return forwarded.split(",")[0].trim() || "unknown";
}

serve(async (req) => signUp({ admin: adminClient() }, await readBody(req), clientIp(req)));
