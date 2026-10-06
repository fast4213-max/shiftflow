// Discord の Webhook と GAS(メールの中継)を呼ぶ部分のテスト(通信は偽物)
//   deno test supabase/functions --allow-read --allow-env

import { assert, assertEquals } from "jsr:@std/assert@1";
import { discordFromEnv } from "./discord.ts";
import { relayFromEnv } from "./mail-relay.ts";
import type { DiscordPayload } from "./contact.ts";

const WEBHOOK = "https://discord.com/api/webhooks/123456/secret-token";
const RELAY = "https://script.google.com/macros/s/AKfycbTEST/exec";
const PAYLOAD: DiscordPayload = { embeds: [{ title: "t" }], allowed_mentions: { parse: [] } };

type Call = { url: string; init: RequestInit };
function fakeFetch(responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const fn = (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses.shift() ?? new Response("{}", { status: 200 });
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  };
  return { calls, fn: fn as typeof fetch };
}

function withEnv(vars: Record<string, string | undefined>, f: () => Promise<void>) {
  return async () => {
    const old: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
      old[k] = Deno.env.get(k);
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
    try {
      await f();
    } finally {
      for (const [k, v] of Object.entries(old)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
    }
  };
}

Deno.test(
  "Discord: ?wait=true で送ってメッセージIDを受け取る。画像は multipart で付ける(D8・D10)",
  withEnv({ DISCORD_WEBHOOK_URL: WEBHOOK }, async () => {
    const f = fakeFetch([new Response(JSON.stringify({ id: "9876543210" })), new Response(JSON.stringify({ id: "9876543211" }))]);
    const d = discordFromEnv(f.fn);
    assert(d.configured);
    assertEquals(await d.post(PAYLOAD), { ok: true, id: "9876543210" });
    assertEquals(f.calls[0].url, WEBHOOK + "?wait=true");
    assertEquals(JSON.parse(String(f.calls[0].init.body)), PAYLOAD);

    await d.post(PAYLOAD, [{ name: "0001-1.jpg", type: "image/jpeg", bytes: new Uint8Array([0xff, 0xd8, 0xff]) }]);
    const form = f.calls[1].init.body as FormData;
    assertEquals(JSON.parse(String(form.get("payload_json"))), PAYLOAD);
    const file = form.get("files[0]") as File;
    assertEquals([file.name, file.type, file.size], ["0001-1.jpg", "image/jpeg", 3]);
  }),
);

Deno.test(
  "Discord: 回数制限(429)は短ければ1回だけ待ってやり直す。エラーに URL(秘密)を入れない(D5・D6)",
  withEnv({ DISCORD_WEBHOOK_URL: WEBHOOK }, async () => {
    const f = fakeFetch([
      new Response(JSON.stringify({ retry_after: 0.01 }), { status: 429 }),
      new Response(JSON.stringify({ id: "111111" })),
    ]);
    const d = discordFromEnv(f.fn);
    assertEquals(await d.post(PAYLOAD), { ok: true, id: "111111" });
    assertEquals(f.calls.length, 2);

    const f2 = fakeFetch([new Response("too big", { status: 413 })]);
    const res = await discordFromEnv(f2.fn).post(PAYLOAD);
    assertEquals(res.ok, false);
    assert(!JSON.stringify(res).includes("secret-token"));

    const f3 = fakeFetch([new TypeError("network " + WEBHOOK), new TypeError("network " + WEBHOOK)]);
    const res3 = await discordFromEnv(f3.fn).post(PAYLOAD);
    assertEquals(res3.ok, false);
    assert(!JSON.stringify(res3).includes("secret-token"), JSON.stringify(res3));
  }),
);

Deno.test(
  "Discord: 通知の削除(数字でない ID は送らない)",
  withEnv({ DISCORD_WEBHOOK_URL: WEBHOOK }, async () => {
    const f = fakeFetch([new Response(null, { status: 204 }), new Response("{}", { status: 404 })]);
    const d = discordFromEnv(f.fn);
    assertEquals(await d.remove("111111"), { ok: true, status: 204 });
    assertEquals(f.calls[0].url, WEBHOOK + "/messages/111111");
    assertEquals(f.calls[0].init.method, "DELETE");
    assertEquals(await d.remove("222222"), { ok: false, status: 404 });
    assertEquals(await d.remove("../x"), { ok: false, status: 400 });
    assertEquals(f.calls.length, 2);
  }),
);

Deno.test(
  "Discord: Webhook が未設定・形が違うときは送らない",
  withEnv({ DISCORD_WEBHOOK_URL: "https://example.com/hook" }, async () => {
    const f = fakeFetch([]);
    const d = discordFromEnv(f.fn);
    assertEquals(d.configured, false);
    assertEquals((await d.post(PAYLOAD)).ok, false);
    assertEquals(f.calls.length, 0);
  }),
);

const REQ = { key: "reply-k1", to: "a@b.com", subject: "s", body: "b", reply_to_message_id: null };

Deno.test(
  "GAS: 合言葉と時刻を付けて送り、リダイレクトを追う。結果を読む(M3・M9)",
  withEnv({ MAIL_RELAY_URL: RELAY, MAIL_RELAY_SECRET: "x".repeat(32) }, async () => {
    const f = fakeFetch([new Response(JSON.stringify({ ok: true, message_id: "m1", thread_id: "t1", quota: 98 }))]);
    const r = relayFromEnv(f.fn);
    assertEquals(await r.reply(REQ), { ok: true, message_id: "m1", thread_id: "t1", quota: 98, duplicate: false });
    assertEquals(f.calls[0].url, RELAY); // 合言葉は URL に入れない
    assertEquals(f.calls[0].init.redirect, "follow");
    const sent = JSON.parse(String(f.calls[0].init.body));
    assertEquals([sent.action, sent.secret, sent.key, sent.to], ["reply", "x".repeat(32), "reply-k1", "a@b.com"]);
    assert(Math.abs(sent.ts - Date.now()) < 5000);
  }),
);

Deno.test(
  "GAS: 応答が JSON でない(公開設定の誤り)・エラー・時間切れを見分ける(M2・M5)",
  withEnv({ MAIL_RELAY_URL: RELAY, MAIL_RELAY_SECRET: "x".repeat(32) }, async () => {
    const f = fakeFetch([
      new Response("<html>Google ログイン</html>"),
      new Response(JSON.stringify({ ok: false, error: "1日の送信数の上限です" })),
      new DOMException("signal timed out", "TimeoutError") as unknown as Error,
      new Response("", { status: 500 }),
      new Response("", { status: 403 }),
    ]);
    const r = relayFromEnv(f.fn);
    const html = await r.reply(REQ);
    assert(!html.ok && html.kind === "failed" && html.error.includes("全員"));
    const err = await r.reply(REQ);
    assert(!err.ok && err.kind === "failed" && err.error.includes("上限"));
    const timeout = await r.reply(REQ);
    assert(!timeout.ok && timeout.kind === "unknown");
    const f2 = fakeFetch([new TypeError("error sending request for url (" + RELAY + ")")]);
    const net = await relayFromEnv(f2.fn).reply(REQ);
    assert(!net.ok && net.kind === "unknown" && !net.error.includes("AKfycbTEST"), JSON.stringify(net));
    const s500 = await r.receipt({ key: "k", subject: "s", body: "b", images: [] });
    assert(!s500.ok && s500.kind === "unknown");
    const s403 = await r.reply(REQ);
    assert(!s403.ok && s403.kind === "failed");
  }),
);

Deno.test(
  "GAS: URL の形が違う・合言葉が短いときは送らない",
  withEnv({ MAIL_RELAY_URL: "https://script.google.com/macros/s/x/dev", MAIL_RELAY_SECRET: "x".repeat(32) }, async () => {
    const f = fakeFetch([]);
    const r = relayFromEnv(f.fn);
    assertEquals(r.configured, false);
    assertEquals((await r.reply(REQ)).ok, false);
    assertEquals(f.calls.length, 0);
  }),
);
