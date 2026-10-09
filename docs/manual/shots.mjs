// 説明書・使い方ページの設定画面の写真(settings.png・settings-ok.png・settings-auto.png)を撮る。架空のデータ。Supabase は偽物(本番には接続しない)
// 使い方: Playwright を入れて `node docs/manual/shots.mjs`(docs/manual/img/ と web/img/manual/ の両方を置き換える)
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";

const WEB = new URL("../../web/", import.meta.url).pathname;
const IMG = new URL("./img/", import.meta.url).pathname;
const PORT = 8124;
const BASE = `http://127.0.0.1:${PORT}`;
const SB = "https://owotkyocoslifbgwwafm.supabase.co";

const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], { cwd: WEB, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch();

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const exp = Math.floor(Date.now() / 1000) + 86400;
const token = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub: "u1", exp, role: "authenticated", session_id: "s1" })}.sig`;
const session = { access_token: token, refresh_token: "r", expires_at: exp, expires_in: 86400, token_type: "bearer", user: { id: "u1", aud: "authenticated", role: "authenticated", email: "x@users.shiftflow.invalid" } };
const WORK_ID = "abcdefg1234567@group.calendar.google.com";

// はじめての設定(user_settings の行が無い)。保存すると、送った値の行を返す
async function handler(route) {
  const req = route.request();
  const path = new URL(req.url()).pathname;
  const json = (data, status = 200) => route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(data) });
  if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
  if (path === "/rest/v1/profiles") return json([{ employee_no: "1234567", family_name: "山田", given_name: "太郎", role: "user" }]);
  if (path === "/rest/v1/user_settings") {
    if (req.method() === "POST") return json({ ...JSON.parse(req.postData()), verified_at: null });
    return json([]);
  }
  if (path === "/rest/v1/offices") return json([{ id: 1, name: "A区" }]);
  if (path === "/rest/v1/rpc/current_notices") return json([]);
  if (path === "/functions/v1/app-config") return json({ serviceAccountEmail: "shiftflow@example-project.iam.gserviceaccount.com" });
  if (path === "/functions/v1/verify-calendar") return json({ ok: true });
  return json({ error: "not mocked " + path }, 404);
}

// 押す場所に、赤い枠と番号を付ける
async function mark(page, items) {
  await page.evaluate((items) => {
    for (const [selector, n] of items) {
      const r = document.querySelector(selector).getBoundingClientRect();
      const x = r.left + window.scrollX, y = r.top + window.scrollY, pad = 4;
      const box = document.createElement("div");
      Object.assign(box.style, { position: "absolute", left: x - pad + "px", top: y - pad + "px", width: r.width + pad * 2 + "px", height: r.height + pad * 2 + "px",
        border: "2.5px solid #e11d2e", borderRadius: "8px", boxSizing: "border-box", pointerEvents: "none", zIndex: 1000 });
      const badge = document.createElement("div");
      badge.textContent = n;
      Object.assign(badge.style, { position: "absolute", left: x - pad - 9 + "px", top: y - pad - 9 + "px", width: "18px", height: "18px", borderRadius: "50%",
        background: "#e11d2e", color: "#fff", font: "bold 12px/18px sans-serif", textAlign: "center", zIndex: 1001 });
      document.body.append(box, badge);
    }
  }, items);
}

const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.route(SB + "/**", handler);
await page.addInitScript(([k, v]) => localStorage.setItem(k, v), ["sb-owotkyocoslifbgwwafm-auth-token", JSON.stringify(session)]);
await page.goto(BASE + "/settings.html");
await page.waitForSelector("#office option[value='1']", { state: "attached" });
await page.waitForFunction(() => document.getElementById("sa-email").value.includes("@"));
await page.selectOption("#office", "1");
await page.fill("#work-id", WORK_ID);
await page.evaluate(() => document.activeElement.blur());

// かんたん設定のカードは、別の写真(settings-auto.png)にあるので、この2枚では隠す
await page.addStyleTag({ content: "#auto-setup { display: none !important; }" });
await mark(page, [["#office", 1], ["#copy-sa", 2], ["#work-id", 3], ["#save", 4]]);
await page.screenshot({ path: IMG + "settings.png", fullPage: true });

// 接続テストが通ったあと(枠を外して、結果の文に5を付ける)
await page.reload();
await page.addStyleTag({ content: "#auto-setup { display: none !important; }" });
await page.waitForSelector("#office option[value='1']", { state: "attached" });
await page.waitForFunction(() => document.getElementById("sa-email").value.includes("@"));
await page.selectOption("#office", "1");
await page.fill("#work-id", WORK_ID);
await page.click("#save");
await page.waitForSelector("#result.ok");
await page.evaluate(() => document.activeElement.blur());
await mark(page, [["#result", 5]]);
await page.screenshot({ path: IMG + "settings-ok.png", fullPage: true });

// かんたん設定(Google は偽物。カレンダーを作って、共有のリンクが出たところ)
await page.route("https://accounts.google.com/gsi/client", (r) => r.fulfill({ contentType: "text/javascript",
  body: "window.google={accounts:{oauth2:{initTokenClient:o=>({requestAccessToken:()=>o.callback({access_token:'t'})}),revoke:()=>{}}}}" }));
let made = 0;
await page.route("https://www.googleapis.com/**", (r) => {
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
  if (r.request().method() === "OPTIONS") return r.fulfill({ status: 200, headers: cors });
  made++;
  return r.fulfill({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify({ id: `sample${made}abc@group.calendar.google.com` }) });
});
await page.reload();
await page.waitForSelector("#office option[value='1']", { state: "attached" });
await page.waitForFunction(() => document.getElementById("sa-email").value.includes("@"));
await page.selectOption("#auto-holiday", "work");
await page.waitForTimeout(800); // ログイン部品の読み込み待ち
await page.click("#auto-run");
await page.waitForSelector("#auto-result.ok");
await page.evaluate(() => document.activeElement.blur());
await mark(page, [["#auto-run", 1], ["#auto-links a", 2]]);
await page.locator("#auto-setup").screenshot({ path: IMG + "settings-auto.png" });

for (const f of ["settings.png", "settings-ok.png", "settings-auto.png"]) fs.copyFileSync(IMG + f, WEB + "img/manual/" + f);
await browser.close();
server.kill();
console.log("ok");
