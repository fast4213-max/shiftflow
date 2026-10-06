// お問い合わせの流れのテスト(DB・Discord・GAS は偽物)
//   deno test supabase/functions --allow-read --allow-env

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  adminGet,
  adminList,
  adminReply,
  adminReplyUnmatched,
  adminResend,
  adminSetStatus,
  checkHookSecret,
  type Deps,
  ingestMails,
  type Inquiry,
  listMine,
  maintenance,
  type Message,
  type NewMessage,
  type Repo,
  submitInquiry,
  viewInquiry,
} from "./contact-core.ts";
import { encodeBase64 } from "./contact.ts";
import type { DiscordFile, DiscordResult } from "./discord.ts";
import { AppError } from "./http.ts";
import type { DiscordPayload } from "./contact.ts";
import type { ReceiptRequest, RelayResult, ReplyRequest } from "./mail-relay.ts";

const JPEG = encodeBase64(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6]));
const SELF = "shiftflow.kinmu@gmail.com";
let keySeq = 0;
const key = () => `00000000-0000-4000-8000-${String(++keySeq).padStart(12, "0")}`;

// ---------- 偽物 ----------

function fakeRepo() {
  const inquiries: Inquiry[] = [];
  const messages: Message[] = [];
  const rate = new Map<string, number>();
  const discordPosts: { id: string; inquiry_id: number | null; created_at: number }[] = [];
  const status: Record<string, { value: Record<string, unknown>; updated_at: string }> = {};
  const members: Record<string, { role: string; employeeNo: string | null; name: string; officeName: string | null }> = {
    "user-1": { role: "user", employeeNo: "1234567", name: "山田 太郎", officeName: "A区所" },
    "user-2": { role: "user", employeeNo: "7654321", name: "佐藤 花子", officeName: null },
    "admin-1": { role: "admin", employeeNo: null, name: "", officeName: null },
  };
  let msgSeq = 0;
  const repo: Repo = {
    rateHit(k, max) {
      const n = (rate.get(k) ?? 0) + 1;
      rate.set(k, n);
      return Promise.resolve(n <= max);
    },
    memberInfo: (id) => Promise.resolve(members[id] ?? null),
    createInquiry(row) {
      const old = inquiries.find((i) => i.request_key === row.request_key);
      if (old) return Promise.resolve({ id: old.id, duplicate: true });
      const now = new Date().toISOString();
      const inq = {
        id: inquiries.length + 1,
        request_key: String(row.request_key),
        user_id: (row.user_id as string) ?? null,
        logged_in: row.logged_in as boolean,
        employee_no: String(row.employee_no),
        name: String(row.name),
        office_name: String(row.office_name),
        kind: String(row.kind),
        reply_via: String(row.reply_via),
        email: (row.email as string) ?? null,
        code_hash: (row.code_hash as string) ?? null,
        status: "open",
        has_new_mail: false,
        image_count: Number(row.image_count ?? 0),
        discord_status: "pending",
        receipt_status: "none",
        receipt_message_id: null,
        last_activity_at: now,
        done_at: null,
        created_at: now,
      } as Inquiry;
      inquiries.push(inq);
      messages.push(mk({ inquiry_id: inq.id, sender: "user", channel: "web", body: String(row.body) }));
      return Promise.resolve({ id: inq.id, duplicate: false });
    },
    getInquiry: (id) => Promise.resolve(inquiries.find((i) => i.id === id) ?? null),
    updateInquiry(id, patch) {
      Object.assign(inquiries.find((i) => i.id === id)!, patch);
      return Promise.resolve();
    },
    listInquiries: (filter) =>
      Promise.resolve(inquiries.filter((i) => filter === "all" || (filter === "todo" ? i.status === "open" : i.status === "replied"))),
    countTodo: () => Promise.resolve(inquiries.filter((i) => i.status === "open").length),
    myInquiries: (userId) => Promise.resolve(inquiries.filter((i) => i.user_id === userId).reverse()),
    messages: (id) => Promise.resolve(messages.filter((m) => m.inquiry_id === id)),
    insertMessage(row) {
      if (row.request_key && messages.some((m) => m.request_key === row.request_key)) return Promise.resolve(null);
      if (row.gmail_message_id && messages.some((m) => m.gmail_message_id === row.gmail_message_id)) return Promise.resolve(null);
      const m = mk(row);
      messages.push(m);
      return Promise.resolve(m);
    },
    getMessage: (id) => Promise.resolve(messages.find((m) => m.id === id) ?? null),
    messageByRequestKey: (k) => Promise.resolve(messages.find((m) => m.request_key === k) ?? null),
    messageExists: (id) => Promise.resolve(messages.some((m) => m.gmail_message_id === id)),
    updateMessage(id, patch) {
      Object.assign(messages.find((m) => m.id === id)!, patch);
      return Promise.resolve();
    },
    inquiryIdByThread: (t) => Promise.resolve(messages.find((m) => m.gmail_thread_id === t && m.inquiry_id != null)?.inquiry_id ?? null),
    unmatchedMails: () => Promise.resolve(messages.filter((m) => m.inquiry_id == null)),
    countUnmatched: () => Promise.resolve(messages.filter((m) => m.inquiry_id == null && m.sender === "mail").length),
    profileByEmployeeNo: (no) =>
      Promise.resolve(Object.values(members).find((m) => m.employeeNo === no) ? { name: "登録者", officeName: "A区所" } : null),
    recordDiscordPost(id, inquiryId) {
      discordPosts.push({ id, inquiry_id: inquiryId, created_at: Date.now() });
      return Promise.resolve();
    },
    oldDiscordPosts: (days) => Promise.resolve(discordPosts.filter((p) => p.created_at < Date.now() - days * 86400_000).map((p) => p.id)),
    deleteDiscordPost(id) {
      discordPosts.splice(discordPosts.findIndex((p) => p.id === id), 1);
      return Promise.resolve();
    },
    setStatus(k, value) {
      status[k] = { value, updated_at: new Date().toISOString() };
      return Promise.resolve();
    },
    statuses: () => Promise.resolve(status),
    purge: () => Promise.resolve({ inquiries: 0 }),
  };
  function mk(row: NewMessage): Message {
    return {
      id: ++msgSeq,
      inquiry_id: null,
      request_key: null,
      body_full: null,
      from_email: null,
      subject: null,
      attachment_names: null,
      bounce: false,
      gmail_message_id: null,
      gmail_thread_id: null,
      mail_status: null,
      mail_error: null,
      created_at: new Date().toISOString(),
      ...row,
    } as Message;
  }
  return { repo, inquiries, messages, rate, discordPosts, status };
}

function fakeDiscord(opts: { configured?: boolean; failWithFiles?: boolean; failAll?: boolean; removeStatus?: number } = {}) {
  const posts: { payload: DiscordPayload; files: DiscordFile[] }[] = [];
  const removed: string[] = [];
  let seq = 1000;
  return {
    posts,
    removed,
    discord: {
      configured: opts.configured ?? true,
      post(payload: DiscordPayload, files: DiscordFile[] = []): Promise<DiscordResult> {
        posts.push({ payload, files });
        if (opts.failAll || (opts.failWithFiles && files.length)) return Promise.resolve({ ok: false, status: 413, error: "too large" });
        return Promise.resolve({ ok: true, id: String(++seq) });
      },
      remove(id: string) {
        removed.push(id);
        const status = opts.removeStatus ?? 204;
        return Promise.resolve({ ok: status < 300, status });
      },
    },
  };
}

function fakeRelay(opts: { configured?: boolean; result?: RelayResult } = {}) {
  const replies: ReplyRequest[] = [];
  const receipts: ReceiptRequest[] = [];
  return {
    replies,
    receipts,
    relay: {
      configured: opts.configured ?? true,
      reply(req: ReplyRequest) {
        replies.push(req);
        return Promise.resolve(opts.result ?? { ok: true as const, message_id: "abc123", thread_id: "ff0123" });
      },
      receipt(req: ReceiptRequest) {
        receipts.push(req);
        return Promise.resolve(opts.result ?? { ok: true as const, message_id: "rcpt123", thread_id: "ff0eee" });
      },
    },
  };
}

function setup(o: { discord?: Parameters<typeof fakeDiscord>[0]; relay?: Parameters<typeof fakeRelay>[0] } = {}) {
  const db = fakeRepo();
  const d = fakeDiscord(o.discord);
  const r = fakeRelay(o.relay);
  const pending: Promise<unknown>[] = [];
  const deps: Deps = { repo: db.repo, discord: d.discord, relay: r.relay, background: (p) => void pending.push(p) };
  return { deps, db, d, r, settle: () => Promise.all(pending) };
}

const guest = (extra: Record<string, unknown> = {}) => ({
  request_key: key(),
  kind: "login",
  body: "PINを忘れました",
  reply_via: "screen",
  code: "K7QM-4XPA",
  employee_no: "１２３４５６７",
  name: " 山田  太郎 ",
  office: "A区所",
  ...extra,
});

// ---------- 送信 ----------

Deno.test("ログイン前の送信: 受付番号を返し、Discord に知らせ、確認コードで返事を見られる", async () => {
  const { deps, db, d, settle } = setup();
  const res = await submitInquiry(deps, guest(), { ip: "1.1.1.1", userId: null });
  assertEquals(res, { id: 1, no: "#0001", duplicate: false, images: "none" });
  await settle();
  assertEquals(db.inquiries[0].employee_no, "1234567");
  assertEquals(db.inquiries[0].name, "山田 太郎");
  assertEquals(db.inquiries[0].discord_status, "sent");
  assert(db.inquiries[0].code_hash && !db.inquiries[0].code_hash.includes("K7QM"));
  assertEquals(d.posts.length, 1);
  assertEquals(db.discordPosts.length, 1);

  const view = await viewInquiry(deps, { no: "＃１", code: "k7qm4xpa" }, "2.2.2.2");
  assertEquals(view.no, "#0001");
  assertEquals(view.messages, [{ from: "user", body: "PINを忘れました", at: view.messages[0].at }]);
  await assertRejects(() => viewInquiry(deps, { no: "1", code: "K7QM-4XPB" }, "2.2.2.2"), AppError, "受付番号か確認コードが違います");
  await assertRejects(() => viewInquiry(deps, { no: "2", code: "K7QM-4XPA" }, "2.2.2.2"), AppError, "受付番号か確認コードが違います");
});

Deno.test("ログイン後の送信: 社員番号・名前・所属は DB から取り、画面から来た値は使わない", async () => {
  const { deps, db, settle } = setup();
  await submitInquiry(deps, guest({ mode: "member", employee_no: "9999999", name: "なりすまし", office: "X" }), { ip: "1.1.1.1", userId: "user-1" });
  await submitInquiry(deps, guest(), { ip: "1.1.1.1", userId: "user-2" });
  await settle();
  assertEquals([db.inquiries[0].employee_no, db.inquiries[0].name, db.inquiries[0].office_name], ["1234567", "山田 太郎", "A区所"]);
  assertEquals(db.inquiries[0].logged_in, true);
  assertEquals(db.inquiries[0].code_hash, null); // ログイン後は確認コードを使わない
  assertEquals(db.inquiries[1].office_name, "未設定"); // 区所を設定する前(C4)
  // 管理者のアカウントからは送れない
  await assertRejects(() => submitInquiry(deps, guest(), { ip: "1.1.1.1", userId: "admin-1" }), AppError, "管理者");
  // これまでのお問い合わせは本人のものだけ
  const mine = await listMine(deps, "user-1");
  assertEquals(mine.map((m) => m.no), ["#0001"]);
});

Deno.test("送り直し(同じ request_key)は2件にせず、通知も1回だけ(C2)", async () => {
  const { deps, db, d, settle } = setup();
  const body = guest();
  const a = await submitInquiry(deps, body, { ip: "1.1.1.1", userId: null });
  const b = await submitInquiry(deps, body, { ip: "1.1.1.1", userId: null });
  await settle();
  assertEquals([a.id, b.id, b.duplicate], [1, 1, true]);
  assertEquals(db.inquiries.length, 1);
  assertEquals(d.posts.length, 1);
});

Deno.test("入力の検査: 種類・内容・受け取り方・メール・社員番号・確認コード", async () => {
  const { deps } = setup();
  const ctx = { ip: "1.1.1.1", userId: null };
  await assertRejects(() => submitInquiry(deps, guest({ request_key: "x" }), ctx), AppError, "読み直して");
  await assertRejects(() => submitInquiry(deps, guest({ kind: "hack" }), ctx), AppError, "種類");
  // "constructor" などの名前は種類として通さない(O。通すと DB の制限で 500)
  for (const kind of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    await assertRejects(() => submitInquiry(deps, guest({ kind }), ctx), AppError, "種類");
  }
  await assertRejects(() => submitInquiry(deps, guest({ body: " " }), ctx), AppError, "内容を入力");
  await assertRejects(() => submitInquiry(deps, guest({ body: "あ".repeat(1001) }), ctx), AppError, "1000文字以内");
  await assertRejects(() => submitInquiry(deps, guest({ reply_via: "fax" }), ctx), AppError, "受け取り方");
  await assertRejects(() => submitInquiry(deps, guest({ reply_via: "mail", email: "taro@gmail" }), ctx), AppError, "形が正しくありません");
  await assertRejects(
    () => submitInquiry(deps, guest({ reply_via: "mail", email: "a@b.com", email2: "a@c.com" }), ctx),
    AppError,
    "2回で一致しません",
  );
  await assertRejects(() => submitInquiry(deps, guest({ employee_no: "123456" }), ctx), AppError, "7桁");
  await assertRejects(() => submitInquiry(deps, guest({ name: "" }), ctx), AppError, "名前を入力");
  await assertRejects(() => submitInquiry(deps, guest({ office: "" }), ctx), AppError, "所属を入力");
  await assertRejects(() => submitInquiry(deps, guest({ code: "" }), ctx), AppError, "読み直して");
});

Deno.test("メールで受け取る: アドレスをそろえて保存。2回目の入力は大文字・全角の違いを許す(C8)", async () => {
  const { deps, db } = setup();
  await submitInquiry(deps, guest({ reply_via: "mail", email: "Taro@Gmail.com", email2: "taro＠gmail.com", code: undefined }), {
    ip: "1.1.1.1",
    userId: null,
  });
  assertEquals(db.inquiries[0].email, "taro@gmail.com");
  assertEquals(db.inquiries[0].code_hash, null);
});

Deno.test("「画面で見る」を選んだときは、隠れたメール欄の値を保存しない(C7)", async () => {
  const { deps, db } = setup();
  await submitInquiry(deps, guest({ email: "broken", email2: "other" }), { ip: "1.1.1.1", userId: null });
  assertEquals(db.inquiries[0].email, null);
});

Deno.test("回数制限: 社員番号ごとに1時間5件。接続元は20件まで(同じ Wi-Fi の人は止めない。C1)", async () => {
  const { deps } = setup();
  for (let i = 0; i < 5; i++) await submitInquiry(deps, guest(), { ip: "9.9.9.9", userId: null });
  await assertRejects(() => submitInquiry(deps, guest(), { ip: "9.9.9.9", userId: null }), AppError, "しばらく受け付けられません");
  // 同じ接続元でも、別の人は送れる
  for (let i = 0; i < 5; i++) {
    await submitInquiry(deps, guest({ employee_no: "1111111" }), { ip: "9.9.9.9", userId: null });
    await submitInquiry(deps, guest({ employee_no: "2222222" }), { ip: "9.9.9.9", userId: null });
  }
  // ここまでで接続元は16件(6件目の失敗も数に入る)。20件までは送れて、21件目で止まる
  for (let i = 0; i < 4; i++) await submitInquiry(deps, guest({ employee_no: `333333${i}` }), { ip: "9.9.9.9", userId: null });
  await assertRejects(() => submitInquiry(deps, guest({ employee_no: "4444444" }), { ip: "9.9.9.9", userId: null }), AppError);
  // 別の接続元は止まらない
  await submitInquiry(deps, guest({ employee_no: "4444444" }), { ip: "8.8.8.8", userId: null });
});

Deno.test("返事を見る: 回数制限(番号ごと10回)で確認コードの総当たりを止める(C11)", async () => {
  const { deps } = setup();
  await submitInquiry(deps, guest(), { ip: "1.1.1.1", userId: null });
  for (let i = 0; i < 10; i++) {
    await assertRejects(() => viewInquiry(deps, { no: "1", code: "AAAA-AAAA" }, `3.3.3.${i}`), AppError, "違います");
  }
  await assertRejects(() => viewInquiry(deps, { no: "1", code: "K7QM-4XPA" }, "3.3.3.99"), AppError, "しばらく");
});

Deno.test("返事を見る: ログイン後の問い合わせ・メールで受け取る問い合わせは、コードがあっても見られない", async () => {
  const { deps } = setup();
  await submitInquiry(deps, guest({ reply_via: "mail", email: "a@b.com" }), { ip: "1.1.1.1", userId: null });
  await assertRejects(() => viewInquiry(deps, { no: "1", code: "K7QM-4XPA" }, "1.1.1.1"), AppError, "違います");
});

// ---------- 画像 ----------

Deno.test("画像つき: Discord と Gmail の両方に送り、結果を返す", async () => {
  const { deps, db, d, r } = setup();
  const res = await submitInquiry(deps, guest({ images: [{ data: JPEG }, { data: JPEG }] }), { ip: "1.1.1.1", userId: null });
  assertEquals(res.images, "ok");
  assertEquals(d.posts[0].files.map((f) => f.name), ["0001-1.jpg", "0001-2.jpg"]);
  assertEquals(r.receipts.length, 1);
  assertEquals(r.receipts[0].images.length, 2);
  assert(r.receipts[0].subject.includes("#0001") && r.receipts[0].subject.includes("画像2枚"));
  assertEquals(db.inquiries[0].receipt_status, "sent");
  assertEquals(db.inquiries[0].receipt_message_id, "rcpt123");
  assertEquals(db.inquiries[0].image_count, 2);
});

Deno.test("画像つきで Discord に送れなければ、画像なしで送り直す(D9)。Gmail に届けば ok", async () => {
  const { deps, db, d } = setup({ discord: { failWithFiles: true } });
  const res = await submitInquiry(deps, guest({ images: [{ data: JPEG }] }), { ip: "1.1.1.1", userId: null });
  assertEquals(res.images, "ok");
  assertEquals(d.posts.length, 2);
  assertEquals(d.posts[1].files.length, 0);
  assert(JSON.stringify(d.posts[1].payload).includes("Discord に送れませんでした"));
  assertEquals(db.inquiries[0].discord_status, "sent");
});

Deno.test("メールの1日の枠が少ないとき(GAS の最近の知らせで30通未満)は、受付メールを送らない。Discord には届く(F・I7)", async () => {
  const low = setup();
  low.db.status.gas = { value: { quota: 12 }, updated_at: new Date().toISOString() };
  const res = await submitInquiry(low.deps, guest({ images: [{ data: JPEG }] }), { ip: "1.1.1.1", userId: null });
  assertEquals(low.r.receipts.length, 0);
  assertEquals(low.db.inquiries[0].receipt_status, "skipped");
  assertEquals(low.d.posts[0].files.length, 1);
  assertEquals(res.images, "ok"); // Discord に届いた
  // 管理者の返事は送れる(枠を残してある)
  await submitInquiry(low.deps, guest({ reply_via: "mail", email: "a@b.com" }), { ip: "1.1.1.2", userId: null });
  await adminReply(low.deps, { id: 2, body: "x", via: "mail", request_key: key() });
  assertEquals(low.r.replies.length, 1);
  // メールを送るたびに返ってくる残りの数も使う(GAS の確認より新しければ、そちらを優先)
  const viaSend = setup({ relay: { result: { ok: true, message_id: "m1", thread_id: "ff0123", quota: 9 } } });
  viaSend.db.status.gas = { value: { quota: 90 }, updated_at: new Date(Date.now() - 5 * 60_000).toISOString() };
  await submitInquiry(viaSend.deps, guest({ reply_via: "mail", email: "a@b.com" }), { ip: "1.1.1.1", userId: null });
  await adminReply(viaSend.deps, { id: 1, body: "x", via: "mail", request_key: key() }); // 残り9通と分かる
  await submitInquiry(viaSend.deps, guest({ images: [{ data: JPEG }] }), { ip: "1.1.1.9", userId: null });
  assertEquals(viaSend.r.receipts.length, 0);
  // 知らせが古い(1時間以上前)・まだ無いときは、送る。30通以上あっても送る
  const old = setup();
  old.db.status.gas = { value: { quota: 5 }, updated_at: new Date(Date.now() - 2 * 3600_000).toISOString() };
  await submitInquiry(old.deps, guest({ images: [{ data: JPEG }] }), { ip: "1.1.1.1", userId: null });
  assertEquals(old.r.receipts.length, 1);
  const plenty = setup();
  plenty.db.status.gas = { value: { quota: 80 }, updated_at: new Date().toISOString() };
  await submitInquiry(plenty.deps, guest({ images: [{ data: JPEG }] }), { ip: "1.1.1.1", userId: null });
  assertEquals(plenty.r.receipts.length, 1);
});

Deno.test("画像がどこにも届かなければ failed を返す(I5)。問い合わせ自体は保存されている", async () => {
  const { deps, db } = setup({
    discord: { failAll: true },
    relay: { result: { ok: false, kind: "unknown", error: "timeout" } },
  });
  const res = await submitInquiry(deps, guest({ images: [{ data: JPEG }] }), { ip: "1.1.1.1", userId: null });
  assertEquals(res.images, "failed");
  assertEquals(db.inquiries.length, 1);
  assertEquals(db.inquiries[0].discord_status, "failed");
  assertEquals(db.inquiries[0].receipt_status, "unknown");
});

Deno.test("Discord・GAS が未設定でも、問い合わせは受け付ける(X6)", async () => {
  const { deps, db, settle } = setup({ discord: { configured: false }, relay: { configured: false } });
  const res = await submitInquiry(deps, guest({ images: [{ data: JPEG }] }), { ip: "1.1.1.1", userId: null });
  await settle();
  assertEquals(res.images, "failed");
  assertEquals(db.inquiries[0].discord_status, "skipped");
  assertEquals(db.inquiries[0].receipt_status, "skipped");
});

// ---------- 管理者 ----------

Deno.test("管理者の返事(画面): 利用者が確認コードで見られる。二度押しでも1件", async () => {
  const { deps, db, r } = setup();
  await submitInquiry(deps, guest(), { ip: "1.1.1.1", userId: null });
  const k = key();
  const a = await adminReply(deps, { id: 1, body: "直接お伝えします", via: "screen", request_key: k });
  const b = await adminReply(deps, { id: 1, body: "直接お伝えします", via: "screen", request_key: k });
  assertEquals(b.duplicate, true);
  assertEquals(a.message!.id, b.message!.id);
  assertEquals(r.replies.length, 0);
  assertEquals(db.inquiries[0].status, "replied");
  const view = await viewInquiry(deps, { no: "1", code: "K7QM4XPA" }, "1.1.1.1");
  assertEquals(view.messages.map((m) => m.from), ["user", "admin"]);
});

Deno.test("管理者の返事(メール): GAS に件名・本文・宛先を渡し、送れた印を残す。二度押しでも1通(M4)", async () => {
  const { deps, db, r } = setup();
  await submitInquiry(deps, guest({ reply_via: "mail", email: "taro@gmail.com" }), { ip: "1.1.1.1", userId: null });
  const k = key();
  const res = await adminReply(deps, { id: 1, body: "再設定しました", via: "mail", request_key: k });
  await adminReply(deps, { id: 1, body: "再設定しました", via: "mail", request_key: k });
  assertEquals(r.replies.length, 1);
  assertEquals(r.replies[0].to, "taro@gmail.com");
  assertEquals(r.replies[0].subject, "【shiftflow 勤務登録】お問い合わせ #0001 への返事");
  assert(r.replies[0].body.includes("再設定しました") && r.replies[0].body.includes("> PINを忘れました"));
  assertEquals(r.replies[0].reply_to_message_id, null); // まだ相手からのメールは無い
  assertEquals(res.message!.mail_status, "sent");
  assertEquals(db.messages.find((m) => m.sender === "admin")!.gmail_thread_id, "ff0123");
});

Deno.test("メールの返事が時間切れ: 送れたか分からない(unknown)。送り直しは同じ key で GAS に渡す(M5)", async () => {
  const { deps, db, r } = setup({ relay: { result: { ok: false, kind: "unknown", error: "timeout" } } });
  await submitInquiry(deps, guest({ reply_via: "mail", email: "taro@gmail.com" }), { ip: "1.1.1.1", userId: null });
  const res = await adminReply(deps, { id: 1, body: "返事", via: "mail", request_key: key() });
  assertEquals(res.message!.mail_status, "unknown");
  const msg = db.messages.find((m) => m.sender === "admin")!;
  // 利用者の画面には、送れなかった返事は出さない(unknown は出す)
  assertEquals(msg.mail_error, "timeout");
  (deps.relay as { reply: unknown }).reply = (req: ReplyRequest) => {
    r.replies.push(req);
    return Promise.resolve({ ok: true, message_id: "m2", thread_id: "t2", duplicate: true });
  };
  const again = await adminResend(deps, { message_id: msg.id });
  assertEquals(again.message!.mail_status, "sent");
  assertEquals(r.replies[0].key, r.replies[1].key);
});

Deno.test("メールの返事: 1回目は元の内容の引用つき、2回目以降は短い文面。届かなかった返事は数えない", async () => {
  const { deps, r } = setup();
  await submitInquiry(deps, guest({ reply_via: "mail", email: "taro@gmail.com" }), { ip: "1.1.1.1", userId: null });
  await adminReply(deps, { id: 1, body: "1回目", via: "mail", request_key: key() });
  await adminReply(deps, { id: 1, body: "2回目", via: "mail", request_key: key() });
  await adminReply(deps, { id: 1, body: "3回目", via: "mail", request_key: key() });
  assert(r.replies[0].body.includes("お問い合わせありがとうございます") && r.replies[0].body.includes("> PINを忘れました"));
  for (const i of [1, 2]) {
    assert(!r.replies[i].body.includes("ありがとうございます") && !r.replies[i].body.includes("> "), r.replies[i].body);
    assert(r.replies[i].body.includes("のつづきです"));
  }
  // 1回目が送れなかった(failed)人には、まだ1回目の文面を送る
  const s2 = setup({ relay: { result: { ok: false, kind: "failed", error: "上限" } } });
  await submitInquiry(s2.deps, guest({ reply_via: "mail", email: "taro@gmail.com" }), { ip: "1.1.1.1", userId: null });
  await adminReply(s2.deps, { id: 1, body: "a", via: "mail", request_key: key() });
  await adminReply(s2.deps, { id: 1, body: "b", via: "mail", request_key: key() });
  assert(s2.r.replies[1].body.includes("お問い合わせありがとうございます"));
  // 画面だけの返事のあとにメールで送るときも、メールとしては1回目
  const s3 = setup();
  await submitInquiry(s3.deps, guest({ reply_via: "mail", email: "taro@gmail.com" }), { ip: "1.1.1.1", userId: null });
  await adminReply(s3.deps, { id: 1, body: "画面", via: "screen", request_key: key() });
  await adminReply(s3.deps, { id: 1, body: "メール", via: "mail", request_key: key() });
  assert(s3.r.replies[0].body.includes("お問い合わせありがとうございます"));
});

Deno.test("画面で返事を受け取る問い合わせに、件名の受付番号で他人がメールを差し込んでも、送り先にならない(D)", async () => {
  const { deps, db, r } = setup();
  await submitInquiry(deps, guest(), { ip: "1.1.1.1", userId: null }); // 画面で見る(アドレスなし)
  await ingestMails(deps, { self: SELF, mails: [mail({ from: "attacker@evil.example", thread_id: "ee0001" })] });
  assertEquals(db.messages.some((m) => m.sender === "mail" && m.inquiry_id === 1), true); // 取り込まれてはいる
  const detail = await adminGet(deps, 1);
  assertEquals(detail.reply_to_email, null);
  await assertRejects(() => adminReply(deps, { id: 1, body: "x", via: "mail", request_key: key() }), AppError, "送り先のメールアドレスがありません");
  assertEquals(r.replies.length, 0);
  // 画面だけの返事はできる
  await adminReply(deps, { id: 1, body: "x", via: "screen", request_key: key() });
});

Deno.test("アドレスを消したあと(30日後)は、こちらが送ったスレッドに返信してきた人にだけ返せる(A4・D)", async () => {
  const { deps, db, r } = setup();
  await submitInquiry(deps, guest({ reply_via: "mail", email: "taro@gmail.com" }), { ip: "1.1.1.1", userId: null });
  await adminReply(deps, { id: 1, body: "返事", via: "mail", request_key: key() }); // スレッド ff0123
  await ingestMails(deps, { self: SELF, mails: [
    mail({ thread_id: "ff0123", from: "taro@gmail.com" }),
    mail({ thread_id: "ee0002", from: "attacker@evil.example", subject: "お問い合わせ #0001" }), // 番号だけで入ってきた他人
  ] });
  db.inquiries[0].email = null; // 30日たって消えた
  assertEquals((await adminGet(deps, 1)).reply_to_email, "taro@gmail.com");
  await adminReply(deps, { id: 1, body: "続き", via: "mail", request_key: key() });
  assertEquals(r.replies.at(-1)!.to, "taro@gmail.com");
});

Deno.test("メールで返事: GAS 未設定・宛先なしはエラーにして、何も保存しない", async () => {
  const { deps, db } = setup({ relay: { configured: false } });
  await submitInquiry(deps, guest(), { ip: "1.1.1.1", userId: null });
  await assertRejects(() => adminReply(deps, { id: 1, body: "x", via: "mail", request_key: key() }), AppError, "設定されていません");
  const s2 = setup();
  await submitInquiry(s2.deps, guest(), { ip: "1.1.1.1", userId: null });
  await assertRejects(() => adminReply(s2.deps, { id: 1, body: "x", via: "mail", request_key: key() }), AppError, "送り先のメールアドレスがありません");
  assertEquals(db.messages.filter((m) => m.sender === "admin").length, 0);
  assertEquals(s2.db.messages.filter((m) => m.sender === "admin").length, 0);
});

Deno.test("状態の変更・一覧・詳細(詳細を開くと新着の印が消える。確認コードのハッシュは出さない)", async () => {
  const { deps, db } = setup();
  await submitInquiry(deps, guest(), { ip: "1.1.1.1", userId: null });
  db.inquiries[0].has_new_mail = true;
  const detail = await adminGet(deps, 1);
  assertEquals(detail.inquiry.code_hash, undefined);
  assertEquals(detail.registered, { name: "登録者", officeName: "A区所" });
  assertEquals(db.inquiries[0].has_new_mail, false);
  await adminSetStatus(deps, { id: 1, status: "done" });
  assertEquals(db.inquiries[0].status, "done");
  assert(db.inquiries[0].done_at);
  const list = await adminList(deps, "all");
  assertEquals(list.inquiries.length, 1);
  assertEquals(list.counts.todo, 0);
  assertEquals((list.inquiries[0] as { code_hash?: string }).code_hash, undefined);
  await assertRejects(() => adminSetStatus(deps, { id: 1, status: "x" }), AppError);
  await assertRejects(() => adminGet(deps, 99), AppError, "見つかりません");
});

// ---------- 受信メール ----------

const mail = (extra: Partial<Record<string, unknown>> = {}) => ({
  id: "18f0aa" + String(++keySeq),
  thread_id: "ff0999",
  from: "山田 <Taro@Gmail.com>",
  subject: "Re: 【shiftflow 勤務登録】お問い合わせ #0001 への返事",
  body: "ありがとうございます\n\n2026年10月6日(月) 9:30 shiftflow 勤務登録 <shiftflow.kinmu@gmail.com>:\n> 前のメール",
  ...extra,
});

Deno.test("受信メール: スレッドで問い合わせに当てはめ、引用を除き、要対応に戻して Discord に知らせる", async () => {
  const { deps, db, d } = setup();
  await submitInquiry(deps, guest({ reply_via: "mail", email: "taro@gmail.com" }), { ip: "1.1.1.1", userId: null });
  await adminReply(deps, { id: 1, body: "返事", via: "mail", request_key: key() });
  await adminSetStatus(deps, { id: 1, status: "done" });
  d.posts.length = 0;
  const m = mail({ thread_id: "ff0123", subject: "件名なし" }); // 送ったメールのスレッド(件名に番号がなくてもよい)
  const res = await ingestMails(deps, { self: SELF, mails: [m] });
  assertEquals(res, { known: [m.id], added: 1 });
  const got = db.messages.find((x) => x.gmail_message_id === m.id)!;
  assertEquals(got.inquiry_id, 1);
  assertEquals(got.body, "ありがとうございます");
  assert(got.body_full!.includes("> 前のメール"));
  assertEquals(got.from_email, "taro@gmail.com");
  assertEquals(db.inquiries[0].status, "open");
  assertEquals(db.inquiries[0].has_new_mail, true);
  assertEquals(db.inquiries[0].done_at, null);
  assertEquals(d.posts.length, 1);
  assert(!JSON.stringify(d.posts[0].payload).includes("違う人")); // スレッドで当てはめたときは注意を出さない

  // 次の返事は、相手のメールに返信する(M7)
  const r2 = await adminReply(deps, { id: 1, body: "了解です", via: "mail", request_key: key() });
  assertEquals(r2.message!.mail_status, "sent");
});

Deno.test("メールの返事: 送り先の人から届いたメールにだけスレッドで返信する(M7・R9)", async () => {
  const { deps, r } = setup();
  await submitInquiry(deps, guest({ reply_via: "mail", email: "taro@gmail.com" }), { ip: "1.1.1.1", userId: null });
  const fromTaro = mail({ thread_id: "aa0001" });
  const fromOther = mail({ thread_id: "aa0002", from: "other@example.com" });
  await ingestMails(deps, { self: SELF, mails: [fromTaro, fromOther] });
  await adminReply(deps, { id: 1, body: "返事", via: "mail", request_key: key() });
  assertEquals(r.replies[0].to, "taro@gmail.com");
  assertEquals(r.replies[0].reply_to_message_id, fromTaro.id); // 後から来た別の人のメールではなく、本人のメール
});

Deno.test("受信メール: 同じメールは二重に入れない。自分のメールは取り込まない(R1・R3・I8)", async () => {
  const { deps, db } = setup();
  await submitInquiry(deps, guest({ reply_via: "mail", email: "taro@gmail.com" }), { ip: "1.1.1.1", userId: null });
  const m = mail();
  const own = mail({ from: "shiftflow 勤務登録 <Shiftflow.Kinmu@gmail.com>" });
  const first = await ingestMails(deps, { self: SELF, mails: [m, own] });
  const second = await ingestMails(deps, { self: SELF, mails: [m] });
  assertEquals(first.known, [m.id, own.id]);
  assertEquals(first.added, 1);
  assertEquals(second, { known: [m.id], added: 0 });
  assertEquals(db.messages.filter((x) => x.sender === "mail").length, 1);
});

Deno.test("受信メール: 件名の番号で当てはめたときは、アドレスが違えば注意を出す(R9)。当てはまらないものは受信メールへ", async () => {
  const { deps, db, d } = setup();
  await submitInquiry(deps, guest({ reply_via: "mail", email: "taro@gmail.com" }), { ip: "1.1.1.1", userId: null });
  d.posts.length = 0;
  await ingestMails(deps, { self: SELF, mails: [mail({ from: "other@example.com" })] });
  assert(JSON.stringify(d.posts[0].payload).includes("違う人"));
  const stray = mail({ thread_id: "ff0aaa", subject: "こんにちは", from: "spam@example.com" });
  await ingestMails(deps, { self: SELF, mails: [stray, mail({ subject: "お問い合わせ #0099", thread_id: "ff0bbb" })] });
  assertEquals(db.messages.filter((x) => x.inquiry_id == null).length, 2); // 存在しない番号も当てはめない
  assertEquals(d.posts.length, 1); // 当てはまらないメールは Discord に出さない(R8)
  const list = await adminList(deps, "unmatched");
  assertEquals(list.unmatched_mails.length, 2);
  assertEquals(list.counts.unmatched, 2);
});

Deno.test("受信メール: 届かなかった知らせは本文の番号で当てはめ、印を付ける(R10)", async () => {
  const { deps, db, d } = setup();
  await submitInquiry(deps, guest({ reply_via: "mail", email: "taro..x@docomo.ne.jp" }), { ip: "1.1.1.1", userId: null });
  await ingestMails(deps, {
    self: SELF,
    mails: [mail({
      from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
      subject: "Delivery Status Notification (Failure)",
      thread_id: "ff0ccc",
      body: "アドレスが見つかりません\n\n----- Original message -----\nSubject: 【shiftflow 勤務登録】お問い合わせ #0001 への返事",
    })],
  });
  const b = db.messages.find((x) => x.bounce)!;
  assertEquals(b.inquiry_id, 1);
  assert(b.body.includes("Original message")); // 届かなかった知らせは全文のまま
  assert(JSON.stringify(d.posts.at(-1)!.payload).includes("届きませんでした"));
});

Deno.test("受信メール: 形の違う ID は飛ばし、1回30件まで", async () => {
  const { deps } = setup();
  const many = Array.from({ length: 40 }, (_, i) => mail({ id: "abcdef" + i, thread_id: "ff0d0" + i, subject: "x" }));
  const res = await ingestMails(deps, { self: SELF, mails: [mail({ id: "../../x" }), ...many] });
  assertEquals(res.known.length, 29); // 先頭の1件(形が違う)を飛ばして、30件のうち残り29件
});

Deno.test("当てはまらないメールへの返事: 元のメールのスレッドに返信する", async () => {
  const { deps, db, r } = setup();
  const stray = mail({ thread_id: "ff0aaa", subject: "質問です", from: "x@example.com" });
  await ingestMails(deps, { self: SELF, mails: [stray] });
  const original = db.messages.find((m) => m.gmail_message_id === stray.id)!;
  const res = await adminReplyUnmatched(deps, { message_id: original.id, body: "回答です", request_key: key() });
  assertEquals(res.message!.mail_status, "sent");
  assertEquals(r.replies[0].reply_to_message_id, stray.id);
  assertEquals(r.replies[0].to, "x@example.com");
  assertEquals(r.replies[0].subject, "Re: 質問です");
});

// ---------- GAS から ----------

Deno.test("GAS の合言葉と時刻を確かめる", async () => {
  const secret = "s".repeat(32);
  await checkHookSecret({ secret, ts: Date.now() }, secret);
  await assertRejects(() => checkHookSecret({ secret: "x", ts: Date.now() }, secret), AppError, "合言葉");
  await assertRejects(() => checkHookSecret({ secret, ts: Date.now() - 20 * 60_000 }, secret), AppError, "時刻");
  await assertRejects(() => checkHookSecret({ secret, ts: Date.now() }, undefined), AppError, "設定されていません");
  await assertRejects(() => checkHookSecret({ secret: "", ts: Date.now() }, "short"), AppError);
});

Deno.test("1日1回の処理: 90日たった Discord の通知を消す。もう無い(404)ものは消えた扱い(D11)", async () => {
  const gone = setup({ discord: { removeStatus: 404 } });
  gone.db.discordPosts.push({ id: "111111", inquiry_id: 1, created_at: Date.now() - 91 * 86400_000 });
  gone.db.discordPosts.push({ id: "222222", inquiry_id: 1, created_at: Date.now() - 10 * 86400_000 });
  const res = await maintenance(gone.deps, { gmail_trashed: 3 });
  assertEquals(res.discord_deleted, 1);
  assertEquals(gone.d.removed, ["111111"]);
  assertEquals(gone.db.discordPosts.map((p) => p.id), ["222222"]);
  assertEquals(gone.db.status.maintenance.value.gmail_trashed, 3);

  const broken = setup({ discord: { removeStatus: 401 } });
  broken.db.discordPosts.push({ id: "333333", inquiry_id: 1, created_at: Date.now() - 91 * 86400_000 });
  const res2 = await maintenance(broken.deps, {});
  assertEquals([res2.discord_deleted, res2.discord_failed], [0, 1]);
  assertEquals(broken.db.discordPosts.length, 1); // 消せなかったものは残す(DB 側で120日後に記録だけ消える)
});
