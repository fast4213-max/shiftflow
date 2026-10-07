// お問い合わせの計算だけの部品のテスト
//   deno test supabase/functions --allow-read --allow-env

import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  cleanText,
  charLength,
  codeBlock,
  embedLength,
  encodeBase64,
  escapeMarkdown,
  extractEmail,
  findInquiryNo,
  formatCode,
  formatJst,
  formatNo,
  hashCode,
  inboundMailPayload,
  isBounce,
  isValidCode,
  newInquiryPayload,
  normalizeCode,
  normalizeEmail,
  parseNo,
  replyMailText,
  requireLine,
  requireText,
  riskyEmail,
  stripQuoted,
  truncate,
  validateImages,
} from "./contact.ts";
import { AppError } from "./http.ts";
import { sanitizeDbError } from "./contact-repo.ts";
import { validWebhookUrl } from "./discord.ts";
import { validRelayUrl } from "./mail-relay.ts";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

Deno.test("文字数は絵文字も1文字(DB の char_length と同じ)", () => {
  assertEquals(charLength("あ😀a"), 3);
  assertEquals(truncate("あいうえお", 3), "あい…");
  assertEquals(truncate("あい", 3), "あい");
});

Deno.test("内容: 空・長すぎるとエラー、改行と制御文字をそろえる(C5)", () => {
  assertThrows(() => requireText("  \n ", "内容", 10), AppError, "内容を入力してください");
  assertThrows(() => requireText("😀".repeat(11), "内容", 10), AppError, "10文字以内");
  assertEquals(requireText("😀".repeat(10), "内容", 10), "😀".repeat(10));
  assertEquals(requireText(" a\r\nb\u0007 ", "内容", 10), "a\nb");
  assertEquals(requireLine(" 山田\n  太郎 ", "名前", 10), "山田 太郎");
});

Deno.test("メールアドレス: 全角・空白・大文字をそろえ、形の違うものは null(C8)", () => {
  assertEquals(normalizeEmail(" Taro.Yamada＠Gmail.com "), "taro.yamada@gmail.com");
  assertEquals(normalizeEmail("ｔａｒｏ@example.co.jp"), "taro@example.co.jp");
  assertEquals(normalizeEmail("taro+test@sub.example.com"), "taro+test@sub.example.com");
  for (const bad of ["", "taro", "taro@gmail", "@gmail.com", "a@b@c.com", "a@.com", "a@b.", "a b@<c>.com", "a@b.c" + "m".repeat(260)]) {
    assertEquals(normalizeEmail(bad), null, bad);
  }
  // 古い携帯のアドレス(規格外だが実在)は受け付けて、注意を出す(C9)
  assertEquals(normalizeEmail("taro..yamada.@docomo.ne.jp"), "taro..yamada.@docomo.ne.jp");
  assert(riskyEmail("taro..yamada@docomo.ne.jp"));
  assert(riskyEmail("taro.@ezweb.ne.jp"));
  assert(!riskyEmail("taro.yamada@gmail.com"));
  assertEquals(extractEmail("山田 太郎 <Taro@Example.com>"), "taro@example.com");
  assertEquals(extractEmail("taro@example.com"), "taro@example.com");
  assertEquals(extractEmail("名前だけ"), null);
  // 表示名の中に別のアドレスを入れた送信元は、本物(いちばん後ろの <…>)を取る(C)
  assertEquals(extractEmail('"本人 <victim@gmail.com>" <attacker@evil.example>'), "attacker@evil.example");
  assertEquals(extractEmail("victim@gmail.com <attacker@evil.example>"), "attacker@evil.example");
  assertEquals(extractEmail("<a@b.com> <c@d.com>"), "c@d.com");
});

Deno.test("受付番号・確認コード: 全角・ハイフン・小文字を許す(C11)", async () => {
  assertEquals(formatNo(12), "#0012");
  assertEquals(formatNo(12345), "#12345");
  assertEquals(parseNo("#0012"), 12);
  assertEquals(parseNo("＃００１２"), 12);
  assertEquals(parseNo(" 12 "), 12);
  assertEquals(parseNo("0"), null);
  assertEquals(parseNo("12a"), null);
  assertEquals(normalizeCode("k7qm-4xpa"), "K7QM4XPA");
  assertEquals(normalizeCode("Ｋ７ＱＭ　４ＸＰＡ"), "K7QM4XPA");
  assert(isValidCode("K7QM4XPA"));
  assert(!isValidCode("K7QM4XP0")); // 0 は使わない
  assert(!isValidCode("K7QM4XP"));
  assertEquals(formatCode("K7QM4XPA"), "K7QM-4XPA");
  const key = "AAAAAAAA-0000-0000-0000-000000000001";
  assertEquals(await hashCode("K7QM4XPA", key), await hashCode("K7QM4XPA", key.toLowerCase()));
  assert((await hashCode("K7QM4XPA", key)) !== (await hashCode("K7QM4XPB", key)));
});

Deno.test("画像: JPEG・PNG だけ、3枚まで、大きすぎるものは受け付けない(I6)", () => {
  assertEquals(validateImages(undefined), []);
  const ok = validateImages([{ data: encodeBase64(JPEG) }, { data: "data:image/png;base64," + encodeBase64(PNG) }]);
  assertEquals(ok.map((i) => i.type), ["image/jpeg", "image/png"]);
  assertEquals(ok[0].bytes, JPEG);
  assertThrows(() => validateImages([{ data: btoa("GIF89a....") }]), AppError, "画像(JPEG・PNG)ではありません");
  assertThrows(() => validateImages([{ data: "%%%" }]), AppError, "読めませんでした");
  assertThrows(() => validateImages([1, 2, 3, 4].map(() => ({ data: encodeBase64(JPEG) }))), AppError, "3枚まで");
  const big = new Uint8Array(1_500_001);
  big.set(JPEG);
  assertThrows(() => validateImages([{ data: encodeBase64(big) }]), AppError, "大きすぎます");
  assertThrows(() => validateImages("x"), AppError);
});

Deno.test("日本時間の表示", () => {
  assertEquals(formatJst("2026-10-05T23:12:00Z"), "10/06 08:12");
});

const INQ = {
  id: 12,
  logged_in: false,
  employee_no: "1234567",
  name: "山田 *太郎*",
  office_name: "",
  kind: "login",
  reply_via: "mail",
  image_count: 2,
  created_at: "2026-10-05T23:12:00Z",
};

Deno.test("Discord: メンションを無効にし、空の欄を作らず、上限に収める(D2・D3・D4)", () => {
  const p = newInquiryPayload(INQ, "@everyone 見て [ここ](https://evil.example) ```x```" + "あ".repeat(5000));
  assertEquals(p.allowed_mentions, { parse: [] });
  const e = p.embeds[0] as { title: string; description: string; fields: { name: string; value: string }[] };
  assertEquals(e.title, "📩 新しいお問い合わせ #0012");
  assert(e.description.startsWith("```\n") && e.description.endsWith("\n```"));
  assert(!e.description.slice(4, -4).includes("```"));
  assert(charLength(e.description) <= 1800);
  for (const f of e.fields) {
    assert(f.value.length > 0 && charLength(f.value) <= 1024, f.name);
  }
  assertEquals(e.fields.find((f) => f.name === "所属")!.value, "—");
  assertEquals(e.fields.find((f) => f.name === "名前")!.value, "山田 \\*太郎\\*");
  assert(e.fields.some((f) => f.name === "画像"));
  assert(embedLength(p) <= 6000);
  assertEquals(escapeMarkdown("[a](b)"), "\\[a\\]\\(b\\)");
  assertEquals(codeBlock("", 100), "```\n \n```");

  const noImage = newInquiryPayload({ ...INQ, image_count: 0 }, "x");
  assert(!(noImage.embeds[0].fields as { name: string }[]).some((f) => f.name === "画像"));

  const inbound = inboundMailPayload(12, { from_email: null, subject: null, body: "", bounce: true, mismatch: true, attachments: "a.jpg" });
  const ie = inbound.embeds[0] as { title: string; fields: { name: string; value: string }[] };
  assert(ie.title.includes("届きませんでした"));
  assert(ie.fields.every((f) => f.value.length > 0));
  assertEquals(inbound.allowed_mentions, { parse: [] });
});

Deno.test("返事のメール: 宛名・返事・最初の内容の引用・返信できる案内", () => {
  const text = replyMailText(INQ, "PINを再設定しました。", "PINを忘れました。\n再設定をお願いします。");
  assert(text.startsWith("山田 *太郎* 様\n"));
  assert(text.includes("PINを再設定しました。"));
  assert(text.includes("お問い合わせ #0012(10/06 08:12)"));
  assert(text.includes("> PINを忘れました。\n> 再設定をお願いします。"));
  assert(text.includes("このメールに返信していただいても届きます。"));
  assert(!/https?:\/\//.test(text)); // URL は入れない(M11)
});

Deno.test("返事のメール(2回目以降): あいさつと元の内容の引用を付けない短い文面", () => {
  const text = replyMailText(INQ, "了解しました。お待ちしています。", "PINを忘れました。", true);
  assertEquals(text, [
    "山田 *太郎* 様",
    "",
    "了解しました。お待ちしています。",
    "",
    "――――――",
    "お問い合わせ #0012 のつづきです。",
    "このメールに返信していただいても届きます。",
  ].join("\n"));
  assert(!text.includes("管理者です") && !text.includes("ありがとうございます") && !text.includes("> "));
});

Deno.test("受信メール: 件名の番号・届かなかった知らせを見分ける", () => {
  assertEquals(findInquiryNo("Re: 【shiftflow 勤務登録】お問い合わせ #0012 への返事"), 12);
  assertEquals(findInquiryNo("RE: お問い合わせ ＃１２"), 12);
  assertEquals(findInquiryNo("#12 ではない"), null);
  assertEquals(findInquiryNo("お問い合わせ #0"), null);
  assert(isBounce("mailer-daemon@googlemail.com", "Delivery Status Notification (Failure)"));
  assert(isBounce(null, "Undeliverable: お問い合わせ #0012"));
  assert(isBounce("postmaster@docomo.ne.jp", "x"));
  assert(!isBounce("taro@gmail.com", "Re: お問い合わせ #0012 への返事"));
});

Deno.test("受信メール: いろいろな書き方の引用を取り除く(R5)", () => {
  const cases: [string, string][] = [
    ["ありがとうございます。\n\n2026年10月6日(月) 9:30 shiftflow 勤務登録 <shiftflow.kinmu@gmail.com>:\n> 山田 太郎 様", "ありがとうございます。"],
    ["了解です\n\n2026年10月6日(月) 9:30 shiftflow 勤務登録 <\nshiftflow.kinmu@gmail.com>:\n\n> 本文", "了解です"],
    ["行きます\n\n2026/10/06 9:30、shiftflow 勤務登録 <shiftflow.kinmu@gmail.com>のメール:\n\n山田 太郎 様", "行きます"],
    ["OK\n\nOn Mon, Oct 6, 2026 at 9:30 AM shiftflow wrote:\n> hi", "OK"],
    ["OK\n\nOn Mon, Oct 6, 2026 at 9:30 AM shiftflow <\nx@gmail.com> wrote:\n> hi", "OK"],
    ["はい\n-----Original Message-----\nFrom: x", "はい"],
    ["はい\n\n差出人: shiftflow 勤務登録\n送信日時: 2026年10月6日 9:30\n宛先: 山田", "はい"],
    ["はい\n\nFrom: shiftflow\n[mailto:x@gmail.com]\nSent: Monday", "はい"],
    ["はい\n――――――\nお問い合わせ #0012(10/06 08:12)", "はい"],
    // 日付で始まって「：」で終わる普通の文は、引用の始まりではない。下の本文を消さない(N)
    ["2026年10月6日の勤務は次のとおりです：\n201\n202", "2026年10月6日の勤務は次のとおりです：\n201\n202"],
    ["確認です。\n2026年10月6日(火)の勤務は、次のとおりでよいですか：\n201\n202", "確認です。\n2026年10月6日(火)の勤務は、次のとおりでよいですか：\n201\n202"],
    ["2026/10/06 の予定は次のメール:\nA\nB", "2026/10/06 の予定は次のメール:\nA\nB"],
    // Apple メール(日本語)の見出しは引用の始まり
    ["了解\n\n2026/10/06 9:30、山田 <taro@gmail.com> のメッセージ:\n\n本文", "了解"],
    // 本文に「差出人:」と書いただけ(次の行が日時などでない)は残す
    ["差出人: 私です\n明日行きます", "差出人: 私です\n明日行きます"],
    // 引用だけのメール(上に何も書いていない)は全文を出す
    ["> 引用だけ", "> 引用だけ"],
    ["", ""],
  ];
  for (const [input, expected] of cases) assertEquals(stripQuoted(input), expected, input);
});

Deno.test("Webhook・GAS の URL の形を確かめる(打ち間違いで別の所へ送らない)", () => {
  assert(validWebhookUrl("https://discord.com/api/webhooks/123456/abc-DEF_9"));
  assert(validWebhookUrl(" https://discordapp.com/api/v10/webhooks/1/x "));
  assertEquals(validWebhookUrl("https://evil.example/api/webhooks/1/x"), null);
  assertEquals(validWebhookUrl("http://discord.com/api/webhooks/1/x"), null);
  assertEquals(validWebhookUrl(undefined), null);
  assert(validRelayUrl("https://script.google.com/macros/s/AKfycb-x_y/exec"));
  assertEquals(validRelayUrl("https://script.google.com/macros/s/AKfycb/dev"), null);
  assertEquals(validRelayUrl("https://evil.example/macros/s/x/exec"), null);
});

Deno.test("DB のエラーのログに、失敗した行の中身(社員番号・氏名・メールアドレス)を出さない(O)", () => {
  const e = sanitizeDbError({
    code: "23514",
    message: 'new row for relation "inquiries" violates check constraint "inquiries_kind_check"',
    details: "Failing row contains (3, aaaa, null, f, 7654321, 佐藤 花子, x, hack, mail, taro@gmail.com)",
  });
  assertEquals(e.message, 'DB error 23514: new row for relation "inquiries" violates check constraint "inquiries_kind_check"');
  assert(!e.message.includes("7654321") && !e.message.includes("taro@gmail.com") && !e.message.includes("佐藤"));
  assertEquals(sanitizeDbError(null).message, "DB error : ");
  assertEquals(sanitizeDbError({ code: "X", message: "a\nFailing row 1234567" }).message, "DB error X: a");
});

Deno.test("cleanText: 対になっていない UTF-16 の半分(絵文字の途中の切れ目)は除く(S13)", () => {
  assertEquals(cleanText("あ\uD83D"), "あ");
  assertEquals(cleanText("\uDE00い"), "い");
  assertEquals(cleanText("😀え"), "😀え");
});
