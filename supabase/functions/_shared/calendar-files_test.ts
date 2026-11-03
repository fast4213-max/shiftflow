import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { removeUserFiles } from "./calendar-files.ts";

// 偽の Storage: フォルダごとのファイル名の一覧
function fake(files: string[], opts: { listError?: boolean; removeError?: boolean; missingBucket?: boolean } = {}) {
  const left = [...files];
  const removed: string[] = [];
  return {
    removed,
    admin: {
      storage: {
        from: (bucket: string) => {
          if (bucket !== "calendar") throw new Error("バケットが違う: " + bucket);
          return {
            list: (_path: string, o: { limit: number; offset: number }) =>
              Promise.resolve(opts.missingBucket ? { data: null, error: { message: "Bucket not found", statusCode: "404" } } : opts.listError ? { data: null, error: { message: "list failed" } } : { data: left.slice(o.offset, o.offset + o.limit).map((name) => ({ name })), error: null }),
            remove: (paths: string[]) => {
              if (opts.removeError) return Promise.resolve({ error: { message: "remove failed" } });
              for (const p of paths) { removed.push(p); left.splice(left.indexOf(p.split("/")[1]), 1); }
              return Promise.resolve({ error: null });
            },
          };
        },
      },
    },
  };
}

Deno.test("removeUserFiles: その人のフォルダのファイルを、全部(100件を超えても)消す", async () => {
  const names = Array.from({ length: 250 }, (_, i) => `f${i}.jpg`);
  const s = fake(names);
  assertEquals(await removeUserFiles(s.admin, "u1"), 250);
  assertEquals(s.removed.length, 250);
  assertEquals(s.removed[0], "u1/f0.jpg");
});

Deno.test("removeUserFiles: ファイルが無ければ何も消さない", async () => {
  const s = fake([]);
  assertEquals(await removeUserFiles(s.admin, "u1"), 0);
  assertEquals(s.removed, []);
});

Deno.test("removeUserFiles: 一覧が読めない・消せないときは例外(利用者を消す前に止める)", async () => {
  await assertRejects(() => removeUserFiles(fake(["a.jpg"], { listError: true }).admin, "u1"), Error, "一覧を読めませんでした");
  await assertRejects(() => removeUserFiles(fake(["a.jpg"], { removeError: true }).admin, "u1"), Error, "消せませんでした");
});

Deno.test("removeUserFiles: バケットがまだ無いとき(Bucket not found・404)は、消すものが無いので0件で進む(利用者の削除を止めない)", async () => {
  const s = fake([], { missingBucket: true });
  assertEquals(await removeUserFiles(s.admin, "u1"), 0);
});
