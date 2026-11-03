// Edge Functions の設定の確かめ: 関数を足したのに supabase/config.toml へ書き忘れると、本番だけで 401 になる(新しい署名鍵方式では、
// ゲートウェイの検証を切って、関数の中でトークンを確かめる決まり)。テストでは見つからないので、一覧の突き合わせで確かめる。

import { assertEquals } from "jsr:@std/assert@1";

Deno.test("supabase/config.toml: 全ての Edge Function に verify_jwt = false が書いてある", () => {
  const functionsDir = new URL("../", import.meta.url);
  const dirs = [...Deno.readDirSync(functionsDir)]
    .filter((e) => e.isDirectory && !e.name.startsWith("_") && !e.name.startsWith("."))
    .map((e) => e.name)
    .filter((name) => {
      try {
        Deno.statSync(new URL(`../${name}/index.ts`, import.meta.url));
        return true;
      } catch {
        return false;
      }
    })
    .sort();
  const toml = Deno.readTextFileSync(new URL("../../config.toml", import.meta.url));
  const configured = new Set<string>();
  const re = /^\[functions\.([a-z0-9_-]+)\]\s*\n\s*verify_jwt\s*=\s*false\s*$/gm;
  for (let m = re.exec(toml); m; m = re.exec(toml)) configured.add(m[1]);
  const missing = dirs.filter((d) => !configured.has(d));
  assertEquals(missing, [], `config.toml に [functions.<名前>] verify_jwt = false が無い関数: ${missing.join(", ")}`);
});
