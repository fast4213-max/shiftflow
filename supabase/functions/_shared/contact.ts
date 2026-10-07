// お問い合わせの、計算だけの部品(DB・通信を使わない。テストしやすいように分けてある)。
// 入力の検査、確認コード、Discord の通知の組み立て、メールの文面、受信メールの引用の取り除き など。

import { AppError } from "./http.ts";

export const KINDS: Record<string, string> = {
  login: "ログインできない",
  howto: "使い方・質問",
  bug: "不具合",
  other: "その他",
};

export const MAX_BODY = 1000; // 利用者の内容
export const MAX_REPLY = 3000; // 管理者の返事
export const MAX_MAIL_BODY = 5000; // 受信メールの表示用(引用を除いたもの)
export const MAX_MAIL_FULL = 20000; // 受信メールの全文
export const MAX_IMAGES = 3;
export const MAX_IMAGE_BYTES = 1_500_000; // 1枚(画面で約500KBに縮小してから送る)
export const MAX_IMAGES_TOTAL = 3_500_000;

// 文字数(絵文字なども1文字。DB の char_length と同じ数え方)
export function charLength(s: string): number {
  return [...s].length;
}

export function truncate(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max ? s : chars.slice(0, Math.max(0, max - 1)).join("") + "…";
}

// 改行をそろえ、制御文字を除き、前後の空白を取る
export function cleanText(v: unknown): string {
  return String(v ?? "")
    // 対になっていない UTF-16 の半分(絵文字の途中で切れたものなど)は、DB に保存できないので除く(S13)
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
    .replace(/\r\n?/g, "\n")
    // deno-lint-ignore no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
}

export function requireText(v: unknown, label: string, max: number): string {
  const s = cleanText(v);
  if (!s) throw new AppError(400, `${label}を入力してください。`, "bad_input");
  if (charLength(s) > max) throw new AppError(400, `${label}は${max}文字以内にしてください。`, "bad_input");
  return s;
}

// 1行の項目(名前・所属): 改行や連続した空白は1つの空白にする
export function requireLine(v: unknown, label: string, max: number): string {
  return requireText(cleanText(v).replace(/\s+/g, " "), label, max);
}

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

// ---------- メールアドレス ----------

// 全角(＠や全角英数)を半角に、空白を除き、小文字にする。形が正しくなければ null
export function normalizeEmail(v: unknown): string | null {
  const s = String(v ?? "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  if (!s || s.length > 254) return null;
  if (!/^[^@]+@[^@.][^@]*\.[^@.]+$/.test(s)) return null;
  if (/[<>()[\]\\,;:"]/.test(s)) return null;
  return s;
}

// 古い携帯会社のアドレスにある「..」や「@の直前の.」(規格外。Gmail から送れないことがある)
export function riskyEmail(email: string): boolean {
  const local = email.split("@")[0] ?? "";
  return local.includes("..") || local.startsWith(".") || local.endsWith(".");
}

// "山田 <a@b.c>" や "a@b.c" からアドレスだけを取り出す。
// 表示名の中に別のアドレス("本人 <victim@x>" <attacker@y>)を入れられるので、本物のアドレスはいちばん後ろの <…>(C)
export function extractEmail(v: unknown): string | null {
  const s = String(v ?? "");
  const all = [...s.matchAll(/<([^<>]+)>/g)];
  return normalizeEmail(all.length ? all[all.length - 1][1] : s);
}

// ---------- 受付番号・確認コード ----------

export function formatNo(id: number): string {
  return "#" + String(id).padStart(4, "0");
}

// "#0012" "12" "＃００１２" などを数字にする。読めなければ null
export function parseNo(v: unknown): number | null {
  const s = String(v ?? "").normalize("NFKC").replace(/[#\s]/g, "");
  if (!/^\d{1,9}$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
}

// 紛らわしい文字(0 O 1 I)を除いた32文字
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

// 入力された確認コードをそろえる(全角・小文字・ハイフン・空白を許す)
export function normalizeCode(v: unknown): string {
  return String(v ?? "").normalize("NFKC").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function isValidCode(code: string): boolean {
  return code.length === 8 && [...code].every((c) => CODE_ALPHABET.includes(c));
}

export function formatCode(code: string): string {
  return code.slice(0, 4) + "-" + code.slice(4);
}

export async function hashCode(code: string, requestKey: string): Promise<string> {
  const data = new TextEncoder().encode(`shiftflow-inquiry:${requestKey.toLowerCase()}:${code}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- 画像 ----------

export type ImageInput = { bytes: Uint8Array; type: "image/jpeg" | "image/png" };

function decodeBase64(s: string): Uint8Array | null {
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function encodeBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

// 画面から来た画像([{data: base64}])を確かめる。JPEG / PNG の印が無いもの、大きすぎるものは受け付けない
export function validateImages(v: unknown): ImageInput[] {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new AppError(400, "画像の形が正しくありません。", "bad_image");
  if (v.length > MAX_IMAGES) throw new AppError(400, `画像は${MAX_IMAGES}枚までです。`, "bad_image");
  let total = 0;
  return v.map((item, i) => {
    const data = typeof item === "object" && item ? String((item as Record<string, unknown>).data ?? "") : "";
    const bytes = decodeBase64(data.replace(/^data:[^,]*,/, ""));
    if (!bytes || bytes.length < 8) throw new AppError(400, `${i + 1}枚目の画像を読めませんでした。`, "bad_image");
    if (bytes.length > MAX_IMAGE_BYTES) throw new AppError(400, `${i + 1}枚目の画像が大きすぎます。`, "bad_image");
    total += bytes.length;
    if (total > MAX_IMAGES_TOTAL) throw new AppError(400, "画像が大きすぎます。枚数を減らしてください。", "bad_image");
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, j) => bytes[j] === b);
    if (!jpeg && !png) throw new AppError(400, `${i + 1}枚目は画像(JPEG・PNG)ではありません。`, "bad_image");
    return { bytes, type: jpeg ? "image/jpeg" : "image/png" };
  });
}

export function imageFileName(id: number, index: number, type: string): string {
  return `${String(id).padStart(4, "0")}-${index + 1}.${type === "image/png" ? "png" : "jpg"}`;
}

// ---------- 日時 ----------

// 日本時間の "10/06 08:12"
export function formatJst(value: string | Date): string {
  const d = new Date(new Date(value).getTime() + 9 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// ---------- Discord ----------

export type InquiryForNotice = {
  id: number;
  logged_in: boolean;
  employee_no: string;
  name: string;
  office_name: string;
  kind: string;
  reply_via: string;
  image_count: number;
  created_at: string;
};

// Discord の書式として読まれる記号を無効にする
export function escapeMarkdown(s: string): string {
  return s.replace(/[\\`*_~|>#[\]()<:-]/g, "\\$&");
}

// コードブロックで囲む(中の ``` は崩れないよう置き換える)。囲いを含めて max 文字以内
export function codeBlock(s: string, max: number): string {
  const inner = truncate(s.replace(/```/g, "ˋˋˋ") || " ", Math.max(1, max - 8));
  return "```\n" + inner + "\n```";
}

function field(name: string, value: string, inline = true) {
  return { name: truncate(name, 256), value: truncate(escapeMarkdown(value) || "—", 1024), inline };
}

export type DiscordPayload = {
  embeds: Record<string, unknown>[];
  allowed_mentions: { parse: string[] };
};

// 新しいお問い合わせの通知
export function newInquiryPayload(inq: InquiryForNotice, body: string, imageNote = ""): DiscordPayload {
  const fields = [
    field("種類", KINDS[inq.kind] ?? inq.kind),
    field("ログイン", inq.logged_in ? "ログイン後" : "ログイン前(本人か未確認)"),
    field("返事", inq.reply_via === "mail" ? "メール" : "画面"),
    field("社員番号", inq.employee_no),
    field("名前", inq.name),
    field("所属", inq.office_name),
  ];
  if (inq.image_count > 0 || imageNote) {
    fields.push(field("画像", imageNote || `${inq.image_count}枚(このメッセージとGmailで見られます)`, false));
  }
  return {
    embeds: [{
      title: truncate(`📩 新しいお問い合わせ ${formatNo(inq.id)}`, 256),
      color: inq.logged_in ? 0x1a73e8 : 0xe53935,
      description: codeBlock(body, 1800),
      fields,
      footer: { text: "管理画面の「お問い合わせ」で返事をしてください" },
      timestamp: new Date(inq.created_at).toISOString(),
    }],
    allowed_mentions: { parse: [] },
  };
}

// メールで返信が来た / 届かなかった の通知
export function inboundMailPayload(
  no: number,
  m: { from_email: string | null; subject: string | null; body: string; bounce: boolean; mismatch: boolean; attachments: string },
): DiscordPayload {
  const fields = [field("差出人", m.from_email ?? "不明"), field("件名", m.subject ?? "")];
  if (m.mismatch) fields.push(field("注意", "問い合わせのメールアドレスと違う人からのメールです", false));
  if (m.attachments) fields.push(field("添付", m.attachments + "(Gmailで見てください)", false));
  return {
    embeds: [{
      title: m.bounce ? `⚠️ メールが届きませんでした ${formatNo(no)}` : `📨 メールで返信が来ました ${formatNo(no)}`,
      color: m.bounce ? 0xf9ab00 : 0xe37400,
      description: codeBlock(m.body, 1800),
      fields,
      footer: { text: "管理画面の「お問い合わせ」で見られます" },
      timestamp: new Date().toISOString(),
    }],
    allowed_mentions: { parse: [] },
  };
}

// Embed の文字数の合計(Discord の上限は 6000)
export function embedLength(payload: DiscordPayload): number {
  let n = 0;
  for (const e of payload.embeds) {
    n += charLength(String(e.title ?? "")) + charLength(String(e.description ?? ""));
    const footer = e.footer as { text?: string } | undefined;
    n += charLength(footer?.text ?? "");
    for (const f of (e.fields as { name: string; value: string }[] | undefined) ?? []) n += charLength(f.name) + charLength(f.value);
  }
  return n;
}

// ---------- メールの文面 ----------

export function replySubject(id: number): string {
  return `【shiftflow 勤務登録】お問い合わせ ${formatNo(id)} への返事`;
}

// 返事のメールの文面。1回目は、あいさつと元の内容の引用を付ける。
// 2回目以降(followUp: 同じ問い合わせで、すでにメールで返事を送ってある)は、名前と返事と番号だけの短い文面にする
export function replyMailText(
  inq: { id: number; name: string; kind: string; created_at: string },
  reply: string,
  firstMessage: string,
  followUp = false,
): string {
  if (followUp) {
    return [
      `${inq.name} 様`,
      "",
      reply,
      "",
      "――――――",
      `お問い合わせ ${formatNo(inq.id)} のつづきです。`,
      "このメールに返信していただいても届きます。",
    ].join("\n");
  }
  const quoted = truncate(firstMessage, 500).split("\n").map((l) => "> " + l).join("\n");
  return [
    `${inq.name} 様`,
    "",
    "shiftflow(勤務登録アプリ)の管理者です。",
    "お問い合わせありがとうございます。",
    "",
    reply,
    "",
    "――――――",
    `お問い合わせ ${formatNo(inq.id)}(${formatJst(inq.created_at)})`,
    `種類: ${KINDS[inq.kind] ?? inq.kind}`,
    quoted,
    "――――――",
    "このメールに返信していただいても届きます。",
    "心当たりがないときは、このメールは消してください。",
  ].join("\n");
}

export function receiptSubject(inq: { id: number; kind: string; image_count: number }): string {
  return `【shiftflow 受付】${formatNo(inq.id)} ${KINDS[inq.kind] ?? inq.kind}(画像${inq.image_count}枚)`;
}

export function receiptMailText(
  inq: InquiryForNotice & { email?: string | null },
  body: string,
): string {
  return [
    `受付番号: ${formatNo(inq.id)}(${formatJst(inq.created_at)})`,
    `社員番号: ${inq.employee_no}  名前: ${inq.name}  所属: ${inq.office_name}`,
    `${inq.logged_in ? "ログイン後" : "ログイン前(本人か未確認)"} / 返事: ${inq.reply_via === "mail" ? `メール(${inq.email ?? ""})` : "画面"}`,
    `種類: ${KINDS[inq.kind] ?? inq.kind}`,
    "",
    body,
    "",
    "(shiftflow のお問い合わせに付いていた画像です。90日たつと自動で消えます)",
  ].join("\n");
}

// ---------- 受信メール ----------

// 件名(届かなかった知らせは本文も)から「お問い合わせ #0012」の番号を探す
export function findInquiryNo(text: string): number | null {
  const m = String(text ?? "").normalize("NFKC").match(/お問い合わせ\s*#\s*0*(\d{1,9})/);
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? n : null;
}

export function isBounce(fromEmail: string | null, subject: string | null): boolean {
  if (fromEmail && /^(mailer-daemon|postmaster)@/i.test(fromEmail)) return true;
  return /(delivery status notification|undeliver|mail delivery (failed|subsystem)|returned mail|failure notice|配信不能|配信されません|配信できません|送信できません)/i
    .test(subject ?? "");
}

// 返信メールの、前のメールを引用した部分から後ろを除く。除いた結果が空なら全文を返す
export function stripQuoted(body: string): string {
  const lines = cleanText(body).split("\n");
  const isHeaderStart = (i: number): boolean => {
    const line = lines[i].trim();
    const next = (lines[i + 1] ?? "").trim();
    const after = (lines[i + 2] ?? "").trim();
    if (/^>/.test(line)) return true;
    if (/^On .+ wrote:$/i.test(line) || (/^On /i.test(line) && /wrote:$/i.test(next))) return true;
    // 日付で始まる「引用の見出し」は、メールアドレス(<…@…>)を含み、「：」で終わるものだけ(N)。
    // 「2026年10月6日の勤務は次のとおりです：」のような普通の文を、引用の始まりと間違えて、下の本文を消さないため。
    // アドレスは次の行に分かれることがある(Gmail: "… <" の次の行に "shiftflow.kinmu@gmail.com>:")
    const heading = /[:：]$/.test(line) ? line : `${line} ${next}`.trim();
    const hasAddress = /<[^<>\s]*@[^<>\s]*>?/.test(heading) || /@/.test(heading);
    // Gmail(日本語): 2026年10月6日(火) 12:23 shiftflow 勤務登録 <shiftflow.kinmu@gmail.com>:
    if (/^\d{4}年\d{1,2}月\d{1,2}日/.test(line) && hasAddress && /[:：]$/.test(heading)) return true;
    // iPhone・Apple メール(日本語): 2026/10/06 9:30、shiftflow 勤務登録 <shiftflow.kinmu@gmail.com>のメール:
    if (/^\d{4}\/\d{1,2}\/\d{1,2}/.test(line) && hasAddress && /(のメール|のメッセージ|wrote|書きました)[:：]$/.test(heading)) return true;
    if (/^-{2,}\s*(original message|元のメッセージ|forwarded message|転送メッセージ)/i.test(line)) return true;
    if (/^_{8,}$/.test(line)) return true;
    // Outlook・携帯: 差出人: / From: のあとに 送信日時: / Sent: / 日付: などが続く
    if (/^(from|差出人|送信者)\s*[:：]/i.test(line) && /^(sent|date|to|送信日時|日付|宛先|件名|subject)\s*[:：]/im.test(next + "\n" + after)) {
      return true;
    }
    // アプリが送ったメールの区切り(引用の印なしで貼り付けられたとき)
    if (/^―{4,}$/.test(line) && /^お問い合わせ\s*#/.test(next)) return true;
    return false;
  };
  for (let i = 0; i < lines.length; i++) {
    if (isHeaderStart(i)) {
      const kept = lines.slice(0, i).join("\n").trim();
      return kept || lines.join("\n").trim();
    }
  }
  return lines.join("\n").trim();
}
