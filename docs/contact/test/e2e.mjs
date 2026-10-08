// 画面の確かめ(Chromium)。Supabase は偽物(page.route)。本番には接続しない。
// 使い方: docs/contact/test/README.md(Playwright が必要。画像は fixtures/、画面の画像は shots/ に出る)
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import assert from "node:assert/strict";

const DIR = new URL("./fixtures/", import.meta.url).pathname;
const WEB = new URL("../../../web/", import.meta.url).pathname;
const PORT = 8123;
const BASE = `http://127.0.0.1:${PORT}`;
const SB = "https://owotkyocoslifbgwwafm.supabase.co";
const OUT = process.env.SHOTS_DIR || new URL("./shots/", import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });

const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], { cwd: WEB, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch();

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function session(userId) {
  const exp = Math.floor(Date.now() / 1000) + 3600 * 24;
  const token = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub: userId, exp, role: "authenticated", session_id: "s1" })}.sig`;
  return { access_token: token, refresh_token: "r", expires_at: exp, expires_in: 86400, token_type: "bearer", user: { id: userId, aud: "authenticated", role: "authenticated", email: "x@users.shiftflow.invalid" } };
}

const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const NOTICES = [
  { id: 1, title: "システムメンテナンスのお知らせ", body: "10/12(日) 2:00〜4:00 は登録できません。\n終わったあとは、いつもどおり使えます。" + "長い説明".repeat(30), level: "important", starts_on: today, updated_at: "2026-10-06T00:00:00Z" },
  { id: 2, title: "11月のマスタを更新しました", body: "", level: "info", starts_on: today, updated_at: "2026-10-06T00:00:00Z" },
  { id: 3, title: "<img src=x onerror=alert(1)>タグは文字のまま", body: "<b>太字にならない</b>", level: "info", starts_on: today, updated_at: "2026-10-06T00:00:00Z" },
  { id: 4, title: "4件目(ログイン画面には出ない)", body: "", level: "info", starts_on: today, updated_at: "2026-10-06T00:00:00Z" },
];

// 偽の Supabase
function backend(opts = {}) {
  const st = { calls: [], inquiries: [], notices: [...NOTICES], nextNotice: 10 };
  const handler = async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const body = req.postData() ? (() => { try { return JSON.parse(req.postData()); } catch { return req.postData(); } })() : null;
    st.calls.push({ path, method: req.method(), body, auth: req.headers()["authorization"], search: url.search });
    const json = (data, status = 200) => route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(data) });
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
    if (path === "/rest/v1/rpc/current_notices") {
      if (opts.noticesFail) return json({ message: "boom" }, 500);
      if (opts.noticesDelay) await new Promise((r) => setTimeout(r, opts.noticesDelay));
      return json(st.notices);
    }
    if (path === "/rest/v1/rpc/contact_offices") {
      if (opts.officesDelay) await new Promise((r) => setTimeout(r, opts.officesDelay));
      return opts.officesFail ? json({ message: "x" }, 500) : json(["A区所", "B区所"]);
    }
    if (path === "/rest/v1/profiles" && opts.profileAbort) return route.abort("failed");
    if (path === "/rest/v1/profiles") return json(opts.profile ? [opts.profile] : []);
    if (path === "/rest/v1/user_settings") {
      const row = { office_id: 1, work_calendar_id: "w", holiday_calendar_id: null, verified_at: "2026-10-01", split_day_events: false, ...opts.settings };
      // 保存(PATCH)は、送った値を足した行を返す(.single() なので1件だけ)
      if (req.method() === "PATCH") return json({ ...row, ...body, verified_at: null });
      return json([row]);
    }
    if (path === "/functions/v1/verify-calendar") return json({ ok: true });
    if (path === "/rest/v1/offices") return json([{ id: 1, name: "A区所" }]);
    if (path === "/rest/v1/rpc/admin_stats" && opts.statsAbort) return route.abort("failed");
    if (path === "/rest/v1/rpc/admin_stats" && opts.statsFail) return json({ message: "statement timeout" }, 500);
    if (path === "/rest/v1/rpc/admin_stats") return json({ users: 1, verified: 1, active_30d: 1, signups_7d: 0, signup_password_set: true, offices: [{ id: 1, name: "A区所", master_count: 1, user_count: 1 }], no_office: 0, users_list: [] });
    if (path === "/rest/v1/shift_master" && opts.masterFail) return json({ message: "boom" }, 500);
    if (path === "/rest/v1/shift_master") return json([]);
    if (path === "/rest/v1/notices") {
      if (req.method() === "GET") return json(st.notices);
      if (req.method() === "POST") { st.notices.unshift({ id: st.nextNotice++, ...body, updated_at: new Date().toISOString() }); return json(null, 201); }
      if (req.method() === "PATCH") { const id = Number(url.searchParams.get("id").replace("eq.", "")); Object.assign(st.notices.find((n) => n.id === id), body); return json(null, 204); }
      if (req.method() === "DELETE") { const id = Number(url.searchParams.get("id").replace("eq.", "")); st.notices = st.notices.filter((n) => n.id !== id); return json(null, 204); }
    }
    if (path === "/auth/v1/logout") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } });
    if (path === "/auth/v1/token") {
      // ログインの更新(S2)。"down" は通信できない、それ以外は新しいログインを返す
      if (opts.refresh === "down") return route.abort("failed");
      return json(session("u1"));
    }
    if (path === "/functions/v1/app-config") {
      st.appConfigCalls = (st.appConfigCalls || 0) + 1;
      // 最初の1回だけ「ログインが切れた」を返す(S2)
      if (opts.firstUnauth && st.appConfigCalls === 1) return json({ error: "ログインし直してください。", code: "unauthenticated" }, 401);
      return json({ serviceAccountEmail: "sa@x.iam.gserviceaccount.com" });
    }
    if (path === "/functions/v1/contact") {
      if (opts.contactDelay) await new Promise((r) => setTimeout(r, opts.contactDelay));
      if (body.action === "submit") {
        if (opts.submitError) return json(opts.submitError, opts.submitError.status || 401);
        if (opts.submitDuplicate) return json({ id: 12, no: "#0012", duplicate: true, images: "none", reply_via: opts.submitDuplicate === "mail" ? "mail" : "screen" });
        const id = st.inquiries.length + 12;
        st.inquiries.push({ id, body });
        return json({ id, no: "#" + String(id).padStart(4, "0"), duplicate: false, images: body.images.length ? "ok" : "none" });
      }
      if (body.action === "view") {
        if (String(body.code).toUpperCase().replace("-", "") !== "K7QM4XPA") return json({ error: "受付番号か確認コードが違います。", code: "not_found" }, 404);
        return json({ no: "#0012", kind: "ログインできない", status: "replied", reply_via: "screen", created_at: "2026-10-06T00:00:00Z",
          messages: [{ from: "user", body: "PIN忘れ", at: "2026-10-06T00:00:00Z" }, { from: "admin", body: "<script>x</script>直接伝えます", at: "2026-10-06T01:00:00Z" }] });
      }
      if (body.action === "mine") return json({ inquiries: [{ no: "#0009", kind: "使い方・質問", status: "replied", reply_via: "screen", created_at: "2026-10-03T00:00:00Z",
        messages: [{ from: "user", body: "休日用は必須？", at: "2026-10-03T00:00:00Z" }, { from: "admin", body: "空欄でも使えます", at: "2026-10-04T00:00:00Z" }] }] });
    }
    if (path === "/functions/v1/admin-contact") {
      if (body.action === "list") {
        if (body.filter === "unmatched") return json({ filter: "unmatched", inquiries: [], unmatched_mails: [{ id: 90, inquiry_id: null, sender: "mail", channel: "mail", body: "質問です", body_full: null, from_email: "x@example.com", subject: "質問", attachment_names: null, bounce: false, gmail_message_id: "abc", gmail_thread_id: "def", mail_status: null, created_at: new Date().toISOString() }], counts: { todo: 2, unmatched: 1 }, statuses: {}, config: { discord: true, relay: true } });
        return json({ filter: body.filter, inquiries: [
          { id: 12, logged_in: false, employee_no: "1234567", name: opts.longName ? "とても長い名前".repeat(12) + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" : "山田 太郎", office_name: "A区所", kind: "login", reply_via: "mail", email: "taro@gmail.com", status: "open", has_new_mail: true, image_count: 2, last_activity_at: new Date().toISOString(), created_at: new Date().toISOString() },
          { id: 13, logged_in: true, employee_no: "7654321", name: "佐藤 花子", office_name: "B区所", kind: "bug", reply_via: "screen", email: null, status: "open", has_new_mail: false, image_count: 0, last_activity_at: new Date().toISOString(), created_at: new Date().toISOString() },
        ], unmatched_mails: [], counts: { todo: 2, unmatched: 1 },
        statuses: { gas: { value: { quota: 97 }, updated_at: new Date(Date.now() - 45 * 60e3).toISOString() } }, config: { discord: true, relay: true } });
      }
      if (body.action === "get") {
        return json({ inquiry: { id: 12, logged_in: false, employee_no: "1234567", name: "山田 太郎", office_name: "A区所", kind: "login", reply_via: "mail", email: "taro@gmail.com", status: "open", has_new_mail: false, image_count: 2, discord_status: "sent", receipt_status: "sent", receipt_message_id: "r1", last_activity_at: new Date().toISOString(), created_at: new Date().toISOString() },
          messages: [
            { id: 1, inquiry_id: 12, sender: "user", channel: "web", body: "PINを忘れました", created_at: new Date().toISOString() },
            { id: 2, inquiry_id: 12, sender: "admin", channel: "mail", body: "仮のPINを伝えます", mail_status: "failed", mail_error: "1日の上限", from_email: "taro@gmail.com", created_at: new Date().toISOString() },
            { id: 3, inquiry_id: 12, sender: "mail", channel: "mail", body: "<img src=x onerror=alert(2)>ありがとう", body_full: "ありがとう\n> 引用", from_email: "other@example.com", subject: "Re: お問い合わせ #0012", attachment_names: "a.jpg", gmail_thread_id: "ff01", created_at: new Date().toISOString() },
          ], registered: { name: "山田 太郎", officeName: "A区所" }, reply_to_email: "taro@gmail.com" });
      }
      if (body.action === "reply" && opts.replyDuplicate) return json({ message: { id: 9, body: "前の文", mail_status: "sent" }, duplicate: true });
      if (body.action === "reply") return json({ message: { id: 9, body: body.body, mail_status: body.via === "mail" ? "sent" : null }, duplicate: false });
      if (body.action === "resend") return json({ message: { id: 2, mail_status: "sent" } });
      if (body.action === "status") return json({ ok: true });
      if (body.action === "reply-unmatched") return json({ message: { mail_status: "sent" } });
    }
    return json({ error: "not mocked " + path }, 404);
  };
  return { st, handler };
}

const failures = [];
async function check(name, fn) {
  try {
    await fn();
    console.log("ok  " + name);
  } catch (err) {
    failures.push(name);
    console.log("NG  " + name + "\n    " + String(err.stack || err).split("\n").slice(0, 4).join("\n    "));
  }
}

async function open(path, { opts = {}, userId = null, viewport = { width: 390, height: 844 }, beforeLoad } = {}) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  const be = backend(opts);
  await page.route(SB + "/**", be.handler);
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push("console: " + m.text()); });
  page.on("dialog", (d) => { errors.push("dialog: " + d.message()); d.dismiss(); });
  if (userId) {
    await page.addInitScript(([k, v]) => { if (!sessionStorage.getItem("__init")) { localStorage.setItem(k, v); sessionStorage.setItem("__init", "1"); } },
      ["sb-owotkyocoslifbgwwafm-auth-token", JSON.stringify(session(userId))]);
  }
  if (beforeLoad) await beforeLoad(page);
  await page.goto(BASE + "/" + path);
  return { page, ctx, be, errors };
}

const USER = { employee_no: "1234567", family_name: "山田", given_name: "太郎", role: "user" };
const ADMIN = { employee_no: null, family_name: "", given_name: "", role: "admin" };

// ---------- ログイン画面 ----------
await check("ログイン画面: お知らせは利用者タブの、タブと入力欄の間に最大3件。HTML は文字のまま", async () => {
  const { page, ctx, errors } = await open("index.html");
  await page.waitForSelector("#login-notices:not(.hidden)");
  const order = await page.evaluate(() => {
    const form = document.getElementById("user-form");
    const kids = [...form.children].map((e) => e.id || e.tagName);
    return kids.slice(0, 3);
  });
  assert.deepEqual(order, ["login-notices", "LABEL", "employee-no"]);
  assert.equal(await page.locator("#login-notices .notice-item").count(), 3);
  assert.equal(await page.locator("#login-notices img").count(), 0);
  assert.ok((await page.textContent("#login-notices")).includes("<img src=x onerror=alert(1)>"));
  // 長い本文は途中まで + 続きを読む
  assert.equal(await page.locator("#login-notices .link-button").count(), 1);
  await page.click("#login-notices .link-button");
  assert.ok((await page.textContent("#login-notices")).includes("長い説明長い説明"));
  assert.ok(await page.isVisible("text=ログインできないときは"));
  assert.equal(await page.getAttribute("a:has-text('お問い合わせ') >> nth=-1", "href"), "contact.html");
  await page.screenshot({ path: OUT + "login.png", fullPage: true });
  await page.click("#tab-admin");
  assert.equal(await page.isVisible("#login-notices"), false);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("ログイン画面: お知らせが読めない(500)ときは何も出さず、エラーも出さない(N1)", async () => {
  const { page, ctx, errors } = await open("index.html", { opts: { noticesFail: true } });
  await page.waitForTimeout(1500);
  assert.equal(await page.isVisible("#login-notices"), false);
  assert.equal(await page.isEnabled("#user-login"), true);
  assert.deepEqual(errors.filter((e) => !e.includes("500")), []);
  await ctx.close();
});

await check("ログイン画面: 入力を始めたあとに届いたお知らせは、欄をずらさずボタンの下に出す(N2)。遅いお知らせはログインを止めない", async () => {
  const { page, ctx, errors } = await open("index.html", { opts: { noticesDelay: 2500 } });
  await page.click("#employee-no");
  await page.keyboard.type("123");
  const before = await page.locator("#employee-no").boundingBox();
  await page.waitForSelector("#login-notices:not(.hidden)", { timeout: 6000 });
  const after = await page.locator("#employee-no").boundingBox();
  assert.equal(before.y, after.y);
  assert.ok(await page.evaluate(() => document.getElementById("login-notices").classList.contains("below")));
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("ログイン画面: 前回のログインの確認が通信エラーなら、ログインを消さずに知らせる。プロフィールが無いときだけ消す(Q1)", async () => {
  const key = "sb-owotkyocoslifbgwwafm-auth-token";
  const a = await open("index.html", { userId: "u1", opts: { profileAbort: true } });
  await a.page.waitForSelector("#user-message.error");
  assert.ok((await a.page.textContent("#user-message")).includes("確かめられませんでした"));
  assert.ok(await a.page.evaluate((k) => !!localStorage.getItem(k), key));
  assert.equal(await a.page.isEnabled("#user-login"), true);
  await a.ctx.close();
  const b = await open("index.html", { userId: "u1", opts: { profile: null } });
  await b.page.waitForFunction((k) => !localStorage.getItem(k), key);
  assert.equal(await b.page.textContent("#user-message"), "");
  await b.ctx.close();
});

await check("お問い合わせ: 前の送信がもう届いていた(duplicate)ときは、直した内容は届いていないと知らせる(Q6)", async () => {
  const { page, ctx } = await open("contact.html", { opts: { submitDuplicate: true } });
  await page.waitForSelector("#contact-form:not(.hidden)");
  await page.fill("#employee-no", "1234567");
  await page.fill("#name", "山田 太郎");
  await page.selectOption("#office", "A区所");
  await page.selectOption("#kind", "login");
  await page.fill("#body", "直した内容");
  await page.click("#submit");
  await page.waitForSelector("#sent:not(.hidden)");
  assert.ok((await page.textContent("#sent-images")).includes("もう届いていました"));
  await ctx.close();
});

await check("送り直しで前の問い合わせ(メールで受け取る)が届いていたら、使えない確認コードを出さない(S20)", async () => {
  const { page, ctx } = await open("contact.html", { opts: { submitDuplicate: "mail" } });
  await page.waitForSelector("#contact-form:not(.hidden)");
  await page.fill("#employee-no", "1234567");
  await page.fill("#name", "山田 太郎");
  await page.selectOption("#office", "A区所");
  await page.selectOption("#kind", "login");
  await page.fill("#body", "内容");
  await page.click("#submit");
  await page.waitForSelector("#sent:not(.hidden)");
  assert.equal(await page.isVisible("#sent-code"), false);
  assert.equal(await page.isVisible("#sent-mail"), true);
  await ctx.close();
});

await check("ログインの更新が遅れて「ログインが切れた」と言われたら、更新して1回だけ送り直す。更新できない(圏外)ときはログインを消さない(S2)", async () => {
  const key = "sb-owotkyocoslifbgwwafm-auth-token";
  const a = await open("settings.html", { userId: "u1", opts: { profile: USER, firstUnauth: true } });
  await a.page.waitForFunction(() => document.getElementById("sa-email").value === "sa@x.iam.gserviceaccount.com");
  assert.equal(a.be.st.appConfigCalls, 2);
  assert.ok(a.page.url().endsWith("settings.html"));
  await a.ctx.close();
  const b = await open("settings.html", { userId: "u1", opts: { profile: USER, firstUnauth: true, refresh: "down" } });
  // 圏外のとき、supabase-js はログインの更新を30秒ほど粘ってから諦める
  await b.page.waitForFunction(() => document.getElementById("sa-email").value.startsWith("取得できませんでした"), null, { timeout: 45000 });
  assert.ok((await b.page.inputValue("#sa-email")).includes("通信が不安定"));
  assert.ok(b.page.url().endsWith("settings.html"));
  assert.ok(await b.page.evaluate((k) => !!localStorage.getItem(k), key));
  await b.ctx.close();
});

await check("設定: 非番を2件・非番の時間用カレンダーIDを読み込み、保存で送る", async () => {
  const { page, ctx, be, errors } = await open("settings.html", {
    userId: "u1",
    opts: { profile: USER, settings: { split_offduty_events: true, offduty_calendar_id: "off@group.calendar.google.com" } },
  });
  await page.waitForFunction(() => document.getElementById("offduty-id").value === "off@group.calendar.google.com");
  assert.equal(await page.isChecked("#split-offduty"), true);
  assert.equal(await page.isChecked("#split-day"), false);
  await page.waitForSelector("#office option[value='1']", { state: "attached" });
  await page.uncheck("#split-offduty");
  // 変えたら、保存するまで「勤務入力へ」を出さない
  assert.equal(await page.isVisible("#go-input"), false);
  await page.fill("#offduty-id", "  off2@group.calendar.google.com ");
  await page.click("#save");
  await page.waitForSelector("#result.ok");
  const saved = be.st.calls.find((c) => c.path === "/rest/v1/user_settings" && c.method === "PATCH").body;
  assert.equal(saved.split_offduty_events, false);
  assert.equal(saved.offduty_calendar_id, "off2@group.calendar.google.com");
  assert.ok(be.st.calls.some((c) => c.path === "/functions/v1/verify-calendar"));
  assert.deepEqual(errors, []);
  await page.screenshot({ path: OUT + "settings-offduty.png", fullPage: true });
  await ctx.close();
});

await check("ログアウトは、この端末だけ(scope=local。S5)", async () => {
  const { page, ctx, be } = await open("notices.html", { userId: "u1", opts: { profile: USER } });
  await page.waitForSelector("text=ログアウト");
  await page.click("text=ログアウト");
  await page.waitForURL(/index\.html/);
  const out = be.st.calls.find((c) => c.path === "/auth/v1/logout");
  assert.ok(out && out.search.includes("scope=local"), JSON.stringify(out && out.search));
  await ctx.close();
});

await check("管理画面: マスタを読み込めていないときは「CSVで保存」で前の区所のマスタを保存しない(S4)", async () => {
  const { page, ctx } = await open("admin.html", { userId: "a1", opts: { profile: ADMIN, masterFail: true }, viewport: { width: 1200, height: 900 } });
  await page.waitForSelector("#message.error");
  await page.click('.dtab[data-tab="master"]');
  const download = page.waitForEvent("download", { timeout: 1500 }).then(() => true, () => false);
  await page.click("#csv-download");
  assert.equal(await download, false);
  assert.ok((await page.textContent("#message")).includes("読み込めていません"));
  // 読み込みに失敗したとき、前の区所の表と件数を残さない(U2)
  assert.equal(await page.locator("#master tr").count(), 0);
  assert.equal(await page.textContent("#master-count"), "読み込み中…");
  await ctx.close();
});

// ---------- お問い合わせ(ログイン前) ----------
await check("お問い合わせ(ログイン前): 入力の確かめ・送信・受付番号と確認コード・返事を見る", async () => {
  const { page, ctx, be, errors } = await open("contact.html");
  await page.waitForSelector("#contact-form:not(.hidden)");
  assert.ok(await page.isVisible("#guest-fields"));
  assert.ok(!(await page.isVisible("#member-fields")));
  assert.deepEqual(await page.$$eval("#office option", (o) => o.map((x) => x.value)), ["", "A区所", "B区所", "わからない"]);
  assert.ok((await page.textContent("#contact-form")).includes("「ファイル」から選ぶと、送れないことがあります"));
  await page.click("#submit");
  assert.equal(await page.textContent("#message"), "社員番号は7桁の数字で入力してください。");
  await page.fill("#employee-no", "１２３４５６７");
  await page.fill("#name", "山田 太郎");
  await page.selectOption("#office", "A区所");
  await page.selectOption("#kind", "login");
  await page.fill("#body", "PINを忘れました");
  assert.equal(await page.textContent("#body-count"), "9");
  await page.screenshot({ path: OUT + "contact-guest.png", fullPage: true });
  // 二度押し
  await page.click("#submit");
  await page.click("#submit", { force: true, trial: false }).catch(() => {});
  await page.waitForSelector("#sent:not(.hidden)");
  const submits = be.st.calls.filter((c) => c.path === "/functions/v1/contact" && c.body.action === "submit");
  assert.equal(submits.length, 1);
  const p = submits[0].body;
  assert.equal(p.mode, "guest");
  assert.equal(p.employee_no, "1234567");
  assert.match(p.request_key, /^[0-9a-f-]{36}$/);
  assert.match(p.code, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(p.email, undefined);
  assert.deepEqual(p.images, []);
  assert.equal(await page.textContent("#sent-no"), "#0012");
  const shown = await page.textContent("#sent-code-value");
  assert.equal(shown.replace("-", ""), p.code);
  await page.screenshot({ path: OUT + "contact-sent.png", fullPage: true });
  // 返事を見る(違うコード → エラー、正しいコード → 返事。HTML は文字のまま)
  await page.fill("#view-no", "#0012");
  await page.fill("#view-code", "AAAA-AAAA");
  await page.click("#view-button");
  await page.waitForSelector("#view-message.error");
  await page.fill("#view-code", "k7qm-4xpa");
  await page.click("#view-button");
  await page.waitForSelector("#view-result .bubble.from-admin");
  assert.ok((await page.textContent("#view-result")).includes("<script>x</script>直接伝えます"));
  // 別の問い合わせ: 新しいキーとコードになる
  await page.click("#again");
  assert.equal(await page.inputValue("#body"), "");
  await page.fill("#body", "2件目");
  await page.selectOption("#kind", "other");
  await page.click("#submit");
  await page.waitForSelector("#sent:not(.hidden)");
  const s2 = be.st.calls.filter((c) => c.body?.action === "submit")[1].body;
  assert.notEqual(s2.request_key, p.request_key);
  assert.notEqual(s2.code, p.code);
  assert.deepEqual(errors.filter((e) => !e.includes("404")), []);
  await ctx.close();
});

await check("お問い合わせ: メールを選ぶと欄と迷惑メールの注意が出る。2回の不一致・規格外のアドレスの注意。画面に戻すとアドレスは送らない(C7・C9)", async () => {
  const { page, ctx, be, errors } = await open("contact.html");
  await page.waitForSelector("#contact-form:not(.hidden)");
  await page.fill("#employee-no", "1234567");
  await page.fill("#name", "山田");
  await page.selectOption("#office", "わからない");
  await page.selectOption("#kind", "bug");
  await page.fill("#body", "x");
  assert.equal(await page.isVisible("#email-fields"), false);
  await page.check('input[name="reply-via"][value="mail"]');
  assert.ok(await page.isVisible("#email-fields"));
  assert.ok((await page.textContent("#email-fields")).includes("shiftflow.kinmu@gmail.com"));
  assert.ok((await page.textContent("#email-fields")).includes("迷惑メール"));
  await page.fill("#email", "taro..x@docomo.ne.jp");
  assert.ok(await page.isVisible("#email-risky"));
  await page.fill("#email", "Taro@Gmail.com");
  assert.equal(await page.isVisible("#email-risky"), false);
  await page.fill("#email2", "taro@gmail.co");
  await page.click("#submit");
  assert.equal(await page.textContent("#message"), "メールアドレスが2回で一致しません。");
  await page.fill("#email2", "ｔａｒｏ＠gmail.com");
  await page.screenshot({ path: OUT + "contact-mail.png", fullPage: true });
  await page.check('input[name="reply-via"][value="screen"]');
  await page.click("#submit");
  await page.waitForSelector("#sent:not(.hidden)");
  const p = be.st.calls.find((c) => c.body?.action === "submit").body;
  assert.equal(p.reply_via, "screen");
  assert.equal(p.email, undefined);
  assert.deepEqual(errors, []);
  await ctx.close();

  const r2 = await open("contact.html");
  await r2.page.waitForSelector("#contact-form:not(.hidden)");
  await r2.page.fill("#employee-no", "1234567");
  await r2.page.fill("#name", "山田");
  await r2.page.selectOption("#office", "A区所");
  await r2.page.selectOption("#kind", "bug");
  await r2.page.fill("#body", "x");
  await r2.page.check('input[name="reply-via"][value="mail"]');
  await r2.page.fill("#email", "taro@gmail.com");
  await r2.page.fill("#email2", "taro@gmail.com");
  await r2.page.click("#submit");
  await r2.page.waitForSelector("#sent:not(.hidden)");
  assert.ok(await r2.page.isVisible("#sent-mail"));
  assert.equal(await r2.page.isVisible("#sent-code"), false);
  assert.equal(await r2.page.textContent("#sent-email"), "taro@gmail.com");
  const p2 = r2.be.st.calls.find((c) => c.body?.action === "submit").body;
  assert.equal(p2.email, "taro@gmail.com");
  assert.equal(p2.code, undefined);
  await r2.page.screenshot({ path: OUT + "contact-sent-mail.png", fullPage: true });
  await r2.ctx.close();
});

await check("お問い合わせ: 画像を縮小して JPEG で送る。画像でないファイルは外す。3枚まで。外せる(I1・I3・I6・I11)", async () => {
  const { page, ctx, be, errors } = await open("contact.html");
  await page.waitForSelector("#contact-form:not(.hidden)");
  await page.setInputFiles("#image-input", [DIR + "big.png", DIR + "fake.jpg"]);
  await page.waitForFunction(() => document.querySelectorAll("#thumbs .thumb").length === 1 && document.getElementById("image-message").classList.contains("error"));
  assert.ok((await page.textContent("#image-message")).includes("この画像は使えません: fake.jpg"));
  await page.setInputFiles("#image-input", [DIR + "big.png"]); // 同じ画像はもう一度入れない
  await page.waitForTimeout(300);
  assert.equal(await page.locator("#thumbs .thumb").count(), 1);
  await page.setInputFiles("#image-input", [DIR + "photo.jpg"]);
  await page.waitForFunction(() => document.querySelectorAll("#thumbs .thumb").length === 2);
  // 3枚目(別のファイルとして) → 追加ボタンが消える
  await page.setInputFiles("#image-input", [{ name: "photo2.jpg", mimeType: "image/jpeg", buffer: fs.readFileSync(DIR + "photo.jpg") }]);
  await page.waitForFunction(() => document.querySelectorAll("#thumbs .thumb").length === 3);
  assert.equal(await page.isVisible("#add-image"), false);
  await page.screenshot({ path: OUT + "contact-images.png", fullPage: true });
  await page.click("#thumbs .thumb >> nth=2 >> .thumb-remove");
  assert.equal(await page.locator("#thumbs .thumb").count(), 2);
  assert.ok(await page.isVisible("#add-image"));
  await page.fill("#employee-no", "1234567");
  await page.fill("#name", "山田");
  await page.selectOption("#office", "A区所");
  await page.selectOption("#kind", "bug");
  await page.fill("#body", "画面が真っ白");
  await page.click("#submit");
  await page.waitForSelector("#sent:not(.hidden)");
  const p = be.st.calls.find((c) => c.body?.action === "submit").body;
  assert.equal(p.images.length, 2);
  for (const img of p.images) {
    const bytes = Buffer.from(img.data, "base64");
    assert.deepEqual([...bytes.subarray(0, 3)], [0xff, 0xd8, 0xff]); // JPEG
    assert.ok(bytes.length < 600_000, "size " + bytes.length);
  }
  // 3000x2000 の PNG は長い辺 1600 に縮む
  const first = Buffer.from(p.images[0].data, "base64");
  let i = 2, w = 0, h = 0;
  while (i < first.length) { if (first[i] === 0xff && first[i + 1] >= 0xc0 && first[i + 1] <= 0xc2) { h = first.readUInt16BE(i + 5); w = first.readUInt16BE(i + 7); break; } i += 2 + first.readUInt16BE(i + 2); }
  assert.deepEqual([w, h], [1600, 1067]);
  assert.ok((await page.textContent("#sent-images")).includes("画像も届きました"));
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("お問い合わせ: 読み直しても書いた内容が残る(C3)。所属の一覧が読めなくても「わからない」で送れる(C14)", async () => {
  const { page, ctx, errors } = await open("contact.html", { opts: { officesFail: true } });
  await page.waitForSelector("#contact-form:not(.hidden)");
  assert.deepEqual(await page.$$eval("#office option", (o) => o.map((x) => x.value)), ["", "わからない"]);
  await page.fill("#employee-no", "7654321");
  await page.fill("#name", "佐藤");
  await page.selectOption("#office", "わからない");
  await page.selectOption("#kind", "howto");
  await page.fill("#body", "下書きのテスト");
  await page.reload();
  await page.waitForSelector("#contact-form:not(.hidden)");
  assert.equal(await page.inputValue("#body"), "下書きのテスト");
  assert.equal(await page.inputValue("#employee-no"), "7654321");
  assert.equal(await page.inputValue("#kind"), "howto");
  assert.equal(await page.inputValue("#office"), "わからない");
  assert.deepEqual(errors.filter((e) => !e.includes("500")), []);
  await ctx.close();
});

// ---------- ログイン後 ----------
await check("ログイン後: メニューに お知らせ(未読の赤い点)・お問い合わせ。社員番号などは自動。送る値に社員番号を入れない", async () => {
  const { page, ctx, be, errors } = await open("contact.html", { userId: "u1", opts: { profile: USER } });
  await page.waitForSelector("#contact-form:not(.hidden)");
  const nav = await page.$$eval(".topbar a", (a) => a.map((x) => x.textContent));
  assert.deepEqual(nav, ["shiftflow", "勤務入力", "設定", "お知らせ", "お問い合わせ", "使い方", "ログアウト"]);
  await page.waitForSelector("#nav-notices.has-dot");
  assert.equal(await page.textContent("#member-no"), "1234567");
  assert.equal(await page.textContent("#member-name"), "山田 太郎");
  assert.equal(await page.textContent("#member-office"), "A区所");
  assert.equal(await page.isVisible("#guest-fields"), false);
  assert.equal(await page.isVisible("#view-section"), false);
  await page.waitForSelector("#mine .bubble.from-admin");
  await page.selectOption("#kind", "howto");
  await page.fill("#body", "質問です");
  await page.screenshot({ path: OUT + "contact-member.png", fullPage: true });
  await page.click("#submit");
  await page.waitForSelector("#sent:not(.hidden)");
  const call = be.st.calls.find((c) => c.body?.action === "submit");
  assert.equal(call.body.mode, "member");
  assert.equal(call.body.employee_no, undefined);
  assert.equal(call.body.code, undefined);
  assert.ok(call.auth.includes(".sig")); // ログインのトークンで送っている
  assert.ok(await page.isVisible("#sent-member"));
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("ログイン後: ログインが切れていたら、ログイン画面へ飛ばず、書いた内容を残して知らせる(C3)", async () => {
  const { page, ctx } = await open("contact.html", { userId: "u1", opts: { profile: USER, submitError: { error: "ログインし直してください。", code: "unauthenticated", status: 401 } } });
  await page.waitForSelector("#contact-form:not(.hidden)");
  await page.selectOption("#kind", "howto");
  await page.fill("#body", "消えないで");
  await page.click("#submit");
  await page.waitForSelector("#message.error");
  assert.ok((await page.textContent("#message")).includes("書いた内容は残してあります"));
  assert.ok(page.url().endsWith("contact.html"));
  assert.equal(await page.inputValue("#body"), "消えないで");
  await ctx.close();
});

await check("お知らせのページ: 全部出し(NEW付き)、見たら赤い点が消える(N7・N8)", async () => {
  const { page, ctx, errors } = await open("notices.html", { userId: "u1", opts: { profile: USER } });
  await page.waitForSelector("#notices .card");
  assert.equal(await page.locator("#notices .card").count(), 4);
  assert.equal(await page.locator(".notice-new").count(), 4);
  assert.equal(await page.locator("#nav-notices.has-dot").count(), 0);
  await page.screenshot({ path: OUT + "notices.png", fullPage: true });
  await page.goto(BASE + "/contact.html");
  await page.waitForSelector("#contact-form:not(.hidden)");
  await page.waitForTimeout(800);
  assert.equal(await page.locator("#nav-notices.has-dot").count(), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("管理者がお問い合わせ・お知らせのページを開いたら、案内を出す / 管理画面へ(N10)", async () => {
  const { page, ctx } = await open("contact.html", { userId: "a1", opts: { profile: ADMIN } });
  await page.waitForSelector("#admin-note:not(.hidden)");
  assert.equal(await page.isVisible("#contact-form"), false);
  await page.goto(BASE + "/notices.html");
  await page.waitForURL(/admin\.html/);
  await ctx.close();
});

// ---------- 管理画面 ----------
await check("管理画面: お問い合わせタブの件数・GAS が止まっている注意・やり取り(文字のまま)・PIN の確かめ・返事", async () => {
  const { page, ctx, be, errors } = await open("admin.html", { userId: "a1", opts: { profile: ADMIN }, viewport: { width: 1200, height: 900 } });
  await page.waitForSelector("#contact-badge:not(.hidden)");
  assert.equal(await page.textContent("#contact-badge"), "2");
  assert.ok((await page.textContent("#contact-alert")).includes("未対応のお問い合わせが 2件"));
  await page.click('.dtab[data-tab="contact"]');
  await page.waitForSelector(".contact-item");
  assert.ok((await page.textContent("#contact-status")).includes("30分以上止まっています"));
  await page.click(".contact-item >> nth=0");
  await page.waitForSelector("#contact-detail .bubble");
  assert.equal(await page.locator("#contact-detail img").count(), 0);
  const detail = await page.textContent("#contact-detail");
  assert.ok(detail.includes("<img src=x onerror=alert(2)>ありがとう"));
  assert.ok(detail.includes("ログイン前の問い合わせです"));
  assert.ok(detail.includes("違う人からのメール"));
  assert.ok(detail.includes("送れませんでした: 1日の上限"));
  assert.ok(detail.includes("登録あり"));
  const gmail = await page.getAttribute("#contact-detail a.gmail-link >> nth=0", "href");
  assert.ok(gmail.startsWith("https://mail.google.com/mail/u/?authuser=shiftflow.kinmu%40gmail.com#all/r1"), gmail);
  await page.click("text=全文を見る");
  assert.ok((await page.textContent("#contact-detail")).includes("> 引用"));
  await page.screenshot({ path: OUT + "admin-contact.png", fullPage: true });
  // 4桁の数字 → 確かめのダイアログ(いいえ → 送らない)
  await page.fill(".reply-form textarea", "仮のPINは 1234 です");
  await page.click("text=返事を送る");
  await page.waitForTimeout(300);
  assert.ok(errors.some((e) => e.startsWith("dialog: ログイン前の問い合わせ")));
  assert.equal(be.st.calls.filter((c) => c.body?.action === "reply").length, 0);
  errors.length = 0;
  await page.fill(".reply-form textarea", "直接お伝えします");
  await page.click("text=返事を送る");
  await page.waitForSelector("#contact-detail-message.ok");
  const reply = be.st.calls.find((c) => c.body?.action === "reply").body;
  assert.equal(reply.via, "mail");
  assert.equal(reply.id, 12);
  assert.match(reply.request_key, /^[0-9a-f-]{36}$/);
  await page.click("text=もう一度送る");
  await page.waitForTimeout(300);
  assert.equal(be.st.calls.filter((c) => c.body?.action === "resend").length, 1);
  // 受信メール
  await page.click('.chip[data-filter="unmatched"]');
  await page.waitForSelector(".unmatched");
  await page.fill(".unmatched textarea", "回答です");
  await page.click(".unmatched >> text=返信する");
  await page.waitForSelector("#contact-list-message.ok");
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("管理画面: 前の返事がもう届いていて文が違うときは、直した文は送っていないと知らせる(Q6)", async () => {
  const { page, ctx } = await open("admin.html", { userId: "a1", opts: { profile: ADMIN, replyDuplicate: true }, viewport: { width: 1200, height: 900 } });
  await page.click('.dtab[data-tab="contact"]');
  await page.click(".contact-item >> nth=0");
  await page.waitForSelector(".reply-form textarea");
  await page.fill(".reply-form textarea", "直した文");
  await page.click("text=返事を送る");
  await page.waitForSelector("#contact-detail-message.error");
  assert.ok((await page.textContent("#contact-detail-message")).includes("直した文は送っていません"));
  await ctx.close();
});

await check("管理画面: 区所の名前は60文字まで(Q9)", async () => {
  const { page, ctx, be } = await open("admin.html", { userId: "a1", opts: { profile: ADMIN }, viewport: { width: 1200, height: 900 } });
  await page.waitForSelector("#new-office", { state: "attached" });
  assert.equal(await page.getAttribute("#new-office", "maxlength"), "60");
  await ctx.close();
  void be;
});

await check("管理画面: お知らせを出す・直す・消す。期間の誤りは止める", async () => {
  const { page, ctx, be, errors } = await open("admin.html#notices", { userId: "a1", opts: { profile: ADMIN }, viewport: { width: 1200, height: 900 } });
  await page.waitForSelector("#notice-list .notice-admin-row");
  assert.equal(await page.inputValue("#notice-start"), today);
  await page.click("#notice-save");
  assert.equal(await page.textContent("#notice-message"), "タイトルを入力してください。");
  await page.fill("#notice-title", "新しいお知らせ");
  await page.fill("#notice-body", "本文");
  await page.check('input[name="notice-level"][value="important"]');
  await page.fill("#notice-end", "2000-01-01");
  await page.click("#notice-save");
  assert.ok((await page.textContent("#notice-message")).includes("始まりの日と同じか、それより後"));
  await page.fill("#notice-end", "");
  await page.click("#notice-save");
  await page.waitForSelector("#notice-message.ok");
  const post = be.st.calls.find((c) => c.path === "/rest/v1/notices" && c.method === "POST").body;
  assert.deepEqual({ ...post }, { title: "新しいお知らせ", body: "本文", level: "important", starts_on: today, ends_on: null });
  await page.click("#notice-list >> text=編集 >> nth=0");
  assert.equal(await page.inputValue("#notice-title"), "新しいお知らせ");
  await page.fill("#notice-title", "直したお知らせ");
  await page.click("#notice-save");
  await page.waitForSelector("#notice-message.ok");
  assert.ok(be.st.calls.some((c) => c.path === "/rest/v1/notices" && c.method === "PATCH"));
  await page.screenshot({ path: OUT + "admin-notices.png", fullPage: true });
  assert.deepEqual(errors, []);
  page.on("dialog", (d) => d.accept());
  await ctx.close();
});

// ---------- 通信まわり(G・H・I・J) ----------
await check("管理画面: URL に #users が付いていても、読み込み失敗の理由が消えない。英語の通信エラーは日本語にする(G・J)", async () => {
  const a = await open("admin.html#users", { userId: "a1", opts: { profile: ADMIN, statsFail: true }, viewport: { width: 1200, height: 900 } });
  await a.page.waitForFunction(() => document.getElementById("message").textContent.includes("statement timeout"));
  assert.ok((await a.page.textContent("#message")).includes("statement timeout"));
  assert.ok((await a.page.getAttribute("#message", "class")).includes("error"));
  await a.ctx.close();
  const b = await open("admin.html#users", { userId: "a1", opts: { profile: ADMIN, statsAbort: true }, viewport: { width: 1200, height: 900 } });
  await b.page.waitForFunction(() => document.getElementById("message").textContent.includes("通信に失敗しました"));
  assert.ok(!(await b.page.textContent("#message")).includes("Failed to fetch"));
  await b.ctx.close();
});

await check("お知らせのページ: 読めなかったときは「見た記録」を触らない。赤い点も出さない(H)", async () => {
  const { page, ctx } = await open("notices.html", {
    userId: "u1",
    opts: { profile: USER, noticesFail: true },
    beforeLoad: (pg) => pg.addInitScript(() => { if (!localStorage.getItem("__seeded")) { localStorage.setItem("shiftflow-notices-seen", JSON.stringify(["1:2026-10-06T00:00:00Z"])); localStorage.setItem("__seeded", "1"); } }),
  });
  await page.waitForFunction(() => document.getElementById("message").textContent.includes("読み込めませんでした"));
  assert.equal(await page.evaluate(() => localStorage.getItem("shiftflow-notices-seen")), JSON.stringify(["1:2026-10-06T00:00:00Z"]));
  assert.equal(await page.locator("#notices .card").count(), 0);
  assert.equal(await page.locator("#nav-notices.has-dot").count(), 0);
  await ctx.close();
});

await check("お問い合わせ: 区所の取得が遅くても、フォームはすぐ出て「わからない」で送れる(I)", async () => {
  const { page, ctx, be } = await open("contact.html", { opts: { officesDelay: 20000 } });
  await page.waitForSelector("#contact-form:not(.hidden)", { timeout: 3000 });
  assert.deepEqual(await page.$$eval("#office option", (o) => o.map((x) => x.value)), ["", "わからない"]);
  await page.fill("#employee-no", "1234567");
  await page.fill("#name", "山田");
  await page.selectOption("#office", "わからない");
  await page.selectOption("#kind", "bug");
  await page.fill("#body", "遅いとき");
  await page.click("#submit");
  await page.waitForSelector("#sent:not(.hidden)");
  assert.equal(be.st.calls.find((c) => c.body?.action === "submit").body.office, "わからない");
  await ctx.close();
});

await check("お問い合わせ: 区所の一覧が読めたら、選択肢が増え、選んでいた所属は変わらない(I)", async () => {
  const { page, ctx } = await open("contact.html", { opts: { officesDelay: 1500 } });
  await page.waitForSelector("#contact-form:not(.hidden)");
  await page.selectOption("#office", "わからない");
  await page.waitForFunction(() => document.querySelectorAll("#office option").length === 4, null, { timeout: 8000 });
  assert.equal(await page.inputValue("#office"), "わからない");
  await ctx.close();
});

await check("通信の時間切れ: 返事が来ないときは、決めた時間で日本語のエラーになる(J)", async () => {
  const { page, ctx } = await open("contact.html", { opts: { contactDelay: 3000 } });
  await page.waitForSelector("#contact-form:not(.hidden)");
  const result = await page.evaluate(async () => {
    const m = await import("/js/app.js?v=dev");
    const t0 = Date.now();
    try {
      await m.callFunction("contact", { action: "mine" }, { stayOnLoss: true, timeoutMs: 400 });
      return { ok: true };
    } catch (e) {
      return { code: e.code, message: e.message, ms: Date.now() - t0 };
    }
  });
  assert.equal(result.code, "timeout");
  assert.ok(result.message.includes("通信に時間がかかっています"));
  assert.ok(result.ms < 2000, String(result.ms));
  await ctx.close();
});

// ---------- 公開直後(古い HTML と新しい JS) ----------
await check("古い HTML(版 OLD)と新しい JS(版 NEW)が混ざったら、1回だけ読み直す(E)。同じ版なら読み直さない", async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  const be = backend({});
  await page.route(SB + "/**", be.handler);
  let navs = 0;
  page.on("framenavigated", (f) => { if (f === page.mainFrame()) navs++; });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // HTML だけ版 OLD、JS の中の import は NEW(app.js を ?v=NEW で配る)にする
  await page.route(BASE + "/index.html", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, body: (await res.text()).replace("js/index.js?v=dev", "js/index.js?v=OLD1") });
  });
  await page.route(BASE + "/js/index.js*", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, body: (await res.text()).replaceAll("./app.js?v=dev", "./app.js?v=NEW1") });
  });
  await page.route(BASE + "/js/app.js*", async (route) => route.continue({ url: BASE + "/js/app.js?v=dev" }));
  await page.goto(BASE + "/index.html");
  await page.waitForTimeout(1500);
  assert.equal(navs, 2, "reload once: " + navs); // 最初の読み込み + 1回の読み直し
  assert.deepEqual(errors, []);
  await ctx.close();
  // 版が同じ(dev)なら読み直さない
  const ok = await open("index.html");
  let n2 = 0;
  ok.page.on("framenavigated", (f) => { if (f === ok.page.mainFrame()) n2++; });
  await ok.page.waitForTimeout(1200);
  assert.equal(n2, 0);
  await ok.ctx.close();
});

// ---------- 狭い画面 ----------
await check("幅320px: 管理画面のお問い合わせ一覧が、長い名前でもはみ出さない", async () => {
  const { page, ctx } = await open("admin.html#contact", {
    userId: "a1", opts: { profile: ADMIN, longName: true }, viewport: { width: 320, height: 640 },
  });
  await page.waitForSelector(".contact-item");
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  assert.ok(sw <= iw, `${sw} > ${iw}`);
  await ctx.close();
});

await check("幅320px: 横にはみ出さない(N9)", async () => {
  for (const [path, userId, profile] of [["index.html"], ["contact.html"], ["contact.html", "u1", USER], ["notices.html", "u1", USER]]) {
    const { page, ctx } = await open(path, { userId, opts: { profile }, viewport: { width: 320, height: 640 } });
    await page.waitForTimeout(1200);
    const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    assert.ok(sw <= iw, `${path} ${userId || ""}: ${sw} > ${iw}`);
    await page.screenshot({ path: OUT + `w320-${path.replace(".html", "")}${userId ? "-member" : ""}.png`, fullPage: true });
    await ctx.close();
  }
});

await browser.close();
server.kill();
console.log(failures.length ? `\n${failures.length} NG` : "\nall ok");
process.exit(failures.length ? 1 : 0);
