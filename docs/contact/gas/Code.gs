/**
 * shiftflow お問い合わせ用 GAS(専用 Gmail: shiftflow.kinmu@gmail.com で動かす)
 *
 * できること
 *   doPost         Supabase の Edge Function から呼ばれて、メールを送る
 *                    reply   … 問い合わせへの返事(相手のメールがあれば、そのメールに返信)
 *                    receipt … 画像つきの問い合わせを、この Gmail 自身に「受付メール」として送る(控え)
 *                    ping    … 動いているかの確認
 *   pollInbox      5分ごと: 受信トレイの新しいメールを Supabase(mail-inbound)へ渡す
 *   dailyCleanup   1日1回: 90日たった shiftflow のメールをゴミ箱へ。Supabase の古いもの・Discord の通知も消してもらう
 *   setup          最初に1回だけ手で実行: ラベルとトリガーを作り、設定を確かめる
 *
 * スクリプト プロパティ(「プロジェクトの設定」→「スクリプト プロパティ」)
 *   SECRET    合言葉(Supabase の MAIL_RELAY_SECRET と同じ値。makeSecret を実行すると作れる)
 *   HOOK_URL  https://<プロジェクト>.supabase.co/functions/v1/mail-inbound
 *
 * 手順は docs/contact/SETUP.md。コードを直したら「デプロイを管理」→ 鉛筆 →「新しいバージョン」で更新する(URL は変わらない)。
 */

const VERSION = "2026-10-06";
const SENDER_NAME = "shiftflow 勤務登録";
const LABEL_ROOT = "shiftflow"; // 90日で消す対象の印(すべての shiftflow のメールに付ける)
const LABEL_RECEIPT = "shiftflow/受付";
const LABEL_REPLY = "shiftflow/返事";
const LABEL_INBOX = "shiftflow/受信";
const KEEP_DAYS = 90;

function props_() {
  return PropertiesService.getScriptProperties();
}

function self_() {
  return String(Session.getEffectiveUser().getEmail() || "").toLowerCase();
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function label_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function addLabels_(thread, sub) {
  thread.addLabel(label_(LABEL_ROOT));
  if (sub) thread.addLabel(label_(sub));
}

// "山田 <A@B.com>" → "a@b.com"。
// 表示名の中に別のアドレスを入れられる("本人 <victim@x>" <attacker@y>)ので、本物はいちばん後ろの <…>
function address_(from) {
  const s = String(from || "");
  const all = s.match(/<[^<>]+>/g);
  return (all ? all[all.length - 1].slice(1, -1) : s).trim().toLowerCase();
}

function validEmail_(s) {
  return /^[^\s@<>]+@[^\s@<>.][^\s@<>]*\.[^\s@<>.]+$/.test(String(s || "")) && String(s).length <= 254;
}

function quota_() {
  try {
    return MailApp.getRemainingDailyQuota();
  } catch (err) {
    return null;
  }
}

// ============================================================
// Supabase から呼ばれる
// ============================================================

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e && e.postData ? e.postData.contents : "");
  } catch (err) {
    return out_({ ok: false, error: "JSON を読めません" });
  }
  const secret = props_().getProperty("SECRET") || "";
  if (secret.length < 16 || String(req.secret || "") !== secret) return out_({ ok: false, error: "合言葉が違います" });
  if (!(Math.abs(Date.now() - Number(req.ts)) < 15 * 60 * 1000)) return out_({ ok: false, error: "時刻が合いません" });
  try {
    if (req.action === "ping") return out_({ ok: true, version: VERSION, quota: quota_(), address: self_() });
    if (req.action === "reply") return out_(withLock_(() => sendReply_(req)));
    if (req.action === "receipt") return out_(withLock_(() => sendReceipt_(req)));
    return out_({ ok: false, error: "知らない操作です" });
  } catch (err) {
    console.error(err);
    return out_({ ok: false, error: String((err && err.message) || err).slice(0, 300) });
  }
}

// 同じ key の送信が同時に来ても1通にするため、送信は1つずつ行う
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { ok: false, error: "ほかの処理の途中です。少し待ってからもう一度送ってください" };
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// 送ったことの記録(同じ key で2回目に呼ばれたら、送らずに前の結果を返す。M4・M5)
function sentBefore_(key) {
  const v = props_().getProperty("sent:" + key);
  return v ? JSON.parse(v) : null;
}

function rememberSent_(key, message) {
  const rec = { message_id: message.getId(), thread_id: message.getThread().getId(), at: Date.now() };
  props_().setProperty("sent:" + key, JSON.stringify(rec));
  return rec;
}

function checkKey_(key) {
  if (!/^[\w-]{8,80}$/.test(String(key || ""))) throw new Error("key の形が正しくありません");
}

function checkQuota_(n) {
  const q = quota_();
  if (q !== null && q < n) throw new Error("今日送れるメールの数の上限です(残り " + q + " 通)。明日もう一度送ってください");
}

// 問い合わせへの返事。
//   reply_to_message_id があれば、そのメール(相手から届いたもの)に返信する。宛先はそのメールの差出人と同じでなければ送らない。
//   無ければ、決まった件名で新しく送る(踏み台にされないよう、件名は shiftflow のものだけ。M10)
function sendReply_(req) {
  checkKey_(req.key);
  const before = sentBefore_(req.key);
  if (before) return { ok: true, duplicate: true, message_id: before.message_id, thread_id: before.thread_id, quota: quota_() };
  const to = String(req.to || "").trim().toLowerCase();
  const body = String(req.body || "");
  if (!validEmail_(to)) throw new Error("宛先の形が正しくありません");
  if (!body || body.length > 20000) throw new Error("本文が空か、長すぎます");
  checkQuota_(1);

  let original = null;
  if (req.reply_to_message_id) {
    try {
      original = GmailApp.getMessageById(String(req.reply_to_message_id));
    } catch (err) {
      original = null; // Gmail で消した(ゴミ箱から完全に消えた)など
    }
  }
  // Reply-To(返信先)が差出人と別のアドレスだと、返信がそちらへ飛ぶ。そのメールには返信せず、宛先を確かめた新しいメールで送る(C)
  if (original) {
    if (address_(original.getFrom()) !== to) throw new Error("返信するメールの差出人と宛先が違います");
    const replyTo = String(original.getReplyTo() || "");
    if (replyTo && address_(replyTo) !== to) original = null;
  }
  let sent;
  if (original) {
    sent = original.createDraftReply(body, { name: SENDER_NAME }).send();
  } else {
    // 返信するメールが無いときは、shiftflow の件名でだけ新しく送る
    const subject = String(req.subject || "");
    if (subject.indexOf("【shiftflow 勤務登録】") !== 0 || subject.length > 200) {
      throw new Error(req.reply_to_message_id ? "返信するメールが Gmail に見つかりません" : "件名が shiftflow のものではありません");
    }
    sent = GmailApp.createDraft(to, subject, body, { name: SENDER_NAME }).send();
  }
  // 先に「送った」と覚える。ラベルを付けるのに失敗しても、送り直しで2通目を送らないように(失敗しても送信は成功扱い)
  const rec = rememberSent_(req.key, sent);
  try {
    addLabels_(sent.getThread(), LABEL_REPLY);
  } catch (err) {
    console.error("ラベルを付けられませんでした: " + err);
  }
  return { ok: true, message_id: rec.message_id, thread_id: rec.thread_id, quota: quota_() };
}

// 画像つきの問い合わせの控えを、この Gmail 自身に送る
function sendReceipt_(req) {
  checkKey_(req.key);
  const before = sentBefore_(req.key);
  if (before) return { ok: true, duplicate: true, message_id: before.message_id, thread_id: before.thread_id, quota: quota_() };
  const subject = String(req.subject || "");
  if (subject.indexOf("【shiftflow 受付】") !== 0 || subject.length > 200) throw new Error("件名が shiftflow のものではありません");
  const images = Array.isArray(req.images) ? req.images.slice(0, 3) : [];
  const blobs = images.map((img, i) => {
    const bytes = Utilities.base64Decode(String(img.data || ""));
    if (bytes.length > 2 * 1024 * 1024) throw new Error((i + 1) + "枚目の画像が大きすぎます");
    const type = img.type === "image/png" ? "image/png" : "image/jpeg";
    const name = /^[\w.-]{1,40}$/.test(String(img.name || "")) ? img.name : "image-" + (i + 1) + (type === "image/png" ? ".png" : ".jpg");
    return Utilities.newBlob(bytes, type, name);
  });
  checkQuota_(1);
  const sent = GmailApp.createDraft(self_(), subject, String(req.body || "").slice(0, 20000), {
    name: SENDER_NAME,
    attachments: blobs,
  }).send();
  const rec = rememberSent_(req.key, sent); // 先に覚える(ラベルの失敗で、送り直しが2通目にならないように)
  try {
    addLabels_(sent.getThread(), LABEL_RECEIPT);
  } catch (err) {
    console.error("ラベルを付けられませんでした: " + err);
  }
  return { ok: true, message_id: rec.message_id, thread_id: rec.thread_id, quota: quota_() };
}

// ============================================================
// Supabase へ渡す
// ============================================================

function hook_(payload) {
  const url = props_().getProperty("HOOK_URL") || "";
  const secret = props_().getProperty("SECRET") || "";
  if (!/^https:\/\/[\w-]+\.supabase\.co\/functions\/v1\/mail-inbound$/.test(url)) throw new Error("スクリプト プロパティ HOOK_URL の形が正しくありません");
  payload.secret = secret;
  payload.ts = Date.now();
  payload.self = self_();
  payload.status = { version: VERSION, quota: quota_() };
  const res = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  let json = {};
  try {
    json = JSON.parse(res.getContentText());
  } catch (err) {
    // そのまま下でエラーにする
  }
  if (code !== 200 || !json.ok) throw new Error("Supabase " + code + ": " + String(json.error || res.getContentText()).slice(0, 200));
  return json;
}

// Google からのお知らせ(セキュリティ通知など)は取り込まない・消さない
function isGoogleNotice_(addr) {
  return /@(accounts\.)?google\.com$/.test(addr) || (/@googlemail\.com$/.test(addr) && !/^mailer-daemon@/.test(addr));
}

function plainBody_(m) {
  let text = "";
  try {
    text = m.getPlainBody() || "";
  } catch (err) {
    text = "";
  }
  if (!text.trim()) {
    // HTML だけのメール: タグを除く(R6)
    text = String(m.getBody() || "")
      .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  }
  return text.slice(0, 20000);
}

// 5分ごと: 受信トレイ(迷惑メールは除く)の、まだ渡していないメールを Supabase へ。
// 渡せたもの(known)は6時間覚えて、次からは送らない。Supabase も同じメールは二重に入れない(R1・R2)
function pollInbox() {
  // 前の回がまだ動いているときは、何もしない。
  // スクリプトのロック(LockService)は使わない: 返事の送信(doPost)が同じロックを待つので、取り込みが長引くと送信が失敗してしまう。
  // 同じメールを二重に取り込んでも、Supabase が Gmail のメッセージIDで二重を防ぐ
  const running = Number(props_().getProperty("polling_since") || 0);
  if (Date.now() - running < 4 * 60 * 1000) return;
  props_().setProperty("polling_since", String(Date.now()));
  try {
    const cache = CacheService.getScriptCache();
    const self = self_();
    const since = Date.now() - 14 * 86400000;
    const threads = GmailApp.search("in:inbox newer_than:14d", 0, 50);
    const mails = [];
    const threadOf = {};
    for (let t = 0; t < threads.length && mails.length < 30; t++) {
      const messages = threads[t].getMessages();
      const ids = messages.map((m) => "seen:" + m.getId());
      const seen = cache.getAll(ids);
      for (let i = 0; i < messages.length && mails.length < 30; i++) {
        const m = messages[i];
        if (seen["seen:" + m.getId()] || m.isInTrash() || m.getDate().getTime() < since) continue;
        const addr = address_(m.getFrom());
        if (addr === self || isGoogleNotice_(addr)) {
          cache.put("seen:" + m.getId(), "1", 21600);
          continue;
        }
        let attachments = [];
        try {
          attachments = m.getAttachments({ includeInlineImages: false }).map((a) => a.getName()).slice(0, 10);
        } catch (err) {
          attachments = ["(添付あり)"];
        }
        mails.push({
          id: m.getId(),
          thread_id: threads[t].getId(),
          from: m.getFrom(),
          subject: m.getSubject() || "",
          date: m.getDate().toISOString(),
          body: plainBody_(m),
          attachments: attachments,
        });
        threadOf[m.getId()] = threads[t];
      }
    }
    if (!mails.length) {
      // 新しいメールが無いときも、10分に1回は「動いている」を知らせる(R12)
      if (!cache.get("heartbeat")) {
        hook_({ action: "heartbeat" });
        cache.put("heartbeat", "1", 600);
      }
      return;
    }
    const res = hook_({ action: "mail", mails: mails });
    (res.known || []).forEach((id) => {
      cache.put("seen:" + id, "1", 21600);
      if (threadOf[id]) addLabels_(threadOf[id], LABEL_INBOX);
    });
    cache.put("heartbeat", "1", 600);
  } finally {
    props_().deleteProperty("polling_since");
  }
}

// 1日1回: 最後のメールから90日たった shiftflow のスレッドをゴミ箱へ(30日は戻せる)。送った記録も古いものを消す。
// Supabase の古い問い合わせ・Discord の通知も消してもらう
function dailyCleanup() {
  const limit = Date.now() - KEEP_DAYS * 86400000;
  let trashed = 0;
  const threads = GmailApp.search("label:" + LABEL_ROOT + " older_than:" + KEEP_DAYS + "d", 0, 100);
  threads.forEach((thread) => {
    // older_than はスレッドの中の古いメールでも当たるので、最後のメールの日付で確かめる(X9)
    if (thread.getLastMessageDate().getTime() < limit) {
      thread.moveToTrash();
      trashed++;
    }
  });
  const all = props_().getProperties();
  Object.keys(all).forEach((k) => {
    if (k.indexOf("sent:") !== 0) return;
    try {
      if (JSON.parse(all[k]).at < Date.now() - 30 * 86400000) props_().deleteProperty(k);
    } catch (err) {
      props_().deleteProperty(k);
    }
  });
  const res = hook_({ action: "maintenance", gmail_trashed: trashed });
  console.log("ゴミ箱へ: " + trashed + "件 / Supabase: " + JSON.stringify(res));
}

// ============================================================
// 最初に手で実行する
// ============================================================

// 合言葉を作って SECRET に入れ、ログに出す(その値を Supabase の MAIL_RELAY_SECRET に入れる)
function makeSecret() {
  const secret = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, "");
  props_().setProperty("SECRET", secret);
  console.log("SECRET を作りました。この値を Supabase の MAIL_RELAY_SECRET に入れてください:\n" + secret);
}

// ラベルとトリガーを作り、Supabase とつながるか確かめる
function setup() {
  if ((props_().getProperty("SECRET") || "").length < 16) throw new Error("先に makeSecret を実行して、合言葉(SECRET)を作ってください");
  if (!/^https:\/\/[\w-]+\.supabase\.co\/functions\/v1\/mail-inbound$/.test(props_().getProperty("HOOK_URL") || "")) {
    throw new Error("スクリプト プロパティ HOOK_URL に https://<プロジェクト>.supabase.co/functions/v1/mail-inbound を入れてください");
  }
  [LABEL_ROOT, LABEL_RECEIPT, LABEL_REPLY, LABEL_INBOX].forEach(label_);
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (["pollInbox", "dailyCleanup"].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("pollInbox").timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger("dailyCleanup").timeBased().everyDays(1).atHour(4).create();
  console.log("ラベルとトリガー(5分ごと・毎日4時)を作りました。送信元: " + self_() + " / 今日送れる残り: " + quota_() + "通");
  hook_({ action: "heartbeat" });
  console.log("Supabase とつながりました。管理画面の「お問い合わせ」に「最後に確認: 0分前」と出ます。");
}
