// お問い合わせの流れの本体(送信・返事を見る・管理者の返事・受信メールの取り込み・古いものの削除)。
// DB(Repo)・Discord・メールの中継(MailRelay)は引数で受け取る(テストでは偽物に差し替える)。
// 設計と予想されるバグの番号は docs/contact/DESIGN.md。

import { isEmployeeNo, safeEqual, toHalfWidth } from "./accounts.ts";
import {
  cleanText,
  encodeBase64,
  extractEmail,
  findInquiryNo,
  formatNo,
  hashCode,
  imageFileName,
  inboundMailPayload,
  type InquiryForNotice,
  isBounce,
  isUuid,
  isValidCode,
  KINDS,
  MAX_BODY,
  MAX_MAIL_BODY,
  MAX_MAIL_FULL,
  MAX_REPLY,
  newInquiryPayload,
  normalizeCode,
  normalizeEmail,
  parseNo,
  receiptMailText,
  receiptSubject,
  replyMailText,
  replySubject,
  requireLine,
  requireText,
  stripQuoted,
  truncate,
  validateImages,
} from "./contact.ts";
import type { Discord } from "./discord.ts";
import { AppError } from "./http.ts";
import type { MailRelay, RelayResult } from "./mail-relay.ts";

export type Inquiry = InquiryForNotice & {
  request_key: string;
  user_id: string | null;
  email: string | null;
  code_hash: string | null;
  status: "open" | "replied" | "done";
  has_new_mail: boolean;
  discord_status: string;
  receipt_status: string;
  receipt_message_id: string | null;
  last_activity_at: string;
  done_at: string | null;
};

export type Message = {
  id: number;
  inquiry_id: number | null;
  request_key: string | null;
  sender: "user" | "admin" | "mail";
  channel: "web" | "mail";
  body: string;
  body_full: string | null;
  from_email: string | null;
  subject: string | null;
  attachment_names: string | null;
  bounce: boolean;
  gmail_message_id: string | null;
  gmail_thread_id: string | null;
  mail_status: "sending" | "sent" | "failed" | "unknown" | null;
  mail_error: string | null;
  created_at: string;
};

export type NewMessage = Partial<Omit<Message, "id" | "created_at">> & Pick<Message, "sender" | "channel" | "body">;

export interface Repo {
  rateHit(key: string, max: number, minutes: number): Promise<boolean>;
  // ログイン中の利用者の社員番号・氏名・区所の名前(区所が未設定なら null)。管理者は role: "admin"
  memberInfo(userId: string): Promise<{ role: string; employeeNo: string | null; name: string; officeName: string | null } | null>;
  createInquiry(row: Record<string, unknown>): Promise<{ id: number; duplicate: boolean }>;
  getInquiry(id: number): Promise<Inquiry | null>;
  updateInquiry(id: number, patch: Partial<Inquiry>): Promise<void>;
  listInquiries(filter: "todo" | "replied" | "all", limit: number): Promise<Inquiry[]>;
  countTodo(): Promise<number>;
  myInquiries(userId: string, limit: number): Promise<Inquiry[]>;
  messages(inquiryId: number): Promise<Message[]>;
  // 同じ request_key / gmail_message_id があれば作らずに null を返す
  insertMessage(row: NewMessage): Promise<Message | null>;
  getMessage(id: number): Promise<Message | null>;
  messageByRequestKey(key: string): Promise<Message | null>;
  messageExists(gmailMessageId: string): Promise<boolean>;
  updateMessage(id: number, patch: Partial<Message>): Promise<void>;
  inquiryIdByThread(threadId: string): Promise<number | null>;
  unmatchedMails(limit: number): Promise<Message[]>;
  countUnmatched(): Promise<number>;
  profileByEmployeeNo(no: string): Promise<{ name: string; officeName: string | null } | null>;
  recordDiscordPost(messageId: string, inquiryId: number | null): Promise<void>;
  oldDiscordPosts(days: number, limit: number): Promise<string[]>;
  deleteDiscordPost(messageId: string): Promise<void>;
  setStatus(key: string, value: Record<string, unknown>): Promise<void>;
  statuses(): Promise<Record<string, { value: Record<string, unknown>; updated_at: string }>>;
  purge(): Promise<Record<string, unknown>>;
}

export type Deps = {
  repo: Repo;
  discord: Discord;
  relay: MailRelay;
  // 応答を返したあとも続けてよい処理(Edge Function では EdgeRuntime.waitUntil)
  background: (p: Promise<unknown>) => void;
};

// 回数制限(設計 C1・C11)。同じ職場の Wi-Fi は同じ接続元になるので、接続元の枠は緩め
export const LIMITS = {
  ip: [20, 60],
  user: [5, 60],
  employee: [5, 60],
  viewIp: [30, 60],
  viewNo: [10, 60],
} as const;

// 1日の送信枠の残りがこれより少ないときは、受付メール(控え)を送らない(管理者の返事のために残す)
export const RECEIPT_MIN_QUOTA = 30;

// メールの1日の送信枠の残り(最近わかったもの。1時間より古いものは使わない)。
// GAS の確認(gas)と、メールを送るたびに返ってくる数(mail_quota)の新しい方
async function latestQuota(repo: Repo): Promise<number | null> {
  const statuses = await repo.statuses();
  let best: { quota: number; at: number } | null = null;
  for (const key of ["gas", "mail_quota"]) {
    const row = statuses[key];
    const quota = Number(row?.value?.quota);
    const at = row ? new Date(row.updated_at).getTime() : 0;
    if (row && row.value?.quota != null && Number.isFinite(quota) && Date.now() - at < 60 * 60_000 && (!best || at > best.at)) best = { quota, at };
  }
  return best ? best.quota : null;
}

// メールを送れたときに GAS が返した、今日の残りの数を覚える(受付メールを送るか決めるため)。失敗しても何もしない
async function rememberQuota(repo: Repo, res: RelayResult): Promise<void> {
  if (res.ok && typeof res.quota === "number") await repo.setStatus("mail_quota", { quota: res.quota }).catch(() => {});
}

const BUSY = "短い時間に何度も送られたため、しばらく受け付けられません。1時間ほどたってから、もう一度お試しください。";

async function limit(repo: Repo, key: string, [max, minutes]: readonly [number, number]) {
  if (!(await repo.rateHit(key, max, minutes))) throw new AppError(429, BUSY, "rate_limited");
}

// ============================================================
// 送信
// ============================================================

export type SubmitResult = { id: number; no: string; duplicate: boolean; images: "none" | "ok" | "failed" };

export async function submitInquiry(
  deps: Deps,
  body: Record<string, unknown>,
  ctx: { ip: string; userId: string | null },
): Promise<SubmitResult> {
  const { repo } = deps;
  if (!isUuid(body.request_key)) throw new AppError(400, "画面を読み直してから、もう一度送ってください。", "bad_input");
  const requestKey = String(body.request_key).toLowerCase();
  const kind = String(body.kind ?? "");
  // Object.hasOwn: "constructor" や "toString" のような名前を、種類として通さない(O。通すと DB の制限で 500 になる)
  if (!Object.hasOwn(KINDS, kind)) throw new AppError(400, "種類を選んでください。", "bad_input");
  const text = requireText(body.body, "内容", MAX_BODY);
  const replyVia = body.reply_via === "mail" ? "mail" : body.reply_via === "screen" ? "screen" : null;
  if (!replyVia) throw new AppError(400, "返事の受け取り方を選んでください。", "bad_input");

  let email: string | null = null;
  if (replyVia === "mail") {
    email = normalizeEmail(body.email);
    if (!email) throw new AppError(400, "メールアドレスの形が正しくありません。", "bad_email");
    if (body.email2 !== undefined && normalizeEmail(body.email2) !== email) {
      throw new AppError(400, "メールアドレスが2回で一致しません。", "bad_email");
    }
  }

  const images = validateImages(body.images);

  // 送る人(ログイン後は DB から取る。画面から来た社員番号・名前・所属は使わない)
  let employeeNo: string;
  let name: string;
  let officeName: string;
  if (ctx.userId) {
    const info = await repo.memberInfo(ctx.userId);
    if (!info) throw new AppError(403, "このアカウントは利用できません。", "not_member");
    if (info.role === "admin" || !info.employeeNo) {
      throw new AppError(403, "管理者のアカウントからは送れません。", "not_member");
    }
    employeeNo = info.employeeNo;
    name = info.name;
    // 区所の名前には長さの上限が無い(昔に付けた長い名前もありうる)ので、所属の上限(60文字)に切り詰める(Q9)
    officeName = truncate(info.officeName ?? "未設定", 60);
  } else {
    employeeNo = toHalfWidth(body.employee_no).replace(/[\s\-ー－]/g, "");
    if (!isEmployeeNo(employeeNo)) throw new AppError(400, "社員番号は7桁の数字で入力してください。", "bad_employee_no");
    name = requireLine(body.name, "名前", 40);
    officeName = truncate(requireLine(body.office, "所属", 200), 60);
  }

  // ログイン前で「画面で見る」は、画面が作った確認コード(画面が覚えているので、送り直しても同じコードになる)
  let codeHash: string | null = null;
  if (!ctx.userId && replyVia === "screen") {
    const code = normalizeCode(body.code);
    if (!isValidCode(code)) throw new AppError(400, "画面を読み直してから、もう一度送ってください。", "bad_input");
    codeHash = await hashCode(code, requestKey);
  }

  await limit(repo, `contact-ip:${ctx.ip}`, LIMITS.ip);
  if (ctx.userId) await limit(repo, `contact-user:${ctx.userId}`, LIMITS.user);
  else await limit(repo, `contact-emp:${employeeNo}`, LIMITS.employee);

  const created = await repo.createInquiry({
    request_key: requestKey,
    user_id: ctx.userId,
    logged_in: !!ctx.userId,
    employee_no: employeeNo,
    name,
    office_name: officeName,
    kind,
    reply_via: replyVia,
    email,
    code_hash: codeHash,
    image_count: images.length,
    body: text,
  });
  const result: SubmitResult = { id: created.id, no: formatNo(created.id), duplicate: created.duplicate, images: "none" };
  // 送り直し(前の送信は届いていた)ときは、通知を二重に出さない(C2・I9)
  if (created.duplicate) return result;

  const inquiry = await repo.getInquiry(created.id);
  if (!inquiry) return result;

  const files = images.map((img, i) => ({ name: imageFileName(created.id, i, img.type), type: img.type, bytes: img.bytes }));
  const discordTask = notifyNewInquiry(deps, inquiry, text, files);
  if (!files.length) {
    deps.background(discordTask);
    return result;
  }
  // 画像があるときは、届いたかどうかを画面で知らせるため待つ(I5)
  const receiptTask = sendReceipt(deps, inquiry, text, files);
  const [discordOk, receiptOk] = await Promise.all([discordTask, receiptTask]);
  result.images = discordOk || receiptOk ? "ok" : "failed";
  return result;
}

type ImageFile = { name: string; type: string; bytes: Uint8Array };

// Discord に新しい問い合わせを知らせる。失敗しても例外にしない(D1)。画像つきで送れなければ画像なしで送り直す(D9)
export async function notifyNewInquiry(deps: Deps, inq: Inquiry, text: string, files: ImageFile[]): Promise<boolean> {
  const { repo, discord } = deps;
  try {
    if (!discord.configured) {
      await repo.updateInquiry(inq.id, { discord_status: "skipped" });
      return false;
    }
    let res = await discord.post(newInquiryPayload(inq, text), files);
    if (!res.ok && files.length) {
      res = await discord.post(newInquiryPayload(inq, text, `${files.length}枚(Discord に送れませんでした。Gmailで見てください)`));
      if (res.ok) {
        await repo.recordDiscordPost(res.id, inq.id);
        await repo.updateInquiry(inq.id, { discord_status: "sent" });
        return false; // 画像は Discord に届いていない
      }
    }
    if (res.ok) {
      await repo.recordDiscordPost(res.id, inq.id);
      await repo.updateInquiry(inq.id, { discord_status: "sent" });
      return true;
    }
    console.error("discord notify failed", res.status);
    await repo.updateInquiry(inq.id, { discord_status: "failed" });
    return false;
  } catch (err) {
    console.error("discord notify error", err instanceof Error ? err.message : err);
    await repo.updateInquiry(inq.id, { discord_status: "failed" }).catch(() => {});
    return false;
  }
}

// 画像つきの問い合わせを、専用 Gmail に受付メールとして送る(控え)
export async function sendReceipt(deps: Deps, inq: Inquiry, text: string, files: ImageFile[]): Promise<boolean> {
  const { repo, relay } = deps;
  try {
    if (!relay.configured) {
      await repo.updateInquiry(inq.id, { receipt_status: "skipped" });
      return false;
    }
    // メールの1日の送信枠(無料の Gmail は100通)が少ないときは、受付メール(控え)を送らない。
    // 管理者の返事に使う枠を残すため(画像は Discord には届く。I7)。GAS が最近知らせてきた残りの数で見る
    const known = await latestQuota(repo);
    if (known !== null && known < RECEIPT_MIN_QUOTA) {
      const quota = known;
      console.error("receipt skipped: low mail quota", quota);
      await repo.updateInquiry(inq.id, { receipt_status: "skipped" });
      return false;
    }
    const res = await relay.receipt({
      key: `receipt-${inq.request_key}`,
      subject: receiptSubject(inq),
      body: receiptMailText(inq, text),
      images: files.map((f) => ({ name: f.name, type: f.type, data: encodeBase64(f.bytes) })),
    });
    await rememberQuota(repo, res);
    if (res.ok) {
      await repo.updateInquiry(inq.id, { receipt_status: "sent", receipt_message_id: res.message_id || null });
      return true;
    }
    console.error("receipt failed", res.kind, res.error);
    await repo.updateInquiry(inq.id, { receipt_status: res.kind === "unknown" ? "unknown" : "failed" });
    return false;
  } catch (err) {
    console.error("receipt error", err instanceof Error ? err.message : err);
    await repo.updateInquiry(inq.id, { receipt_status: "failed" }).catch(() => {});
    return false;
  }
}

// ============================================================
// 利用者が見る
// ============================================================

export type PublicMessage = { from: "user" | "admin"; body: string; at: string };
export type PublicInquiry = {
  no: string;
  kind: string;
  status: string;
  reply_via: string;
  created_at: string;
  messages: PublicMessage[];
};

function publicView(inq: Inquiry, messages: Message[]): PublicInquiry {
  return {
    no: formatNo(inq.id),
    kind: KINDS[inq.kind] ?? inq.kind,
    status: inq.status,
    reply_via: inq.reply_via,
    created_at: inq.created_at,
    // 利用者に見せるのは、本人の内容と管理者の返事だけ(受信メールは、本人以外が書けるので出さない)
    messages: messages
      .filter((m) => m.sender === "user" || (m.sender === "admin" && m.mail_status !== "failed"))
      .map((m) => ({ from: m.sender as "user" | "admin", body: m.body, at: m.created_at })),
  };
}

const NOT_FOUND = "受付番号か確認コードが違います。";

// ログイン前で「画面で見る」を選んだ人が、受付番号と確認コードで返事を見る
export async function viewInquiry(deps: Deps, body: Record<string, unknown>, ip: string): Promise<PublicInquiry> {
  const { repo } = deps;
  const id = parseNo(body.no);
  const code = normalizeCode(body.code);
  if (!id || !isValidCode(code)) throw new AppError(404, NOT_FOUND, "not_found");
  await limit(repo, `contact-view-ip:${ip}`, LIMITS.viewIp);
  await limit(repo, `contact-view-no:${id}`, LIMITS.viewNo);
  const inq = await repo.getInquiry(id);
  if (!inq || inq.logged_in || inq.reply_via !== "screen" || !inq.code_hash) throw new AppError(404, NOT_FOUND, "not_found");
  if (!(await safeEqual(await hashCode(code, inq.request_key), inq.code_hash))) throw new AppError(404, NOT_FOUND, "not_found");
  return publicView(inq, await repo.messages(id));
}

// ログイン後の「これまでのお問い合わせ」
export async function listMine(deps: Deps, userId: string): Promise<PublicInquiry[]> {
  const list = await deps.repo.myInquiries(userId, 20);
  const out: PublicInquiry[] = [];
  for (const inq of list) out.push(publicView(inq, await deps.repo.messages(inq.id)));
  return out;
}

// ============================================================
// 管理者
// ============================================================

export async function adminList(deps: Deps, filter: unknown) {
  const { repo } = deps;
  const f = filter === "replied" || filter === "all" || filter === "unmatched" ? filter : "todo";
  const [todo, unmatched, statuses] = await Promise.all([repo.countTodo(), repo.countUnmatched(), repo.statuses()]);
  const config = { discord: deps.discord.configured, relay: deps.relay.configured };
  if (f === "unmatched") {
    return { filter: f, inquiries: [], unmatched_mails: await repo.unmatchedMails(50), counts: { todo, unmatched }, statuses, config };
  }
  const inquiries = (await repo.listInquiries(f, 50)).map((i) => ({ ...i, code_hash: undefined, request_key: undefined }));
  return { filter: f, inquiries, unmatched_mails: [], counts: { todo, unmatched }, statuses, config };
}

export async function adminGet(deps: Deps, id: unknown) {
  const { repo } = deps;
  const n = Number(id);
  const inq = Number.isInteger(n) && n > 0 ? await repo.getInquiry(n) : null;
  if (!inq) throw new AppError(404, "お問い合わせが見つかりません(90日たって消えた可能性があります)。", "not_found");
  if (inq.has_new_mail) await repo.updateInquiry(inq.id, { has_new_mail: false });
  const [messages, registered] = await Promise.all([repo.messages(inq.id), repo.profileByEmployeeNo(inq.employee_no)]);
  return {
    inquiry: { ...inq, code_hash: undefined, request_key: undefined, has_new_mail: false },
    messages,
    registered,
    reply_to_email: replyTarget(inq, messages),
  };
}

// 返事のメールの送り先: 問い合わせで本人が入れたアドレスだけ。
// アドレスを消したあと(対応済みで30日。A4)は、こちらが送ったメールのスレッドに、返信してきた人のアドレス。
// 件名の受付番号だけで入ってきたメール(だれでも書ける。D・R9)の差出人は、送り先にしない
function replyTarget(inq: Inquiry, messages: Message[]): string | null {
  if (inq.email) return inq.email;
  const ourThreads = new Set(
    messages.filter((m) => m.sender === "admin" && m.channel === "mail" && m.gmail_thread_id).map((m) => m.gmail_thread_id),
  );
  const last = [...messages].reverse().find((m) =>
    m.sender === "mail" && !m.bounce && m.from_email && m.gmail_thread_id && ourThreads.has(m.gmail_thread_id)
  );
  return last?.from_email ?? null;
}

// 返事を書くスレッド: 送り先の人から届いた最後のメール(GmailThread.reply は最後のメールの差出人に返すので使わない。M7)。
// 別の人から届いたメール(件名の番号で入ってきたもの)には返信しない(R9)
function replyToMessage(messages: Message[], to: string): Message | null {
  return [...messages].reverse().find((m) => m.sender === "mail" && !m.bounce && m.gmail_message_id && m.from_email === to) ?? null;
}

export async function adminReply(deps: Deps, body: Record<string, unknown>) {
  const { repo, relay } = deps;
  if (!isUuid(body.request_key)) throw new AppError(400, "画面を読み直してください。", "bad_input");
  const text = requireText(body.body, "返事", MAX_REPLY);
  const viaMail = body.via === "mail";
  const n = Number(body.id);
  const inq = Number.isInteger(n) && n > 0 ? await repo.getInquiry(n) : null;
  if (!inq) throw new AppError(404, "お問い合わせが見つかりません。", "not_found");
  const messages = await repo.messages(inq.id);
  const to = replyTarget(inq, messages);
  if (viaMail) {
    if (!relay.configured) throw new AppError(503, "メールの中継(GAS)が設定されていません。「画面だけ」を選ぶか、設定してください。", "relay_not_set");
    if (!to) throw new AppError(400, "送り先のメールアドレスがありません。「画面だけ」を選んでください。", "no_email");
  }

  // 同じ request_key の2回目(二度押し)は、作らずに前の返事を返す(M4)
  const key = String(body.request_key).toLowerCase();
  const msg = await repo.insertMessage({
    inquiry_id: inq.id,
    request_key: key,
    sender: "admin",
    channel: viaMail ? "mail" : "web",
    body: text,
    mail_status: viaMail ? "sending" : null,
    from_email: null,
  });
  if (!msg) {
    const existing = await repo.messageByRequestKey(key);
    return { message: existing, duplicate: true };
  }
  await repo.updateInquiry(inq.id, {
    status: "replied",
    has_new_mail: false,
    last_activity_at: new Date().toISOString(),
    done_at: null,
  });
  if (!viaMail) return { message: msg, duplicate: false };
  const sent = await sendReplyMail(deps, inq, msg, messages, to!);
  // メールが送れなかった・送れたか分からないときは、「要対応」に残す(Q4。返信済みにすると一覧から消えて、送り直しを忘れるため)
  if (sent.mail_status !== "sent") await repo.updateInquiry(inq.id, { status: "open" });
  return { message: sent, duplicate: false };
}

async function sendReplyMail(deps: Deps, inq: Inquiry, msg: Message, messages: Message[], to: string): Promise<Message> {
  const first = messages.find((m) => m.sender === "user")?.body ?? "";
  // すでにメールで返事を送ってある(届かなかったものは数えない)なら、2回目以降の短い文面にする
  const followUp = messages.some((m) => m.sender === "admin" && m.channel === "mail" && m.mail_status !== "failed");
  const target = replyToMessage(messages, to);
  const res: RelayResult = await deps.relay.reply({
    key: `reply-${msg.request_key ?? msg.id}`,
    to,
    subject: replySubject(inq.id),
    body: replyMailText(inq, msg.body, first, followUp),
    reply_to_message_id: target?.gmail_message_id ?? null,
  });
  return await saveMailResult(deps.repo, msg, res, to);
}

async function saveMailResult(repo: Repo, msg: Message, res: RelayResult, to: string): Promise<Message> {
  await rememberQuota(repo, res);
  const patch: Partial<Message> = res.ok
    ? { mail_status: "sent", mail_error: null, gmail_message_id: res.message_id || null, gmail_thread_id: res.thread_id || null, from_email: to }
    : { mail_status: res.kind === "unknown" ? "unknown" : "failed", mail_error: truncate(res.error, 500), from_email: to };
  await repo.updateMessage(msg.id, patch);
  return { ...msg, ...patch };
}

// 送れなかった・送れたか分からないメールを、もう一度送る(同じ key なので、実は送れていたら GAS は2通目を送らない。M5)
export async function adminResend(deps: Deps, body: Record<string, unknown>) {
  const { repo, relay } = deps;
  if (!relay.configured) throw new AppError(503, "メールの中継(GAS)が設定されていません。", "relay_not_set");
  const msg = await repo.getMessage(Number(body.message_id));
  if (!msg || msg.sender !== "admin" || msg.channel !== "mail") throw new AppError(404, "返事が見つかりません。", "not_found");
  if (msg.mail_status === "sent") return { message: msg };
  if (msg.inquiry_id == null) {
    // どの問い合わせにも当てはまらないメールへの返事は、元のメールとのつながりを持っていないので送り直さない
    throw new AppError(400, "このメールは送り直せません。新しく返事を書いてください。", "bad_input");
  }
  const inq = await repo.getInquiry(msg.inquiry_id);
  if (!inq) throw new AppError(404, "お問い合わせが見つかりません。", "not_found");
  const messages = (await repo.messages(inq.id)).filter((m) => m.id < msg.id);
  const to = msg.from_email ?? replyTarget(inq, messages);
  if (!to) throw new AppError(400, "送り先のメールアドレスがありません。", "no_email");
  await repo.updateMessage(msg.id, { mail_status: "sending" });
  const sent = await sendReplyMail(deps, inq, msg, messages, to);
  // 送り直して届いたら、要対応のまま残していたもの(Q4)を返信済みにする(対応済みにしてあれば、そのまま)
  if (sent.mail_status === "sent" && inq.status === "open") await repo.updateInquiry(inq.id, { status: "replied" });
  return { message: sent };
}

export async function adminSetStatus(deps: Deps, body: Record<string, unknown>) {
  const status = body.status === "done" ? "done" : body.status === "open" ? "open" : null;
  if (!status) throw new AppError(400, "状態の指定が正しくありません。", "bad_input");
  const n = Number(body.id);
  const inq = Number.isInteger(n) && n > 0 ? await deps.repo.getInquiry(n) : null;
  if (!inq) throw new AppError(404, "お問い合わせが見つかりません。", "not_found");
  await deps.repo.updateInquiry(inq.id, {
    status,
    has_new_mail: false,
    done_at: status === "done" ? new Date().toISOString() : null,
  });
  return { ok: true };
}

// どの問い合わせにも当てはまらない受信メールに返事をする
export async function adminReplyUnmatched(deps: Deps, body: Record<string, unknown>) {
  const { repo, relay } = deps;
  if (!relay.configured) throw new AppError(503, "メールの中継(GAS)が設定されていません。", "relay_not_set");
  if (!isUuid(body.request_key)) throw new AppError(400, "画面を読み直してください。", "bad_input");
  const text = requireText(body.body, "返事", MAX_REPLY);
  const original = await repo.getMessage(Number(body.message_id));
  if (!original || original.inquiry_id !== null || original.sender !== "mail" || !original.gmail_message_id || !original.from_email) {
    throw new AppError(404, "メールが見つかりません。", "not_found");
  }
  const key = String(body.request_key).toLowerCase();
  const msg = await repo.insertMessage({
    inquiry_id: null,
    request_key: key,
    sender: "admin",
    channel: "mail",
    body: text,
    subject: original.subject,
    mail_status: "sending",
  });
  if (!msg) return { message: await repo.messageByRequestKey(key), duplicate: true };
  const res = await relay.reply({
    key: `reply-${key}`,
    to: original.from_email,
    subject: original.subject ? (/^re:/i.test(original.subject) ? original.subject : "Re: " + original.subject) : "shiftflow 勤務登録",
    body: text,
    reply_to_message_id: original.gmail_message_id,
  });
  return { message: await saveMailResult(repo, msg, res, original.from_email), duplicate: false };
}

// ============================================================
// GAS から(受信メールの取り込み・生きている知らせ・古いものの削除)
// ============================================================

export type IncomingMail = {
  id: string;
  thread_id: string;
  from: string;
  subject: string;
  date?: string;
  body: string;
  attachments?: string[];
};

export async function checkHookSecret(body: Record<string, unknown>, secret: string | undefined): Promise<void> {
  if (!secret || secret.length < 16) throw new AppError(503, "MAIL_RELAY_SECRET が設定されていません。", "relay_not_set");
  if (!(await safeEqual(String(body.secret ?? ""), secret))) throw new AppError(401, "合言葉が違います。", "bad_secret");
  const ts = Number(body.ts);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 15 * 60_000) throw new AppError(401, "時刻が合いません。", "bad_secret");
}

// 受け取ったメールを取り込む。返す known は「DB にある(今回入れた・前から入っていた・取り込まないと決めた)」メールのID。
// GAS は known に入ったものを覚えて、次から送らない(入らなかったものは次の回にもう一度送ってくる。R2)
export async function ingestMails(deps: Deps, body: Record<string, unknown>): Promise<{ known: string[]; added: number }> {
  const { repo } = deps;
  const self = normalizeEmail(body.self);
  const mails = Array.isArray(body.mails) ? (body.mails as IncomingMail[]).slice(0, 30) : [];
  const known: string[] = [];
  let added = 0;
  for (const m of mails) {
    const id = String(m?.id ?? "");
    const threadId = String(m?.thread_id ?? "");
    if (!/^[0-9a-f]{6,40}$/i.test(id) || !/^[0-9a-f]{6,40}$/i.test(threadId)) continue;
    try {
      if (await repo.messageExists(id)) {
        known.push(id);
        continue;
      }
      const fromEmail = extractEmail(m.from);
      // 自分(専用 Gmail)が送ったメール(受付メール・返事)は取り込まない(R3・I8)
      if (self && fromEmail === self) {
        known.push(id);
        continue;
      }
      const subject = truncate(cleanText(m.subject).replace(/\s+/g, " "), 300);
      const full = truncate(cleanText(m.body), MAX_MAIL_FULL);
      const bounce = isBounce(fromEmail, subject);
      const stripped = bounce ? full : stripQuoted(full);
      let inquiryId = await repo.inquiryIdByThread(threadId);
      let byThread = inquiryId != null;
      if (inquiryId == null) {
        const no = findInquiryNo(subject) ?? (bounce ? findInquiryNo(full) : null);
        if (no && (await repo.getInquiry(no))) inquiryId = no;
        byThread = false;
      }
      const attachments = (Array.isArray(m.attachments) ? m.attachments : []).map((a) => String(a)).join(", ");
      const msg = await repo.insertMessage({
        inquiry_id: inquiryId,
        sender: "mail",
        channel: "mail",
        body: truncate(stripped || "(本文なし)", MAX_MAIL_BODY),
        body_full: full !== stripped ? full : null,
        from_email: fromEmail,
        subject,
        attachment_names: attachments ? truncate(attachments, 1000) : null,
        bounce,
        gmail_message_id: id,
        gmail_thread_id: threadId,
      });
      known.push(id);
      if (!msg) continue; // 同時に別の取り込みが入れた
      added++;
      if (inquiryId == null) continue;
      const inq = await repo.getInquiry(inquiryId);
      await repo.updateInquiry(inquiryId, {
        has_new_mail: true,
        status: "open",
        done_at: null,
        last_activity_at: new Date().toISOString(),
      });
      if (deps.discord.configured) {
        // スレッドではなく件名の番号で当てはめたときは、だれでも差し込めるので、アドレスが違えば知らせる(R9)
        const mismatch = !byThread && !bounce && (!inq?.email || fromEmail !== inq.email);
        const res = await deps.discord.post(inboundMailPayload(inquiryId, {
          from_email: fromEmail,
          subject,
          body: msg.body,
          bounce,
          mismatch,
          attachments,
        }));
        if (res.ok) await repo.recordDiscordPost(res.id, inquiryId);
      }
    } catch (err) {
      console.error("ingest mail failed", err instanceof Error ? err.message : err);
    }
  }
  return { known, added };
}

export async function recordHeartbeat(deps: Deps, body: Record<string, unknown>) {
  const s = (typeof body.status === "object" && body.status) ? body.status as Record<string, unknown> : {};
  await deps.repo.setStatus("gas", {
    version: truncate(String(s.version ?? ""), 40),
    quota: Number.isFinite(Number(s.quota)) ? Number(s.quota) : null,
    address: normalizeEmail(body.self),
  });
}

// 1日1回: DB の古いものを消し、90日たった Discord の通知を消す
export async function maintenance(deps: Deps, body: Record<string, unknown>) {
  const { repo, discord } = deps;
  const purged = await repo.purge();
  let deleted = 0;
  let failed = 0;
  if (discord.configured) {
    // 1回25件まで(GAS からの呼び出しが長くならないように。残りは次の日)
    for (const id of await repo.oldDiscordPosts(90, 25)) {
      const res = await discord.remove(id);
      // 404 は、手で先に消した(または Webhook を作り直した)。消えている扱いにする(D11)
      if (res.ok || res.status === 404) {
        await repo.deleteDiscordPost(id);
        deleted++;
      } else {
        failed++;
      }
    }
  }
  const gmailTrashed = Number(body.gmail_trashed);
  const summary = {
    purged,
    discord_deleted: deleted,
    discord_failed: failed,
    gmail_trashed: Number.isFinite(gmailTrashed) ? gmailTrashed : null,
  };
  await repo.setStatus("maintenance", summary);
  return summary;
}
