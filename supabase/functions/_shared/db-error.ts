// DB のエラーをログに出してよい形にする(contact-repo.ts と login-core.ts で使う)

// DB のエラーは、そのまま投げない。PostgREST のエラーの details には、失敗した行の中身(社員番号・氏名・メールアドレス)が
// 入っていて、Edge Function のログにそのまま出てしまうため。コードと、中身を含まない message の先頭だけにする(O)
export function sanitizeDbError(error: unknown): Error {
  const e = (error ?? {}) as { code?: string; message?: string };
  return new Error(`DB error ${e.code ?? ""}: ${String(e.message ?? "").split("\n")[0].slice(0, 150)}`);
}
