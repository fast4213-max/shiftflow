// 利用者のカレンダーの写真・画像(Storage の calendar バケットの <user_id>/ の下)を、全部消す。
// 管理者が利用者を消すときに、ファイルだけが残らないようにする(行は利用者を消すと一緒に消えるが、ファイルは消えないため)。

type StorageError = { message: string; status?: number | string; statusCode?: number | string };
type StorageApi = {
  list: (path: string, options: { limit: number; offset: number }) => Promise<{ data: { name: string }[] | null; error: StorageError | null }>;
  remove: (paths: string[]) => Promise<{ error: { message: string } | null }>;
};
type Admin = { storage: { from: (bucket: string) => StorageApi } };

const PAGE = 100;

// バケット(calendar)がまだ無い(権限の migration で作れなかった・Storage が使えない)ときの「見つからない」。
// その場合、消すファイルは無いので、利用者の削除は止めない
function isMissingBucket(error: StorageError): boolean {
  return /bucket not found/i.test(error.message) || String(error.statusCode ?? error.status ?? "") === "404";
}

// 消したファイルの数を返す。消せなかったら例外(利用者を消す前に止めて、ファイルが残らないようにする)
export async function removeUserFiles(admin: Admin, userId: string): Promise<number> {
  const api = admin.storage.from("calendar");
  let removed = 0;
  for (let guard = 0; guard < 1000; guard++) {
    // 消すと残りが前に詰まるので、いつも先頭から読む
    const { data, error } = await api.list(userId, { limit: PAGE, offset: 0 });
    if (error) {
      if (isMissingBucket(error)) return removed;
      throw new Error(`写真のファイルの一覧を読めませんでした: ${error.message}`);
    }
    const names = (data || []).map((f) => f.name).filter(Boolean);
    if (!names.length) return removed;
    const res = await api.remove(names.map((n) => `${userId}/${n}`));
    if (res.error) throw new Error(`写真のファイルを消せませんでした: ${res.error.message}`);
    removed += names.length;
    if (names.length < PAGE) return removed;
  }
  throw new Error("写真のファイルが多すぎて、消しきれませんでした。");
}
