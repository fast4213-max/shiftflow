// ログイン済みの利用者に、画面で表示する設定値(サービスアカウントのメールアドレスなど)を返す。

import { requireMember } from "../_shared/auth.ts";
import { serviceAccount } from "../_shared/google.ts";
import { serve } from "../_shared/http.ts";

serve(async (req) => {
  const ctx = await requireMember(req);
  return {
    serviceAccountEmail: serviceAccount().client_email,
    employeeNo: ctx.employeeNo,
    isAdmin: ctx.isAdmin,
  };
});
