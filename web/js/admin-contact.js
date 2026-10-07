// 管理画面の「お問い合わせ」タブ: 一覧・やり取り・返事(画面 / メール)・送り直し・対応済み・受信メール。
// 文字はすべて textContent で入れる(受信メールの本文などを HTML として読まない。R15)。
// 予想されるバグの番号は docs/contact/DESIGN.md。
import { friendlyText, $, callFunction, newRequestKey } from "./app.js?v=dev";
import { CONTACT_EMAIL } from "./config.js?v=dev";

const KIND_LABELS = { login: "ログインできない", howto: "使い方・質問", bug: "不具合", other: "その他" };
const MAX_REPLY = 3000;
// メールを送る操作の待ち時間。サーバーは GAS を最大28秒待ち、GAS 側でも順番待ちがあるので、既定の30秒より長くする(Q5)
const MAIL_TIMEOUT_MS = 60000;

let filter = "todo";
let selectedId = null;
let config = { discord: false, relay: false };
let loadSeq = 0;
// 問い合わせごとの書きかけの返事(別の問い合わせを開いても消えない。A2)。key は二度押し対策(送れるまで同じものを使う)
const drafts = new Map();

function setMessage(id, text, kind) {
  $(id).textContent = friendlyText(text) || "";
  $(id).className = "message" + (kind ? " " + kind : "");
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

function btn(label, onClick, className) {
  const b = el("button", className, label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

const no = (id) => "#" + String(id).padStart(4, "0");

function at(value) {
  if (!value) return "—";
  const d = new Date(value);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function minutesAgo(value) {
  return Math.floor((Date.now() - new Date(value).getTime()) / 60000);
}

function gmailBase() {
  return `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(CONTACT_EMAIL)}`;
}

function gmailLink(label, hash) {
  const a = el("a", "gmail-link", label);
  a.href = gmailBase() + "#" + hash;
  a.target = "_blank";
  a.rel = "noopener";
  return a;
}

function statusBadge(inq) {
  if (inq.has_new_mail) return el("span", "status-badge newmail", "新着メール");
  if (inq.status === "open") return el("span", "status-badge open", "未対応");
  if (inq.status === "replied") return el("span", "status-badge replied", "返信済み");
  return el("span", "status-badge done", "完了");
}

// ---------- 状態(GAS・Discord) ----------

function renderStatus(statuses, cfg) {
  const box = $("contact-status");
  box.innerHTML = "";
  const line = (kind, text) => box.appendChild(el("div", "status-line " + kind, text));
  if (!cfg.discord) line("warn", "Discord の Webhook が未設定です(Supabase の Secrets の DISCORD_WEBHOOK_URL)。通知は届きません。");
  if (!cfg.relay) line("warn", "メールの中継(GAS)が未設定です(MAIL_RELAY_URL / MAIL_RELAY_SECRET)。メールでは返事を送れません。");
  const gas = statuses.gas;
  if (!gas) {
    line("warn", "メールの取り込み(GAS)から、まだ一度も知らせが来ていません。GAS の setup を実行してください。");
  } else {
    const m = minutesAgo(gas.updated_at);
    const quota = gas.value && gas.value.quota != null ? ` ・ 今日送れる残り ${gas.value.quota}通` : "";
    line(m > 30 ? "warn" : "ok", `メールの取り込み(GAS): 最後に確認 ${m}分前${quota}` +
      (m > 30 ? "(30分以上止まっています。GAS のトリガーと承認を確認してください)" : ""));
  }
  const maint = statuses.maintenance || statuses.purge;
  if (maint) {
    const days = Math.floor(minutesAgo(maint.updated_at) / 1440);
    line(days >= 2 ? "warn" : "ok", `古いもの(90日)の削除: 最後に実行 ${at(maint.updated_at)}` + (days >= 2 ? "(2日以上止まっています)" : ""));
  }
}

function renderCounts(counts) {
  const todo = counts.todo || 0;
  $("contact-badge").textContent = todo;
  $("contact-badge").classList.toggle("hidden", !todo);
  $("count-todo").textContent = todo ? ` ${todo}` : "";
  $("count-unmatched").textContent = counts.unmatched ? ` ${counts.unmatched}` : "";
  const alert = $("contact-alert");
  alert.innerHTML = "";
  if (todo) {
    const div = el("div", "alert warn");
    div.appendChild(el("span", null, `未対応のお問い合わせが ${todo}件 あります。`));
    div.appendChild(btn("お問い合わせへ", () => document.querySelector('.dtab[data-tab="contact"]').click()));
    alert.appendChild(div);
  }
}

// ---------- 一覧 ----------

// quiet: 返信したあとなどの読み直し(出しているメッセージを消さない)
async function loadList({ quiet = false } = {}) {
  const seq = ++loadSeq;
  if (!quiet) setMessage("contact-list-message", "読み込んでいます…");
  try {
    const res = await callFunction("admin-contact", { action: "list", filter });
    if (seq !== loadSeq) return; // 絞り込みを切り替えた(古い結果は使わない)
    config = res.config;
    renderStatus(res.statuses || {}, res.config);
    renderCounts(res.counts || {});
    if (filter === "unmatched") renderUnmatched(res.unmatched_mails);
    else renderList(res.inquiries);
    if (!quiet) setMessage("contact-list-message", "");
  } catch (err) {
    if (seq === loadSeq) setMessage("contact-list-message", err.message || String(err), "error");
  }
}

function renderList(list) {
  const box = $("contact-list");
  box.innerHTML = "";
  if (!list.length) {
    box.appendChild(el("p", "muted", filter === "todo" ? "未対応のお問い合わせはありません。" : "ありません。"));
    return;
  }
  list.forEach((inq) => {
    const item = el("button", "contact-item" + (inq.id === selectedId ? " selected" : ""));
    item.type = "button";
    const head = el("div", "contact-item-head");
    head.append(statusBadge(inq), el("strong", null, `${no(inq.id)} ・ ${KIND_LABELS[inq.kind] || inq.kind}`), el("span", "muted small right", at(inq.last_activity_at)));
    const who = el("div", null, `${inq.employee_no} ${inq.name}`);
    const sub = el("div", "muted small", [
      inq.logged_in ? "ログイン後" : "ログイン前",
      inq.reply_via === "mail" ? "返事: メール" : "返事: 画面",
      inq.image_count ? `画像${inq.image_count}枚` : "",
    ].filter(Boolean).join(" ・ "));
    item.append(head, who, sub);
    item.addEventListener("click", () => openDetail(inq.id));
    box.appendChild(item);
  });
}

// ---------- 詳細 ----------

// quiet: 返事を送ったあとなどの読み直し(出しているメッセージを消さない)
async function openDetail(id, { quiet = false } = {}) {
  selectedId = id;
  document.querySelectorAll(".contact-item").forEach((x) => x.classList.remove("selected"));
  if (!quiet) setMessage("contact-detail-message", "読み込んでいます…");
  try {
    const res = await callFunction("admin-contact", { action: "get", id });
    if (selectedId !== id) return;
    renderDetail(res);
    if (!quiet) setMessage("contact-detail-message", "");
    // 新着の印が消えたので、一覧と件数を読み直す
    if (res.inquiry && filter !== "unmatched") loadList({ quiet: true });
    if (window.matchMedia("(max-width: 899px)").matches) $("contact-detail").scrollIntoView({ block: "start" });
  } catch (err) {
    setMessage("contact-detail-message", err.message || String(err), "error");
  }
}

function infoRow(dl, label, value) {
  dl.append(el("dt", null, label), el("dd", null, value));
}

function mailStatusLine(m, inq) {
  const div = el("div", "mail-status");
  // 送信中のまま2分以上たったもの(関数が途中で止まった)は、送れたか分からない扱いにして送り直せるようにする
  if (m.mail_status === "sending" && minutesAgo(m.created_at) >= 2) m = { ...m, mail_status: "unknown", mail_error: "送信の途中で止まりました" };
  if (m.mail_status === "sent") {
    div.classList.add("ok");
    div.textContent = `メールで送りました(${m.from_email || ""})`;
  } else if (m.mail_status === "sending") {
    div.textContent = "送信中…(しばらくたっても変わらないときは、読み直してください)";
  } else if (m.mail_status === "failed" || m.mail_status === "unknown") {
    div.classList.add("error");
    div.textContent = m.mail_status === "failed"
      ? `送れませんでした: ${m.mail_error || ""}`
      : `送れたか分かりません(${m.mail_error || ""})。Gmail の「送信済み」を見て、無ければ「もう一度送る」を押してください(送れていたら2通目は送られません)。`;
    if (m.inquiry_id != null) {
      div.appendChild(btn("もう一度送る", async (ev) => {
        ev.target.disabled = true;
        try {
          const res = await callFunction("admin-contact", { action: "resend", message_id: m.id }, { timeoutMs: MAIL_TIMEOUT_MS });
          await openDetail(inq.id, { quiet: true });
          const ok = res.message && res.message.mail_status === "sent";
          setMessage("contact-detail-message", ok ? "送りました。" : "送れませんでした。表示を確認してください。", ok ? "ok" : "error");
        } catch (err) {
          setMessage("contact-detail-message", err.message || String(err), "error");
          ev.target.disabled = false;
        }
      }));
    }
  }
  return div;
}

function messageBubble(m, inq) {
  const kind = m.sender === "admin" ? "from-admin" : m.sender === "mail" ? "from-mail" : "from-user";
  const b = el("div", "bubble " + kind + (m.bounce ? " bounce" : ""));
  const head = el("div", "bubble-who");
  const who = m.sender === "admin" ? "管理者" : m.sender === "mail" ? (m.from_email || "不明") : inq ? inq.name : "利用者";
  head.appendChild(el("span", null, `${who} ・ ${at(m.created_at)}`));
  const tag = m.bounce ? "届かなかった知らせ" : m.sender === "mail" ? "メール受信" : m.channel === "mail" ? "メール送信" : "画面";
  head.appendChild(el("span", "tag " + (m.bounce ? "bounce" : m.sender === "mail" ? "in" : m.channel === "mail" ? "out" : "web"), tag));
  b.appendChild(head);
  if (m.sender === "mail" && m.subject) b.appendChild(el("div", "muted small", "件名: " + m.subject));
  // 件名の番号で入ってきたメールで、問い合わせのアドレスと違う人から(R9)
  if (inq && m.sender === "mail" && !m.bounce && (!inq.email || m.from_email !== inq.email)) {
    b.appendChild(el("div", "warn-text small", "⚠️ 問い合わせのメールアドレスと違う人からのメールです。本人か確かめてください。"));
  }
  const text = el("div", "bubble-text", m.body);
  b.appendChild(text);
  if (m.body_full) {
    b.appendChild(btn("全文を見る(引用を含む)", (ev) => {
      text.textContent = m.body_full;
      ev.target.remove();
    }, "link-button"));
  }
  if (m.attachment_names) b.appendChild(el("div", "muted small", `添付: ${m.attachment_names}(Gmailで見てください)`));
  if (m.sender === "admin" && m.channel === "mail") b.appendChild(mailStatusLine(m, inq));
  if (m.gmail_thread_id) b.appendChild(gmailLink("Gmailで開く", "all/" + m.gmail_thread_id));
  return b;
}

function renderDetail({ inquiry: inq, messages, registered, reply_to_email: replyTo }) {
  const box = $("contact-detail");
  box.innerHTML = "";
  const title = el("div", "detail-title");
  title.append(el("h2", null, `${no(inq.id)} ${KIND_LABELS[inq.kind] || inq.kind}`), statusBadge(inq));
  box.appendChild(title);
  if (!inq.logged_in) {
    box.appendChild(el("div", "alert danger", "ログイン前の問い合わせです(本人か確かめられていません)。仮のPINは、画面でもメールでも返事に書かず、直接伝えてください。"));
  }
  const dl = el("dl", "info");
  infoRow(dl, "社員番号", inq.employee_no + (registered ? `(登録あり: ${registered.name} / ${registered.officeName || "区所未設定"})` : "(登録なし)"));
  infoRow(dl, inq.logged_in ? "名前" : "入力された名前", inq.name);
  infoRow(dl, inq.logged_in ? "所属" : "入力された所属", inq.office_name);
  infoRow(dl, "返事の受け取り方", inq.reply_via === "mail" ? `メール(${inq.email || "アドレスは消去済み"})` : inq.logged_in ? "画面(これまでのお問い合わせ)" : "画面(受付番号+確認コード)");
  infoRow(dl, "受付", `${at(inq.created_at)} ・ Discord: ${{ sent: "通知済み", failed: "通知できませんでした", skipped: "未設定", pending: "通知中" }[inq.discord_status] || inq.discord_status}`);
  if (inq.image_count) {
    const dd = el("dd");
    dd.append(`${inq.image_count}枚(Discord の通知と、Gmail の受付メールで見られます) `);
    dd.appendChild(gmailLink("Gmailで受付メールを開く", inq.receipt_message_id ? "all/" + inq.receipt_message_id : "search/" + encodeURIComponent(`"${no(inq.id)}" 受付`)));
    if (inq.receipt_status === "failed" || inq.receipt_status === "unknown" || inq.receipt_status === "skipped") {
      dd.appendChild(el("span", "warn-text", "(Gmail に控えを送れていません)"));
    }
    dl.append(el("dt", null, "画像"), dd);
  }
  box.appendChild(dl);

  const thread = el("div", "thread");
  messages.forEach((m) => thread.appendChild(messageBubble(m, inq)));
  box.appendChild(thread);
  box.appendChild(replyForm(inq, messages, replyTo));
}

function replyForm(inq, messages, replyTo) {
  const form = el("div", "reply-form");
  const draft = drafts.get(inq.id) || { text: "", via: null, key: newRequestKey() };
  drafts.set(inq.id, draft);
  form.appendChild(el("label", null, "返事"));
  const ta = el("textarea");
  ta.rows = 5;
  ta.maxLength = MAX_REPLY;
  ta.value = draft.text;
  ta.addEventListener("input", () => (draft.text = ta.value));
  form.appendChild(ta);

  const canMail = !!replyTo && config.relay;
  const via = el("div", "row");
  const mk = (value, label, disabled) => {
    const l = el("label", "check inline");
    const r = el("input");
    r.type = "radio";
    r.name = "reply-via-admin";
    r.value = value;
    r.disabled = disabled;
    l.append(r, document.createTextNode(" " + label));
    return [l, r];
  };
  const [mailLabel, mailRadio] = mk("mail", canMail ? `メールで送る(${replyTo})` : "メールで送る(送り先なし・GAS 未設定)", !canMail);
  const [screenLabel, screenRadio] = mk("screen", inq.logged_in ? "画面だけ(本人の「これまでのお問い合わせ」に出る)" : "画面だけ(受付番号+確認コードで見られる)", false);
  // 初期選択は、本人が選んだ受け取り方(メールで受け取る人だけ「メールで送る」)。受信メールがあるだけでは選ばない(D)
  const preferMail = canMail && (draft.via ? draft.via === "mail" : inq.reply_via === "mail");
  (preferMail ? mailRadio : screenRadio).checked = true;
  [mailRadio, screenRadio].forEach((r) => r.addEventListener("change", () => (draft.via = r.value)));
  via.append(mailLabel, screenLabel);
  form.appendChild(via);
  if (!inq.logged_in && inq.reply_via === "mail") {
    form.appendChild(el("p", "muted small", "この人はメールを選んだので、「画面だけ」の返事は本人には見えません。"));
  }
  form.appendChild(el("p", "muted small", `メールの送信元: shiftflow 勤務登録 <${CONTACT_EMAIL}>(相手のメールがあれば、それに返信します)`));

  const actions = el("div", "row");
  const send = btn("返事を送る", async () => {
    const text = ta.value.trim();
    if (!text) return setMessage("contact-detail-message", "返事を入力してください。", "error");
    const viaValue = mailRadio.checked ? "mail" : "screen";
    // ログイン前(本人か未確認)の問い合わせに、4桁の数字(仮のPINなど)を書いていないか(M12)
    if (!inq.logged_in && /(^|[^\d０-９])[\d０-９]{4}([^\d０-９]|$)/.test(text) &&
      !confirm("ログイン前の問い合わせ(本人か確かめられていません)に、4桁の数字が入っています。仮のPINなら、返事には書かず直接伝えてください。このまま送りますか？")) {
      return;
    }
    send.disabled = true;
    setMessage("contact-detail-message", viaValue === "mail" ? "メールを送っています…" : "保存しています…");
    try {
      const res = await callFunction("admin-contact", { action: "reply", id: inq.id, body: text, via: viaValue, request_key: draft.key },
        { timeoutMs: MAIL_TIMEOUT_MS });
      drafts.delete(inq.id);
      const status = res.message && res.message.mail_status;
      await openDetail(inq.id, { quiet: true });
      if (res.duplicate && res.message && res.message.body !== text) {
        // 前の送信(時間切れなどで結果が分からなかったもの)が届いていた。直した文は送っていない(Q6)
        setMessage("contact-detail-message", "前に送った返事がもう届いていました。そのあとで直した文は送っていません。必要なら、もう一度書いて送ってください。", "error");
        return;
      }
      setMessage("contact-detail-message",
        status === "failed" || status === "unknown" ? "返事は保存しましたが、メールは送れませんでした。下の表示を確認してください(要対応のまま残します)。" : "返事を送りました。",
        status === "failed" || status === "unknown" ? "error" : "ok");
    } catch (err) {
      setMessage("contact-detail-message", err.message || String(err), "error");
      send.disabled = false;
    }
  }, "primary");
  actions.appendChild(send);
  const nextStatus = inq.status === "done" ? "open" : "done";
  actions.appendChild(btn(nextStatus === "done" ? "対応済みにする" : "要対応に戻す", async (ev) => {
    ev.target.disabled = true;
    try {
      await callFunction("admin-contact", { action: "status", id: inq.id, status: nextStatus });
      await openDetail(inq.id, { quiet: true });
      setMessage("contact-detail-message", nextStatus === "done" ? "対応済みにしました。" : "要対応に戻しました。", "ok");
      await loadList();
    } catch (err) {
      setMessage("contact-detail-message", err.message || String(err), "error");
      ev.target.disabled = false;
    }
  }));
  const threadId = [...messages].reverse().find((m) => m.gmail_thread_id)?.gmail_thread_id;
  if (threadId) actions.appendChild(gmailLink("Gmailで開く", "all/" + threadId));
  form.appendChild(actions);
  return form;
}

// ---------- 受信メール(どの問い合わせにも当てはまらないもの) ----------

function renderUnmatched(mails) {
  const box = $("contact-list");
  box.innerHTML = "";
  selectedId = null;
  $("contact-detail").innerHTML = "";
  $("contact-detail").appendChild(el("p", "muted", "どの問い合わせにも当てはまらない、専用 Gmail に届いたメールです(新しい順・90日で消えます)。"));
  if (!mails.length) {
    box.appendChild(el("p", "muted", "ありません。"));
    return;
  }
  mails.forEach((m) => {
    const card = el("div", "unmatched");
    card.appendChild(messageBubble(m, null));
    if (m.sender === "mail" && !m.bounce && m.gmail_message_id && m.from_email && config.relay) {
      const key = newRequestKey();
      const ta = el("textarea");
      ta.rows = 3;
      ta.maxLength = MAX_REPLY;
      ta.placeholder = "このメールに返信する";
      const send = btn("返信する", async () => {
        if (!ta.value.trim()) return;
        send.disabled = true;
        try {
          const text = ta.value.trim();
          const res = await callFunction("admin-contact", { action: "reply-unmatched", message_id: m.id, body: text, request_key: key },
            { timeoutMs: MAIL_TIMEOUT_MS });
          const status = res.message && res.message.mail_status;
          await loadList({ quiet: true });
          if (res.duplicate && res.message && res.message.body !== text) {
            setMessage("contact-list-message", "前に送った返信がもう届いていました。そのあとで直した文は送っていません。", "error");
            return;
          }
          setMessage("contact-list-message", status === "sent" ? "返信しました。" : "返信を送れませんでした。もう一度読み直して確認してください。", status === "sent" ? "ok" : "error");
        } catch (err) {
          setMessage("contact-list-message", err.message || String(err), "error");
          send.disabled = false;
        }
      });
      card.append(ta, send);
    }
    box.appendChild(card);
  });
}

// ---------- はじめ ----------

export function initContactAdmin() {
  document.querySelectorAll(".chip[data-filter]").forEach((chip) => {
    chip.addEventListener("click", () => {
      filter = chip.dataset.filter;
      document.querySelectorAll(".chip[data-filter]").forEach((c) => c.classList.toggle("active", c === chip));
      $("contact-list").innerHTML = "";
      loadList();
    });
  });
  $("contact-reload").addEventListener("click", () => {
    loadList();
    if (selectedId) openDetail(selectedId);
  });
  document.querySelector('.dtab[data-tab="contact"]').addEventListener("click", () => loadList());
  loadList(); // 件数(タブの赤い数字・概要の注意)のため、最初にも読む
}
