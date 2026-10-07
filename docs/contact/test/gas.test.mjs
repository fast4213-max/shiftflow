// GAS の Code.gs を、Gmail などの偽物の上で動かして確かめる(node docs/contact/test/gas.test.mjs)
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const code = fs.readFileSync(new URL("../gas/Code.gs", import.meta.url), "utf8");
const SELF = "shiftflow.kinmu@gmail.com";

function world() {
  const props = new Map([["SECRET", "s".repeat(32)], ["HOOK_URL", "https://abc.supabase.co/functions/v1/mail-inbound"]]);
  const cache = new Map();
  const labels = new Map();
  const threads = [];
  const sent = [];
  const hooks = [];
  let seq = 100;
  let quota = 100;
  const locks = { n: 0 };
  let hookResponse = (p) => ({ ok: true, known: (p.mails || []).map((m) => m.id) });
  const mkLabel = (name) => labels.get(name) || (labels.set(name, { name }), labels.get(name));
  function mkThread() {
    const t = { id: "t" + (++seq).toString(16), messages: [], labels: new Set(), trashed: false,
      getId: () => t.id, getMessages: () => t.messages, addLabel: (l) => t.labels.add(l.name),
      getLastMessageDate: () => t.messages.at(-1).getDate(), moveToTrash: () => { t.trashed = true; } };
    threads.push(t);
    return t;
  }
  function mkMessage(thread, { from, to, subject, body, date = new Date(), attachments = [], replyTo = "" }) {
    const m = { id: "m" + (++seq).toString(16), from, to, subject, body, date, thread,
      getId: () => m.id, getFrom: () => from, getReplyTo: () => replyTo, getSubject: () => subject, getPlainBody: () => body, getBody: () => body,
      getDate: () => date, getThread: () => thread, isInTrash: () => false,
      getAttachments: () => attachments.map((n) => ({ getName: () => n })),
      createDraftReply: (b, opts) => ({ send: () => { quota--; const r = mkMessage(thread, { from: `${opts.name} <${SELF}>`, to: address(from), subject: "Re: " + subject, body: b }); sent.push(r); return r; } }) };
    thread.messages.push(m);
    return m;
  }
  const address = (s) => (s.match(/<([^>]+)>/)?.[1] ?? s).toLowerCase();
  const ctx = {
    console, JSON, Date, Math, String, Number, Array, Object, Error,
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => props.get(k) ?? null, setProperty: (k, v) => props.set(k, v), deleteProperty: (k) => props.delete(k),
      getProperties: () => Object.fromEntries(props) }) },
    Session: { getEffectiveUser: () => ({ getEmail: () => "Shiftflow.Kinmu@gmail.com" }) },
    ContentService: { MimeType: { JSON: "json" }, createTextOutput: (s) => ({ setMimeType: () => ({ body: JSON.parse(s) }) }) },
    LockService: { getScriptLock: () => { locks.n++; return { tryLock: () => true, releaseLock: () => {} }; } },
    CacheService: { getScriptCache: () => ({ get: (k) => cache.get(k) ?? null, put: (k, v) => cache.set(k, v),
      getAll: (ks) => Object.fromEntries(ks.filter((k) => cache.has(k)).map((k) => [k, cache.get(k)])) }) },
    MailApp: { getRemainingDailyQuota: () => quota },
    Utilities: { base64Decode: (s) => [...Buffer.from(s, "base64")], newBlob: (b, t, n) => ({ b, t, n }), getUuid: () => crypto.randomUUID() },
    GmailApp: {
      getUserLabelByName: (n) => labels.get(n) ?? null, createLabel: mkLabel,
      getMessageById: (id) => { for (const t of threads) for (const m of t.messages) if (m.id === id) return m; throw new Error("not found"); },
      createDraft: (to, subject, body, opts) => ({ send: () => { quota--; const t = mkThread(); const m = mkMessage(t, { from: `${opts.name} <${SELF}>`, to, subject, body, attachments: (opts.attachments || []).map((a) => a.n) }); sent.push(m); if (to === SELF) mkMessage(t, { from: `${opts.name} <${SELF}>`, to, subject, body }); return m; } }),
      search: (q, start, max) => {
        if (q.startsWith("in:inbox")) return threads.filter((t) => !t.trashed).slice(start ?? 0, (start ?? 0) + (max ?? 500));
        if (q.startsWith("label:shiftflow")) return threads.filter((t) => t.labels.has("shiftflow") && !t.trashed);
        return [];
      },
    },
    UrlFetchApp: { fetch: (url, opts) => { const p = JSON.parse(opts.payload); hooks.push(p); const r = hookResponse(p);
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify(r) }; } },
    ScriptApp: { getProjectTriggers: () => [], deleteTrigger() {}, newTrigger: () => ({ timeBased: () => ({ everyMinutes: () => ({ create() {} }), everyDays: () => ({ atHour: () => ({ create() {} }) }) }) }) },
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return { ctx, props, cache, labels, threads, sent, hooks, locks, mkThread, mkMessage, setHook: (f) => (hookResponse = f), setQuota: (q) => (quota = q) };
}

const post = (w, body) => w.ctx.doPost({ postData: { contents: JSON.stringify({ secret: "s".repeat(32), ts: Date.now(), ...body }) } }).body;

// 合言葉・時刻
{
  const w = world();
  assert.equal(w.ctx.doPost({ postData: { contents: JSON.stringify({ secret: "x", ts: Date.now(), action: "ping" }) } }).body.ok, false);
  assert.equal(w.ctx.doPost({ postData: { contents: "not json" } }).body.ok, false);
  assert.equal(post(w, { action: "ping", ts: Date.now() - 20 * 60000 }).ok, false);
  const ping = post(w, { action: "ping" });
  assert.equal(ping.ok, true);
  assert.equal(ping.address, SELF);
  console.log("ok secret/ping");
}
// 返事(新規): 件名の制限・二重送信の防止
{
  const w = world();
  const r1 = post(w, { action: "reply", key: "reply-aaaaaaaa", to: "Taro@Gmail.com", subject: "【shiftflow 勤務登録】お問い合わせ #0001 への返事", body: "本文" });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  const r2 = post(w, { action: "reply", key: "reply-aaaaaaaa", to: "taro@gmail.com", subject: "【shiftflow 勤務登録】お問い合わせ #0001 への返事", body: "本文" });
  assert.equal(r2.duplicate, true);
  assert.equal(r2.message_id, r1.message_id);
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0].to, "taro@gmail.com");
  assert.ok(w.threads[0].labels.has("shiftflow") && w.threads[0].labels.has("shiftflow/返事"));
  const spam = post(w, { action: "reply", key: "reply-bbbbbbbb", to: "x@y.com", subject: "安いです", body: "spam" });
  assert.equal(spam.ok, false);
  const badTo = post(w, { action: "reply", key: "reply-cccccccc", to: "x", subject: "【shiftflow 勤務登録】x", body: "b" });
  assert.equal(badTo.ok, false);
  const badKey = post(w, { action: "reply", key: "../", to: "x@y.com", subject: "【shiftflow 勤務登録】x", body: "b" });
  assert.equal(badKey.ok, false);
  w.setQuota(0);
  const noQuota = post(w, { action: "reply", key: "reply-dddddddd", to: "x@y.com", subject: "【shiftflow 勤務登録】x", body: "b" });
  assert.ok(!noQuota.ok && noQuota.error.includes("上限"));
  console.log("ok reply new");
}
// 返事(相手のメールに返信): 差出人と宛先が違えば送らない。メールが消えていたら件名で新しく送る
{
  const w = world();
  const t = w.mkThread();
  const incoming = w.mkMessage(t, { from: "山田 <taro@gmail.com>", subject: "Re: お問い合わせ #0001", body: "hi" });
  const ok = post(w, { action: "reply", key: "reply-eeeeeeee", to: "taro@gmail.com", subject: "【shiftflow 勤務登録】お問い合わせ #0001 への返事", body: "b", reply_to_message_id: incoming.id });
  assert.equal(ok.ok, true);
  assert.equal(ok.thread_id, t.id);
  assert.equal(w.sent[0].to, "taro@gmail.com");
  const wrong = post(w, { action: "reply", key: "reply-ffffffff", to: "other@x.com", subject: "【shiftflow 勤務登録】x", body: "b", reply_to_message_id: incoming.id });
  assert.ok(!wrong.ok && wrong.error.includes("違います"));
  const gone = post(w, { action: "reply", key: "reply-gggggggg", to: "taro@gmail.com", subject: "【shiftflow 勤務登録】x", body: "b", reply_to_message_id: "deadbeef" });
  assert.equal(gone.ok, true);
  const goneUnmatched = post(w, { action: "reply", key: "reply-hhhhhhhh", to: "taro@gmail.com", subject: "Re: 質問", body: "b", reply_to_message_id: "deadbeef" });
  assert.ok(!goneUnmatched.ok && goneUnmatched.error.includes("見つかりません"));
  console.log("ok reply thread");
}
// 送信元の偽装(C): 表示名に別のアドレスを入れても、本物(最後の <…>)で判断する。Reply-To が別なら返信せず、新しく送る
{
  const w = world();
  const t = w.mkThread();
  const spoof = w.mkMessage(t, { from: '"本人 <victim@gmail.com>" <attacker@evil.example>', subject: "Re: お問い合わせ #0001", body: "hi" });
  const wrong = post(w, { action: "reply", key: "reply-spoof001", to: "victim@gmail.com", subject: "【shiftflow 勤務登録】x", body: "b", reply_to_message_id: spoof.id });
  assert.ok(!wrong.ok && wrong.error.includes("違います"), JSON.stringify(wrong));
  assert.equal(w.sent.length, 0);
  const t2 = w.mkThread();
  const tricky = w.mkMessage(t2, { from: "山田 <taro@gmail.com>", subject: "Re: お問い合わせ #0001", body: "hi", replyTo: "Evil <attacker@evil.example>" });
  const r = post(w, { action: "reply", key: "reply-spoof002", to: "taro@gmail.com", subject: "【shiftflow 勤務登録】お問い合わせ #0001 への返事", body: "b", reply_to_message_id: tricky.id });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(w.sent[0].to, "taro@gmail.com"); // Reply-To の attacker ではなく、確かめた宛先へ(新しいメール)
  assert.notEqual(r.thread_id, t2.id);
  // 受信の取り込みでも、自分を装った送信元("<自分>" <attacker>)を自分のメールとして飛ばさない
  const w2 = world();
  const t3 = w2.mkThread();
  const fake = w2.mkMessage(t3, { from: '"<shiftflow.kinmu@gmail.com>" <attacker@evil.example>', subject: "お問い合わせ #0001", body: "x" });
  w2.ctx.pollInbox();
  assert.deepEqual(w2.hooks.at(-1).mails.map((m) => m.id), [fake.id]);
  console.log("ok spoofed sender");
}
// 受付メール(画像つき): 自分宛て・ラベル・二重送信の防止
{
  const w = world();
  const img = Buffer.from([0xff, 0xd8, 0xff, 1]).toString("base64");
  const r = post(w, { action: "receipt", key: "receipt-11111111", subject: "【shiftflow 受付】#0001 不具合(画像1枚)", body: "b", images: [{ name: "0001-1.jpg", type: "image/jpeg", data: img }] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(w.sent[0].to, SELF);
  assert.deepEqual(w.sent[0].getAttachments().map((a) => a.getName()), ["0001-1.jpg"]);
  assert.ok(w.threads[0].labels.has("shiftflow/受付"));
  assert.equal(post(w, { action: "receipt", key: "receipt-11111111", subject: "【shiftflow 受付】#0001", body: "b", images: [] }).duplicate, true);
  assert.equal(post(w, { action: "receipt", key: "receipt-22222222", subject: "spam", body: "b", images: [] }).ok, false);
  const big = Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64");
  assert.equal(post(w, { action: "receipt", key: "receipt-33333333", subject: "【shiftflow 受付】x", body: "b", images: [{ data: big }] }).ok, false);
  console.log("ok receipt");
}
// 受信の取り込み: 自分・Google のお知らせは渡さない。渡せたものは次から送らない。何も無いときは10分に1回だけ生きている知らせ
{
  const w = world();
  // 自分の受付メール(自分宛て)
  post(w, { action: "receipt", key: "receipt-44444444", subject: "【shiftflow 受付】#0002 x(画像0枚)", body: "b", images: [] });
  const t = w.mkThread();
  const m1 = w.mkMessage(t, { from: "山田 <taro@gmail.com>", subject: "Re: お問い合わせ #0001", body: "", attachments: ["a.jpg"] });
  m1.getBody = () => "<p>こんにちは<br>山田</p><style>x{}</style>";
  w.mkMessage(w.mkThread(), { from: "Google <no-reply@accounts.google.com>", subject: "セキュリティ通知", body: "x" });
  const bounce = w.mkMessage(w.mkThread(), { from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", subject: "Delivery Status Notification", body: "x" });
  w.mkMessage(w.mkThread(), { from: "old <old@x.com>", subject: "old", body: "x", date: new Date(Date.now() - 20 * 86400000) });
  w.ctx.pollInbox();
  const call = w.hooks.at(-1);
  assert.equal(call.action, "mail");
  assert.deepEqual(call.mails.map((m) => m.id), [m1.id, bounce.id]);
  assert.equal(call.mails[0].body.trim(), "こんにちは\n山田");
  assert.deepEqual(call.mails[0].attachments, ["a.jpg"]);
  assert.equal(call.self, SELF);
  assert.ok(t.labels.has("shiftflow/受信"));
  const before = w.hooks.length;
  w.ctx.pollInbox(); // 何も新しくない → 直前に知らせたので heartbeat も送らない
  assert.equal(w.hooks.length, before);
  w.cache.delete("heartbeat");
  w.ctx.pollInbox();
  assert.equal(w.hooks.at(-1).action, "heartbeat");
  // Supabase が受け取れなかったメールは、次の回にもう一度送る
  const w2 = world();
  const t2 = w2.mkThread();
  const a = w2.mkMessage(t2, { from: "a@x.com", subject: "s", body: "b" });
  w2.setHook(() => ({ ok: true, known: [] }));
  w2.ctx.pollInbox();
  w2.setHook((p) => ({ ok: true, known: p.mails.map((m) => m.id) }));
  w2.ctx.pollInbox();
  assert.deepEqual(w2.hooks.map((h) => h.mails?.map((m) => m.id)), [[a.id], [a.id]]);
  // Supabase がエラーなら例外(トリガーの失敗として Google からメールが届く)
  w2.setHook(() => ({ ok: false, error: "bad" }));
  w2.mkMessage(t2, { from: "b@x.com", subject: "s", body: "b" });
  assert.throws(() => w2.ctx.pollInbox(), /Supabase/);
  console.log("ok pollInbox");
}
// 6時間の記録が切れても、全部渡せた時刻の1日前より古いメールは送り直さない。渡せなかったときは時刻を進めない(Q7)
{
  const w = world();
  const t = w.mkThread();
  const old = w.mkMessage(t, { from: "a@x.com", subject: "s", body: "3日前", date: new Date(Date.now() - 3 * 86400000) });
  w.ctx.pollInbox();
  assert.deepEqual(w.hooks.at(-1).mails.map((m) => m.id), [old.id]);
  assert.ok(w.props.has("inbox_checked_at"));
  w.cache.clear(); // 6時間たって記録が切れた
  const fresh = w.mkMessage(t, { from: "a@x.com", subject: "s", body: "新しい" });
  w.ctx.pollInbox();
  assert.deepEqual(w.hooks.at(-1).mails.map((m) => m.id), [fresh.id]); // 3日前のものは送り直さない
  // Supabase が受け取れなかったら時刻を進めず、次の回(記録が切れたあとも)にもう一度送る
  const w2 = world();
  const m = w2.mkMessage(w2.mkThread(), { from: "a@x.com", subject: "s", body: "b", date: new Date(Date.now() - 3 * 86400000) });
  w2.setHook(() => ({ ok: true, known: [] }));
  w2.ctx.pollInbox();
  assert.equal(w2.props.has("inbox_checked_at"), false);
  w2.setHook((p) => ({ ok: true, known: p.mails.map((x) => x.id) }));
  w2.ctx.pollInbox();
  assert.deepEqual(w2.hooks.at(-1).mails.map((x) => x.id), [m.id]);
  // 1回に送るのは30件まで。残りがあるときは時刻を進めない
  const w3 = world();
  const t3 = w3.mkThread();
  for (let i = 0; i < 35; i++) w3.mkMessage(t3, { from: "a@x.com", subject: "s", body: "b" + i });
  w3.ctx.pollInbox();
  assert.equal(w3.hooks.at(-1).mails.length, 30);
  assert.equal(w3.props.has("inbox_checked_at"), false);
  w3.ctx.pollInbox();
  assert.equal(w3.hooks.at(-1).mails.length, 5);
  assert.ok(w3.props.has("inbox_checked_at"));
  console.log("ok poll window");
}
// スレッドが多くても(以前は50件ちょうどで1件も渡さなかった)、見つけた分は渡す(S1)。2万字の切れ目の絵文字は半分を残さない(S13)
{
  const w = world();
  for (let i = 0; i < 60; i++) w.mkMessage(w.mkThread(), { from: "a@x.com", subject: "s", body: "b" + i });
  w.ctx.pollInbox();
  assert.equal(w.hooks.at(-1).action, "mail");
  assert.equal(w.hooks.at(-1).mails.length, 30);
  const w2 = world();
  for (let i = 0; i < 210; i++) w2.mkMessage(w2.mkThread(), { from: "a@x.com", subject: "s", body: "b" + i });
  w2.ctx.pollInbox();
  assert.equal(w2.hooks.at(-1).mails.length, 30);
  assert.equal(w2.props.has("inbox_checked_at"), false); // 探す数の上限に当たったので時刻は進めない
  const w3 = world();
  const long = "あ".repeat(19999) + "😀" + "続き";
  w3.mkMessage(w3.mkThread(), { from: "a@x.com", subject: "s", body: long });
  w3.ctx.pollInbox();
  const body = w3.hooks.at(-1).mails[0].body;
  assert.equal(body.length, 19999);
  assert.ok(!/[\uD800-\uDFFF]/.test(body));
  console.log("ok poll many threads / emoji cut");
}
// 送信後のラベル付けが失敗しても、送信は成功扱い。送り直しで2通目を送らない
{
  const w = world();
  const orig = w.ctx.GmailApp.getUserLabelByName;
  w.ctx.GmailApp.createLabel = () => { throw new Error("label service down"); };
  w.ctx.GmailApp.getUserLabelByName = () => null;
  const a = post(w, { action: "reply", key: "reply-label001", to: "taro@gmail.com", subject: "【shiftflow 勤務登録】お問い合わせ #0001 への返事", body: "b" });
  assert.equal(a.ok, true, JSON.stringify(a));
  const b = post(w, { action: "reply", key: "reply-label001", to: "taro@gmail.com", subject: "【shiftflow 勤務登録】お問い合わせ #0001 への返事", body: "b" });
  assert.equal(b.duplicate, true);
  assert.equal(w.sent.length, 1);
  void orig;
  console.log("ok label failure");
}
// 受信の確認は、スクリプトのロックを使わない(返事の送信を待たせない)。前の回が動いているときは何もしない
{
  const w = world();
  w.mkMessage(w.mkThread(), { from: "a@x.com", subject: "s", body: "b" });
  w.ctx.pollInbox();
  assert.equal(w.locks.n, 0);
  assert.equal(w.props.has("polling_since"), false); // 終わったら消える
  w.cache.clear();
  w.props.set("polling_since", String(Date.now())); // 前の回が動いている
  const n = w.hooks.length;
  w.ctx.pollInbox();
  assert.equal(w.hooks.length, n);
  w.props.set("polling_since", String(Date.now() - 6 * 60 * 1000)); // 古い印(止まった回)は無視する
  w.ctx.pollInbox();
  assert.ok(w.hooks.length > n);
  console.log("ok poll without lock");
}
// 1日1回の掃除: 最後のメールが90日より前のスレッドだけゴミ箱へ。送った記録の古いものを消す
{
  const w = world();
  const old = w.mkThread();
  w.mkMessage(old, { from: "a@x.com", subject: "s", body: "b", date: new Date(Date.now() - 100 * 86400000) });
  old.addLabel({ name: "shiftflow" });
  const mixed = w.mkThread();
  w.mkMessage(mixed, { from: "a@x.com", subject: "s", body: "b", date: new Date(Date.now() - 100 * 86400000) });
  w.mkMessage(mixed, { from: "a@x.com", subject: "s", body: "b", date: new Date() });
  mixed.addLabel({ name: "shiftflow" });
  const other = w.mkThread();
  w.mkMessage(other, { from: "a@x.com", subject: "s", body: "b", date: new Date(Date.now() - 100 * 86400000) });
  w.props.set("sent:old", JSON.stringify({ at: Date.now() - 31 * 86400000 }));
  w.props.set("sent:new", JSON.stringify({ at: Date.now() }));
  w.ctx.dailyCleanup();
  assert.deepEqual([old.trashed, mixed.trashed, other.trashed], [true, false, false]);
  assert.equal(w.hooks.at(-1).action, "maintenance");
  assert.equal(w.hooks.at(-1).gmail_trashed, 1);
  assert.ok(!w.props.has("sent:old") && w.props.has("sent:new") && w.props.has("SECRET"));
  console.log("ok dailyCleanup");
}
// setup・makeSecret
{
  const w = world();
  w.ctx.setup();
  assert.ok(["shiftflow", "shiftflow/受付", "shiftflow/返事", "shiftflow/受信"].every((n) => w.labels.has(n)));
  w.ctx.makeSecret();
  assert.match(w.props.get("SECRET"), /^[0-9a-f]{64}$/);
  w.props.set("HOOK_URL", "https://evil.example/x");
  assert.throws(() => w.ctx.setup(), /HOOK_URL/);
  console.log("ok setup");
}
