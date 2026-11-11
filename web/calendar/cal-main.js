// shiftflowカレンダー(アプリ内のカレンダー)。設計は docs/mycalendar/DESIGN.md。
// 勤務の予定は、勤務の記録から Edge Function(calendar-shifts)が、勤務入力の設定どおりに組み立てて返す(Google には何も書かない・読まない)。
// 自分で作る予定・ラベルは、Supabase の cal_* の表(本人の行だけ・RLS)。
import {
  callFunction, currentSession, fetchContactReplyAt, fetchNotices, friendlyText, go, hasUnseenReply, loadProfile, loadSettings, selectAllPages, supabase, toHalfWidth, unseenNotices,
} from "../js/app.js?v=dev";
import { createExtras, shrinkForEvent } from "./cal-extra.js?v=dev";
import { createImager } from "./cal-image.js?v=dev";
import { createAnnouncer } from "./cal-ann.js?v=dev";
import * as appIcon from "./cal-icon.js?v=dev";
import { fetchShare, fetchShareInboxCount, kindText, mdText, receivedAction, receivedHtml, scopeSeg, scopeText, SCOPES, SHARE_MAX, shareRpc } from "../js/share.js?v=dev";
import {
  addDays, addMonths, announceItems, ANNOUNCE_MAX, compareForDay, dateKey, datesText, daysInMonth, diffDays, expandEvent, resolveCalView, gridRange, layoutWeek, monthIndex, monthLimits, oldestDate, photosClosed, textOn, todayJst, weekday, whenText, WEEKDAYS,
  shiftSpan, yearsText,
} from "./cal-core.js?v=dev";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const HIDDEN_KEY = "shiftflow-cal-hidden";
const STAMPS_OFF_KEY = "shiftflow-cal-stamps-off"; // スタンプを全部隠す(この端末だけ。ラベルの表示と同じ)
const THEME_KEY = "shiftflow-cal-theme";
appIcon.applySaved(); // 前に選んだホーム画面のアイコンを、アイコンの指定に反映する(「ホーム画面に追加」の前に済ませておく)
const FALLBACK = { duty: "#3b6fd4", off: "#e0553f", custom: "#6b7280" };
const REPEAT = { none: "なし", daily: "毎日", weekly: "毎週", monthly: "毎月", yearly: "毎年" };

const S = {
  labels: [],          // cal_labels(並び順)
  own: [],             // cal_events(自分で作る予定。画面用に整えたもの)
  shifts: new Map(),   // "年-月" → { events, loadedAt }(勤務の予定。月の画面の範囲ぶん)
  holidays: new Map(), // 日付 → 祝日の名前
  hidden: new Set(),   // 隠すラベルの id
  stampsOff: false,    // スタンプを全部隠す(曜日の上の「スタンプ」のチップ。月の画像にも入れない)
  y: 0, m: 0,
  today: todayJst(),
  needOffice: false,
  cfg: { duty: true, off: true, offduty: false }, // カレンダーに出すもの(勤務・休日・非番を別のボタンに)
  settingsRow: null,   // user_settings の行(出すものの設定を保存するため)
  notice: "",          // 直前の失敗・お知らせ(HTML。esc 済み)
  byUid: new Map(),    // 今の画面の予定(uid → 予定)
  photos: new Map(),   // 予定の id → 写真の行(cal_photos)
  panel: null,         // 開いているパネル
  todos: [], importants: [], gallery: [], stampDefs: [], stamps: [], // 後の段階の表(cal-extra.js)
  templates: [],       // 予定のテンプレート(cal_templates)
  dots: { notices: false, contact: false }, // まだ見ていないお知らせ・お問い合わせの返事(設定の赤い点)
  share: { links: [], views: [], sent: [], received: [] }, // カレンダーの共有(docs/share/DESIGN.md。cal_share_list)
};
let extras = null;
let imager = null; // 月の画像・〇つきの画像(cal-image.js)
let announcer = null; // アナウンスの行(cal-ann.js)

// ---------- 小さな道具 ----------

function storageGet(key) { try { return window.localStorage.getItem(key); } catch (_) { return null; } }
function storageSet(key, value) { try { window.localStorage.setItem(key, value); } catch (_) { /* 保存できない端末では、毎回初期値に戻るだけ */ } }

// 画面の上の案内。区所の案内(needOffice)と、直前の失敗・お知らせ(notice)は別に持つ。
// 描き直し(render)で notice が消えないように、notice は次の月の移動・読み直しの始めまで残す(M3)
function showBanner() {
  const parts = [];
  if (S.needOffice) parts.push('勤務の予定を出すには、<a href="../settings.html">設定</a>で区所を選んでください。');
  if (S.notice) parts.push(`${S.notice} <button class="bx" data-act="dismiss-notice" aria-label="この案内を閉じる">✕</button>`);
  const b = $("banner");
  b.hidden = !parts.length;
  b.innerHTML = parts.join("<br>");
}
function setNotice(html) { S.notice = html || ""; showBanner(); }
function fail(err) { setNotice(esc(friendlyText(err && err.message ? err.message : String(err)))); }

// 夫婦の共有(docs/share/DESIGN.md の 2・5章)。夫婦なら { partner, name, owner(自分が持ち主か), theirScope, linkId }
function couple() {
  const l = S.share.links.find((x) => x.kind === "couple");
  return l ? { partner: l.partner_id, name: l.partner_name, owner: !!l.inviter, theirScope: l.their_scope, linkId: l.id } : null;
}
// 勤務・休日・非番のラベルが、誰の勤務のものか(夫婦のカレンダーでは、相手のものは member_id、持ち主のものは user_id)
const shiftOwnerOf = (l) => l.member_id || l.user_id;
const isMine = (l) => !l.user_id || shiftOwnerOf(l) === S.userId; // user_id が無い(古い・テストの偽物)ときは自分のもの

// カレンダーに出すもの(設定の「このカレンダーに出すもの」。自動のときは Google の設定から決める)。
// 出さないものは、ラベルのボタンも予定も出さない。非番は、チェックが無ければ勤務に含めて出す。
// 夫婦の相手の勤務・休日・非番のラベルは、相手が見せている範囲で出す(非番は、自分の「非番を別のボタン」に合わせる)
const labelShown = (l) => {
  if (l.kind === "custom") return true;
  if (!isMine(l)) {
    const c = couple();
    if (!c || c.partner !== shiftOwnerOf(l) || c.theirScope === "none") return false;
    return l.kind === "duty" ? true : l.kind === "off" ? c.theirScope === "duty_off" : S.cfg.offduty;
  }
  return l.kind === "duty" ? S.cfg.duty : l.kind === "off" ? S.cfg.off : l.kind === "offduty" ? S.cfg.offduty : true;
};
const visibleLabels = () => S.labels.filter(labelShown);
const groupShown = (g) => g === "off" ? S.cfg.off : g === "offduty" ? (S.cfg.offduty || S.cfg.duty) : S.cfg.duty;
const labelForGroup = (g) => {
  const duty = labelKind("duty");
  if (g === "off") return labelKind("off");
  if (g === "offduty") return S.cfg.offduty ? labelKind("offduty") || duty : duty;
  return duty;
};
// 共有の相手の名前のラベル(仲間)。相手が見せている範囲で、勤務だけなら1つ・勤務と休日なら2つ。
// 名前・色は見る人が決める(cal_share_views)。id は「m:相手のID」「m:相手のID:off」(DB のラベルではない)
function mateLabels() {
  const out = [];
  for (const v of S.share.views) {
    const link = S.share.links.find((l) => l.partner_id === v.owner_id);
    if (!link || link.their_scope === "none" || link.kind === "couple") continue;
    out.push({ id: `m:${v.owner_id}`, kind: "mate", owner: v.owner_id, name: v.name, color: v.color });
    if (link.their_scope === "duty_off") out.push({ id: `m:${v.owner_id}:off`, kind: "mateoff", owner: v.owner_id, name: v.off_name, color: v.off_color });
  }
  return out;
}
const mateLabelId = (owner, group) => (group === "off" ? `m:${owner}:off` : `m:${owner}`);
const labelOf = (id) => S.labels.find((l) => l.id === id) || (String(id).startsWith("m:") ? mateLabels().find((l) => l.id === id) : undefined);
const labelKind = (kind, owner = S.userId) => S.labels.find((l) => l.kind === kind && (owner === S.userId ? isMine(l) : shiftOwnerOf(l) === owner));
const colorOf = (id) => (labelOf(id) || {}).color || FALLBACK.custom;
// 並びは、自分のラベル → 共有の相手の名前のラベル
const rankOf = (id) => {
  const i = S.labels.findIndex((l) => l.id === id);
  if (i >= 0) return i;
  const j = String(id).startsWith("m:") ? mateLabels().findIndex((l) => l.id === id) : -1;
  return j < 0 ? 99 : 60 + j;
};
const givenOf = (full) => String(full || "").trim().split(/\s+/).pop();
const partnerName = (owner) => (S.share.links.find((l) => l.partner_id === owner) || {}).partner_name || "";

function applyTheme() {
  const t = storageGet(THEME_KEY);
  if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
  else document.documentElement.removeAttribute("data-theme");
}

// ---------- データの読み込み ----------

function rowToOwn(r) {
  return {
    src: "own", id: r.id, title: r.title, start: r.start_date, end: r.end_date, allDay: r.all_day,
    startTime: r.start_time || "", endTime: r.end_time || "", labelId: r.label_id, memo: r.memo || "",
    repeat: r.repeat_rule, until: r.repeat_until || "", exdates: r.exdates || [], yearsLabel: r.years_label || "", version: r.version,
    announce: r.announce || "none", createdBy: r.created_by || "",
  };
}

async function loadLabels() {
  const read = async () => {
    const { data, error } = await supabase.from("cal_labels").select("*").order("sort").order("created_at");
    if (error) throw error;
    return data || [];
  };
  let rows = await read();
  // 勤務・休日・非番のラベルが足りなければ作る(今までの利用者には、非番だけが足される)
  if (!rows.length || ["duty", "off", "offduty"].some((k) => !rows.some((r) => r.kind === k && isMine(r)))) {
    const { error } = await supabase.rpc("cal_ensure_default_labels");
    if (error) throw error;
    rows = await read();
  }
  S.labels = rows;
}

// カレンダーの共有の一覧。読めなくても、カレンダーは動かす(名前のラベルは前のまま)
async function loadShare() {
  try { S.share = await fetchShare(); } catch (_) { /* 前のまま */ }
  S.galleryMax = couple() ? 20 : 10; // 夫婦のカレンダーは画像20枚
}

async function loadTemplates() {
  const { data, error } = await supabase.from("cal_templates").select("*").order("sort").order("created_at");
  if (error) throw error;
  S.templates = data || [];
}

async function loadOwn() {
  const rows = await selectAllPages((from, to) => supabase.from("cal_events").select("*").order("start_date").order("id").range(from, to));
  S.own = rows.map(rowToOwn);
}

// 予定の写真の一覧。期限(予定の終了日から1か月)を過ぎたものは、ファイルを消してから行を消す(開いたときに、持ち主が片付ける)
async function loadPhotos() {
  const rows = await selectAllPages((from, to) => supabase.from("cal_photos").select("*").order("created_at").order("id").range(from, to));
  S.photos = new Map();
  for (const r of rows) { if (!S.photos.has(r.event_id)) S.photos.set(r.event_id, []); S.photos.get(r.event_id).push(r); }
  const expired = rows.filter((r) => r.expires_on && r.expires_on < S.today);
  if (!expired.length) return;
  if (!(await extras.removeFiles(expired.map((r) => r.path)))) return; // ファイルを消せなかったら、行は残して次に開いたときにやり直す
  const { error } = await supabase.from("cal_photos").delete().in("id", expired.map((r) => r.id));
  if (error) return;
  const gone = new Set(expired.map((r) => r.id));
  for (const [k, list] of S.photos) { const rest = list.filter((r) => !gone.has(r.id)); if (rest.length) S.photos.set(k, rest); else S.photos.delete(k); }
}

// 勤務の予定。続いている月は、1回の通信でまとめて読む(月ごとに読むと、通信の数だけ待たされる)。
// months: 続いている月の並び({y, m}。3か月まで。サーバーが読める範囲は、月の画面の前後の週を含めて5か月まで)
async function loadShiftsRange(months) {
  const first = months[0], last = months[months.length - 1];
  // mates: 共有で勤務を見せてくれている人の勤務も、一緒に返してもらう(docs/share/DESIGN.md)
  const res = await callFunction("calendar-shifts", { from: gridRange(first.y, first.m).from, to: gridRange(last.y, last.m).to, mates: true }, { timeoutMs: 40000 });
  for (const h of res.holidays || []) S.holidays.set(h.date, h.name);
  S.needOffice = !!res.needOffice;
  // どのラベルになるかは、画面に出すとき(eventsBetween)に決める(設定を変えても、読み直さなくてよいように)。
  // server の group が無いとき(古い版)は、休日かそれ以外かだけ
  const events = (res.shifts || []).map((e, i) => ({
    src: "shift", id: `s:${first.y}-${first.m}:${e.date}:${i}`, title: e.title, start: e.date, end: e.endDate, allDay: e.allDay,
    startTime: e.startTime, endTime: e.endTime, kind: e.kind || "", group: e.group || (e.calendar === "holiday" ? "off" : "duty"), memo: e.description || "", repeat: "none",
  }));
  // 共有の相手の勤務(見るだけ)。group は duty か off(非番はサーバーで勤務に入れてある)
  for (const m of res.mates || []) {
    (m.shifts || []).forEach((e, i) => events.push({
      src: "mate", owner: m.ownerId, id: `m:${m.ownerId}:${first.y}-${first.m}:${e.date}:${i}`, title: e.title, start: e.date, end: e.endDate, allDay: e.allDay,
      startTime: e.startTime, endTime: e.endTime, kind: e.kind || "", group: e.group === "off" ? "off" : "duty", memo: e.description || "", repeat: "none",
    }));
  }
  // 予定は最初の月に入れ、あとの月は「読んだ」印だけ(同じ予定を何度も数えないように)
  months.forEach((t, i) => S.shifts.set(`${t.y}-${t.m}`, { events: i === 0 ? events : [] }));
}

async function reloadAll({ keepShifts = false } = {}) {
  // 勤務の予定は、新しく読めてから入れ替える(読めなかったときに、今の予定を空にしてしまわないように)
  const oldShifts = S.shifts;
  if (!keepShifts) S.shifts = new Map();
  try {
    // 設定で非番の時間用カレンダーを足した・外したあとに、反映する(読めなければ、今のまま)
    try { const st = await loadSettings(S.session); S.settingsRow = st; S.cfg = resolveCalView(st); } catch (_) { /* 今のまま */ }
    await Promise.all([loadLabels(), loadOwn(), extras.load(), loadTemplates(), loadShare()]);
    await loadPhotos().catch(() => {});
    await ensureAround();
  } catch (e) {
    S.shifts = oldShifts;
    throw e;
  }
  S.notice = ""; // 読み直しが成功したので、前の失敗の案内は消す(残ったままにならないように)
  render();
}

// 画像を作る月の勤務の予定を、まだ読んでいなければ読む(見ている月から離れた月の画像のため)
async function ensureMonthLoaded(y, m) {
  if (S.shifts.has(`${y}-${m}`)) return;
  await loadShiftsRange([{ y, m }]);
}

// 今の月の前後2か月ぶんの勤務の予定を読む(まだ読んでいない月だけ)。続いている月は、1回の通信でまとめて読む。読めたら true
const loadingMonths = new Set();
async function ensureAround() {
  const lim = monthLimits(S.today);
  const lo = monthIndex(lim.min.y, lim.min.m), hi = monthIndex(lim.max.y, lim.max.m);
  const need = [];
  for (let k = -2; k <= 2; k++) {
    const t = addMonths(S.y, S.m, k);
    const idx = monthIndex(t.y, t.m);
    if (idx < lo || idx > hi || S.shifts.has(`${t.y}-${t.m}`) || loadingMonths.has(`${t.y}-${t.m}`)) continue;
    need.push(t);
  }
  // 続いている月ごとにまとめる(1回に3か月まで)
  const runs = [];
  for (const t of need) {
    const run = runs[runs.length - 1];
    if (run && run.length < 3 && monthIndex(t.y, t.m) === monthIndex(run[run.length - 1].y, run[run.length - 1].m) + 1) run.push(t); else runs.push([t]);
  }
  const jobs = runs.map((run) => {
    const keys = run.map((t) => `${t.y}-${t.m}`);
    keys.forEach((k) => loadingMonths.add(k));
    return loadShiftsRange(run).finally(() => keys.forEach((k) => loadingMonths.delete(k)));
  });
  const results = await Promise.allSettled(jobs);
  const failed = results.find((r) => r.status === "rejected");
  if (failed) throw failed.reason;
  return results.length > 0;
}

// ---------- 画面に出す予定 ----------

function eventsBetween(a, b) {
  const out = [];
  for (const e of S.own) for (const o of expandEvent(e, a, b)) out.push({ ...o, baseStart: e.start });
  const seen = new Set();
  for (const { events } of S.shifts.values()) {
    for (const e of events) {
      if (e.end < a || e.start > b) continue;
      let labelId;
      if (e.src === "mate" && couple() && couple().partner === e.owner) {
        // 夫婦の相手の勤務は、カレンダーの名前のラベル(2人で同じ)。非番は、自分の「非番を別のボタン」に合わせる
        const duty = labelKind("duty", e.owner);
        const l = e.group === "off" ? labelKind("off", e.owner) : e.group === "offduty" && S.cfg.offduty ? labelKind("offduty", e.owner) || duty : duty;
        if (!l || !labelShown(l)) continue;
        labelId = l.id;
      } else if (e.src === "mate") {
        // 相手が範囲を狭めた(休日を見せなくなった・見せなくなった)ときは、ラベルが無いので出さない
        labelId = mateLabelId(e.owner, e.group);
        if (!labelOf(labelId)) continue;
      } else {
        if (!groupShown(e.group)) continue;
        const label = labelForGroup(e.group);
        labelId = label ? label.id : "";
      }
      const k = `${e.start}|${e.end}|${e.title}|${e.startTime}|${labelId}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ ...e, labelId });
    }
  }
  return out
    .filter((e) => !S.hidden.has(e.labelId))
    .map((e) => ({ ...e, labelRank: rankOf(e.labelId) }));
}

const titleOf = (e) => e.title + (yearsText(e) ? ` ${yearsText(e)}` : "");
// 帯の文字は、名前だけ。自分の時間つきの予定にも、開始時刻は添えない(2026-11-08 の要望。時刻は、タップした詳細と日の一覧に出る)。
// 勤務の予定(時間つきの設定でも番号だけ)と「時間」の帯(名前が時間そのもの)も、今までどおり名前だけ。画像にする(cal-image.js)ときも同じ文字
const barText = (e) => titleOf(e);

// ---------- 描画: 月の画面 ----------

// スタンプを全部隠す・出す(この端末に覚える)
function setStampsOff(on) {
  S.stampsOff = on;
  storageSet(STAMPS_OFF_KEY, on ? "1" : "");
}

function renderChips() {
  const el = $("chips");
  el.innerHTML = [...visibleLabels(), ...mateLabels()].map((l) =>
    `<button class="chip${S.hidden.has(l.id) ? " off" : ""}" data-chip="${esc(l.id)}" style="--c:${esc(l.color)}" aria-pressed="${S.hidden.has(l.id) ? "false" : "true"}"><i></i>${esc(l.name)}</button>`).join("") +
    // スタンプを作っている人だけ、最後に「スタンプ」(全部を一度に出す・隠す)
    (S.stampDefs.length ? `<button class="chip stchip${S.stampsOff ? " off" : ""}" data-chip-stamps="1" aria-pressed="${S.stampsOff ? "false" : "true"}"><i aria-hidden="true">★</i>スタンプ</button>` : "");
}

// ---------- 月の画面(週が途切れず、縦に続く) ----------

const rowHeight = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--rh")) || 84;
// 見られる範囲(12か月前の月の最初の週 〜 来年12月の最後の週)
function listRange() {
  const l = monthLimits(S.today);
  return { from: gridRange(l.min.y, l.min.m).from, to: gridRange(l.max.y, l.max.m).to };
}

function updateHeader() {
  $("ty").textContent = `${S.y}`;
  $("tm").textContent = `${S.m}月`;
  $("today-d").textContent = String(Number(S.today.slice(8, 10)));
  const lim = monthLimits(S.today);
  $("prev").disabled = monthIndex(S.y, S.m) <= monthIndex(lim.min.y, lim.min.m);
  $("next").disabled = monthIndex(S.y, S.m) >= monthIndex(lim.max.y, lim.max.m);
}

// 描き直す。スクロールの位置は変えない(週の高さは一定なので、同じ週が同じ場所に来る)
function render() {
  const r = listRange();
  updateHeader();
  renderChips();
  showBanner();
  const events = eventsBetween(r.from, r.to);
  S.byUid = new Map(events.map((e) => [e.id, e]));
  const weeks = [];
  for (let ws = r.from; ws <= r.to; ws = addDays(ws, 7)) weeks.push(ws);
  // 帯を並べられる段の数(週の高さ − 帯の始まり)÷(帯の高さ+すきま)。家族カレンダーと同じ数値
  const cv = (n, d) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(n)) || d;
  const maxLanes = Math.max(1, Math.floor((rowHeight() - cv("--bart", 17)) / (cv("--bar", 12) + cv("--bgap", 1.5))));
  const cal = $("cal");
  const keep = cal.scrollTop;
  $("weeks").innerHTML = weeks.map((ws) => weekHtml(ws, events, maxLanes)).join("");
  cal.scrollTop = keep;
  extras.hydrate($("weeks"));
  extras.fitStamps(); // 横に長い文字のスタンプが、左右の端で切れないように(AN1・AN2)
  refreshAnn();
}

// 日付の週を、上から rowsAbove 段目に置く
function scrollToDate(d, rowsAbove = 0, smooth = false) {
  const r = listRange();
  const ws = addDays(d, -weekday(d));
  const idx = Math.round(diffDays(r.from, ws) / 7);
  $("cal").scrollTo({ top: Math.max(0, (idx - rowsAbove) * rowHeight()), behavior: smooth ? "smooth" : "auto" });
}
// 今、見ている月(画面の上から1週ちょっと下の週の、まん中の日の月)
function visibleMonth() {
  const cal = $("cal");
  // いちばん下まで来たら、最後の月(それより先へは進めないので、上の週の月のままにならないように)
  if (cal.scrollTop + cal.clientHeight >= cal.scrollHeight - 2) { const l = monthLimits(S.today).max; return { y: l.y, m: l.m }; }
  const rh = rowHeight();
  const idx = Math.max(0, Math.floor(($("cal").scrollTop + rh * 1.2) / rh));
  const d = addDays(listRange().from, idx * 7 + 3);
  return { y: Number(d.slice(0, 4)), m: Number(d.slice(5, 7)) };
}

function weekHtml(ws, events, maxLanes) {
  const { bars, over } = layoutWeek(ws, events, maxLanes);
  let cells = "";
  for (let c = 0; c < 7; c++) {
    const d = addDays(ws, c);
    const hol = S.holidays.get(d);
    const cls = ["cell", c === 0 ? "sun" : c === 6 ? "sat" : "", hol ? "hol" : "", d === S.today ? "tdy" : "", Number(d.slice(5, 7)) % 2 === 0 ? "alt" : "", imager && imager.isMarked(d) ? "mk" : ""].filter(Boolean).join(" ");
    const wd = WEEKDAYS[c];
    // 日付の横に祝日の名前(赤い小さな字)。例: 「3 文化の日」
    cells += `<div class="${cls}" data-date="${d}" role="button" tabindex="0" aria-label="${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日(${wd})${hol ? " " + esc(hol) : ""}"><span class="dtop"><span class="dn">${Number(d.slice(8, 10))}</span>${hol ? `<span class="hn">${esc(hol)}</span>` : ""}</span>${over[c] ? `<span class="more">+${over[c]}</span>` : ""}</div>`;
  }
  const barHtml = bars.map((b) => {
    const e = b.event;
    const col = colorOf(e.labelId);
    const cls = ["bar", b.cutLeft ? "cl" : "", b.cutRight ? "cr" : ""].filter(Boolean).join(" ");
    const text = barText(e);
    return `<button class="${cls}" data-uid="${esc(e.id)}" style="grid-column:${b.c1 + 1}/${b.c2 + 2};grid-row:${b.lane + 1};--c:${esc(col)};--t:${textOn(col)}">${esc(text)}</button>`;
  }).join("");
  const dates = [0, 1, 2, 3, 4, 5, 6].map((c) => addDays(ws, c));
  // 月の数字(その月の12日がある週の背景に、大きくうすく)
  const d12 = dates.find((d) => d.slice(8, 10) === "12");
  const wm = d12 ? `<div class="wmk" aria-hidden="true">${Number(d12.slice(5, 7))}</div>` : "";
  return `<div class="week" data-ws="${ws}"><div class="cells">${cells}</div>${wm}<div class="bars">${barHtml}</div>${extras.stampsLayer(dates)}</div>`;
}

// ---------- パネル(日の詳細・予定・追加と編集・設定) ----------

// 戻るボタン(Android など)で、開いているパネル・大きな画像を閉じる(アプリごと閉じてしまわないように)。
// 開くたびに履歴を1つ足し、画面の ✕ などで閉じるときは1つ戻す(そのとき起きる popstate は ignorePops で読み飛ばす)
const layers = [];
let ignorePops = 0;
function pushLayer(close) { layers.push({ close }); try { history.pushState({ calLayer: layers.length }, ""); } catch (_) { /* 履歴を足せなくても動く */ } }
function dropLayer() { if (layers.pop()) { ignorePops++; try { history.back(); } catch (_) { ignorePops--; } } }
window.addEventListener("popstate", () => {
  if (ignorePops > 0) { ignorePops--; return; }
  const l = layers.pop();
  if (l) l.close(); // 戻るボタン: いちばん上の層を閉じる(履歴はもう戻っている)
});

let scrimDown = false; // 暗い背景を「押し始めた」か(押し始めた click だけで閉じる)
function showPanel(onClose) {
  if (S.panel) { if (onClose !== undefined) S.panel.onClose = onClose; return; }
  $("panel").hidden = false;
  $("scrim").hidden = false;
  scrimDown = false; // 開く前から続いている押し込みは、背景を閉じる操作にしない
  S.panel = { onClose };
  pushLayer(hidePanel);
}
function hidePanel() {
  clearSheetDrag();
  closeViewerView();
  $("panel").hidden = true;
  $("scrim").hidden = true;
  $("panel").innerHTML = "";
  const cb = S.panel && S.panel.onClose;
  S.panel = null;
  if (cb) cb();
}
function openPanel(html, { onClose } = {}) {
  const p = $("panel");
  p.innerHTML = html;
  showPanel(onClose);
  p.scrollTop = 0;
}
// 開いたまま中身だけ入れ替える(スクロールの位置は変えない)
function setPanel(html) { $("panel").innerHTML = html; }
function closePanel() {
  if (!S.panel) return;
  if (!$("viewer").hidden) dropLayer(); // 大きな画像が開いていれば、先に閉じる
  hidePanel();
  dropLayer();
}

// 下から出るポップアップ(スマホの幅)を、指で下に引いて閉じる。閉じた結果は「✕」と同じ(書きかけは保存しない)。
// 引けるのは、上のつまみ・見出しからと、中身がいちばん上までスクロールしているときに下へ引いたとき。
// 入力欄・メモ・スライダー・選ぶ欄の上から始めた指は、閉じる操作にしない(文字を選ぶ・値を動かす邪魔をしないため)。
// 広い画面(幅700px以上。右に出る形)では使わない
const SHEET_CLOSE_PX = 100, SHEET_FLICK = 0.5; // 100px 以上引くか、速く(0.5px/ms 以上)はじいたら閉じる
function clearSheetDrag() {
  const p = $("panel"), sc = $("scrim");
  p.style.transition = ""; p.style.transform = "";
  sc.style.transition = ""; sc.style.opacity = "";
}
function bindSheetSwipe() {
  const p = $("panel"), sc = $("scrim");
  const isSheet = () => !window.matchMedia("(min-width: 700px)").matches;
  const NO_DRAG = "input, textarea, select, [contenteditable], .noswipe";
  let g = null;
  p.addEventListener("touchstart", (ev) => {
    g = null;
    if (!S.panel || !isSheet() || ev.touches.length !== 1 || ev.target.closest(NO_DRAG)) return;
    const t = ev.touches[0];
    g = { x: t.clientX, y: t.clientY, y0: 0, head: !!ev.target.closest(".ph"), on: false, dy: 0, pts: [] };
  }, { passive: true });
  p.addEventListener("touchmove", (ev) => {
    if (!g) return;
    if (ev.touches.length !== 1) { g = null; clearSheetDrag(); return; }
    const t = ev.touches[0];
    const dx = t.clientX - g.x, dy = t.clientY - g.y;
    const atTop = g.head || p.scrollTop <= 0;
    if (!g.on) {
      // 動きが小さいうちは、まだ決めない。ただ、引ける所から下へ動き始めたら、画面のスクロール(iPhone の引っぱり)を先に止めておく
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) { if (dy > 0 && atTop && ev.cancelable) ev.preventDefault(); return; }
      if (Math.abs(dx) > Math.abs(dy) || dy < 0 || !atTop) { g = null; return; } // 横の動き・上へのスクロール・中身のスクロールは、そのまま
      g.on = true;
      g.y0 = t.clientY;
      p.style.transition = "none"; sc.style.transition = "none";
    }
    if (ev.cancelable) ev.preventDefault();
    g.dy = Math.max(0, t.clientY - g.y0);
    p.style.transform = g.dy ? `translateY(${g.dy}px)` : "";
    sc.style.opacity = String(Math.max(0.15, 1 - g.dy / Math.max(1, p.offsetHeight)));
    const now = Date.now();
    g.pts.push({ y: t.clientY, t: now });
    while (g.pts.length > 2 && now - g.pts[0].t > 100) g.pts.shift(); // 速さは、最後の 0.1秒ほどの動きで見る
  }, { passive: false });
  const end = (cancelled) => {
    const d = g;
    g = null;
    if (!d || !d.on) return;
    const a = d.pts[0], b = d.pts[d.pts.length - 1];
    const v = a && b && b.t > a.t ? (b.y - a.y) / (b.t - a.t) : 0;
    if (!cancelled && (d.dy >= SHEET_CLOSE_PX || (d.dy > 30 && v >= SHEET_FLICK))) {
      p.style.transition = "transform .18s ease-in"; sc.style.transition = "opacity .18s";
      p.style.transform = "translateY(100%)"; sc.style.opacity = "0";
      setTimeout(() => { if (S.panel) closePanel(); clearSheetDrag(); }, 180);
    } else {
      p.style.transition = "transform .2s ease"; sc.style.transition = "opacity .2s";
      p.style.transform = ""; sc.style.opacity = "";
      setTimeout(() => { if (!g) clearSheetDrag(); }, 220);
    }
  };
  p.addEventListener("touchend", () => end(false));
  p.addEventListener("touchcancel", () => end(true));
}

// 大きな画像
function closeViewerView() { $("viewer").hidden = true; }
function openViewer(src, caption) {
  $("viewer-img").src = src;
  $("viewer-cap").textContent = caption || "";
  if ($("viewer").hidden) pushLayer(closeViewerView);
  $("viewer").hidden = false;
}
function closeViewer() { if (!$("viewer").hidden) { closeViewerView(); dropLayer(); } }
const head = (title, extra = "") => `<div class="ph"><h2>${esc(title)}</h2>${extra}<button class="x" data-act="close" aria-label="閉じる">✕</button></div>`;

function dayLabel(d) { return `${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日(${WEEKDAYS[weekday(d)]})`; }

function eventRow(e) {
  const when = e.allDay ? "終日" : `${(e.startTime || "").replace(/^0/, "")}${e.endTime ? "〜" + e.endTime.replace(/^0/, "") : ""}`;
  const label = labelOf(e.labelId);
  const body = e.memo ? `<div class="m">${esc(e.memo)}</div>` : `<div class="m">${esc(when)}${label ? "　" + esc(label.name) : ""}</div>`;
  const time = e.memo && !e.allDay ? `<div class="m">${esc(when)}</div>` : "";
  return `<button class="erow" data-uid="${esc(e.id)}" style="--c:${esc(colorOf(e.labelId))}"><span class="dot"></span><span><div class="t">${esc(titleOf(e))}</div>${time}${body}</span></button>`;
}

function openDay(date) {
  const list = eventsBetween(date, date).sort(compareForDay);
  const hol = S.holidays.get(date);
  openPanel(`${head(dayLabel(date))}<div class="pb">${hol ? `<p class="hname">${esc(hol)}</p>` : ""}${list.length ? list.map(eventRow).join("") : '<p class="sub">予定はありません。</p>'}<div class="btns"><button class="btn pri" data-act="new" data-date="${date}">＋ 予定を追加</button></div></div>`);
}

function repeatText(e) {
  if (!e.repeat || e.repeat === "none") return "";
  return REPEAT[e.repeat] + (e.until ? `(${e.until.replace(/-/g, "/")}まで)` : "");
}

function openEvent(uid) {
  const e = S.byUid.get(uid);
  if (!e) return closePanel();
  const label = labelOf(e.labelId);
  const rep = repeatText(e);
  let actions;
  if (e.src === "mate") {
    actions = `<p class="sub">${esc(partnerName(e.owner) || "共有の相手")}さんの${e.group === "off" ? "休日" : "勤務"}です(共有。見るだけ)。表記は、あなたの勤務入力の設定どおりです。</p>`;
  } else if (e.src === "shift") {
    actions = '<p class="sub">勤務の予定は、勤務入力で直します。</p><div class="btns"><a class="btn" href="../input.html">勤務入力を開く</a></div>';
  } else if (e.repeat && e.repeat !== "none") {
    actions = `<div class="btns"><button class="btn" data-act="edit" data-uid="${esc(uid)}" data-mode="occ">この回だけ編集</button><button class="btn" data-act="edit" data-uid="${esc(uid)}" data-mode="all">全ての回を編集</button></div>
      <div class="btns"><button class="btn dng" data-act="del" data-uid="${esc(uid)}" data-mode="occ">この回だけ削除</button><button class="btn dng" data-act="del" data-uid="${esc(uid)}" data-mode="all">全ての回を削除</button></div>`;
  } else {
    actions = `<div class="btns"><button class="btn" data-act="edit" data-uid="${esc(uid)}" data-mode="all">編集</button><button class="btn dng" data-act="del" data-uid="${esc(uid)}" data-mode="all">削除</button></div>`;
  }
  // 自分の予定は、同じ内容を別の日にコピー・テンプレートにする・アナウンスに出すができる(繰り返しの予定は、この回の内容で)
  const base = e.src === "own" ? S.own.find((x) => x.id === (e.baseId || e.id)) : null;
  const annOn = !!base && !!base.announce && base.announce !== "none";
  if (e.src === "own") {
    actions = `<div class="btns"><button class="btn" data-act="copy" data-uid="${esc(uid)}">別の日にコピー</button><button class="btn" data-act="tp-from" data-uid="${esc(uid)}">この予定をテンプレートにする</button></div>
      <div class="btns"><button class="btn" data-act="ann-toggle" data-uid="${esc(uid)}">${annOn ? "アナウンスに出すのをやめる" : "アナウンスに出す"}</button></div>` + actions;
  }
  const annNote = annOn ? `<p class="sub">アナウンス: ${base.announce === "plain" ? "日付なし(予定の名前だけ)" : "日付あり(あと何日かを出す)"}</p>` : "";
  // 夫婦のカレンダー: 相手が足した予定には「花子が追加」
  const c = couple();
  const byNote = c && base && base.createdBy && base.createdBy !== S.userId ? `<p class="sub">${esc(givenOf(c.name))}が追加</p>` : "";
  openPanel(`${head(e.title || "（タイトルなし）")}<div class="pb">
    <p class="sub">${esc(whenText(e))}</p>
    ${label ? `<p><span class="chip" style="--c:${esc(colorOf(e.labelId))}"><i></i>${esc(label.name)}</span></p>` : ""}
    ${rep ? `<p class="sub">繰り返し: ${esc(rep)}</p>` : ""}${yearsText(e) ? `<p class="sub">${esc(yearsText(e))}</p>` : ""}${annNote}${byNote}
    ${e.memo ? `<p style="white-space:pre-wrap;word-break:break-word">${esc(e.memo)}</p>` : ""}
    ${photosDetailHtml(e)}
    <p class="msg err" id="detail-msg"></p>${actions}</div>`);
  extras.hydrate($("panel"));
}

function photosDetailHtml(e) {
  const list = e.src === "own" ? S.photos.get(e.baseId || e.id) || [] : [];
  if (!list.length) return "";
  const md = (d) => `${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日`;
  const exp = list.map((p) => p.expires_on).filter(Boolean).sort()[0];
  const note = exp ? `写真は${md(exp)}に消えます(予定が終わって1か月後)。` : "繰り返しの予定の写真は、自動では消えません。";
  return `<div class="pgrid">${list.map((p) => `<img class="pimg" data-path="${esc(p.path)}" data-act="ph-view" data-exp="${esc(p.expires_on || "")}" alt="写真">`).join("")}</div><p class="sub">${esc(note)}</p>`;
}

// ---------- 予定の追加・編集 ----------

let draft = null; // 追加・編集中の予定

function ownLabels() { return S.labels.filter((l) => l.kind === "custom"); }

function openForm(source, defaultDate, mode = "all") {
  const base = source ? S.own.find((x) => x.id === (source.baseId || source.id)) : null;
  const useOcc = source && mode === "occ" && source.occ;
  const labels = ownLabels();
  const baseId = base ? base.id : null;
  draft = source && base
    ? {
        id: base.id, version: base.version, mode: useOcc ? "occ" : "all", occ: source.occ || "", exdates: base.exdates,
        title: base.title, labelId: base.labelId, start: useOcc ? source.start : base.start, end: useOcc ? source.end : base.end,
        allDay: base.allDay, startTime: base.startTime || "09:00", endTime: base.endTime || "10:00", memo: base.memo,
        repeat: useOcc ? "none" : base.repeat, until: useOcc ? "" : base.until, yearsLabel: base.yearsLabel, announce: base.announce || "none",
      }
    : {
        id: null, mode: "new", title: "", labelId: labels[0] ? labels[0].id : "", start: defaultDate, end: defaultDate, allDay: true,
        startTime: "09:00", endTime: "10:00", memo: "", repeat: "none", until: "", yearsLabel: "", announce: "none",
      };
  draft.keep = useOcc ? [] : (S.photos.get(baseId) || []).slice(); // 付いている写真(「この回だけ」の編集は、新しい予定になるので持たない)
  draft.added = [];   // これから付ける写真 { blob, url }
  draft.removed = []; // 外す写真(保存したときに消す)
  renderForm();
}

function photosFormHtml(d) {
  const total = d.keep.length + d.added.length;
  const closed = photosClosed({ end: d.end, repeat: d.repeat }, S.today); // 写真の期限がもう過ぎる予定には、写真を付けられない(付けても、すぐ消える)
  const thumbs = d.keep.map((p) => `<span class="pth"><img data-path="${esc(p.path)}" alt="写真"><button data-act="ph-rm" data-id="${esc(p.id)}" aria-label="外す">✕</button></span>`).join("") +
    d.added.map((a, i) => `<span class="pth"><img src="${esc(a.url)}" alt="写真"><button data-act="ph-rm-new" data-i="${i}" aria-label="外す">✕</button></span>`).join("");
  return `<div class="fld"><label class="lb">写真(3枚まで)</label><div class="pgrid">${thumbs}</div>
    <label class="btn filebtn" style="margin-top:6px${total >= 3 || closed ? ";opacity:.4" : ""}">＋ 写真を追加<input type="file" id="f-photo" accept="image/*" multiple${total >= 3 || closed ? " disabled" : ""}></label>
    <p class="sub">${closed ? "終わって1か月以上たった予定には、写真を付けられません(付けても、すぐ消えるため)。" : "小さくして保存します。" + (d.repeat !== "none" ? "繰り返しの予定の写真は、自動では消えません。" : "写真は、予定が終わって1か月後に消えます。")}</p></div>`;
}

function refreshPhotoBlock() {
  const el = $("photo-block");
  if (!el || !draft) return;
  el.innerHTML = photosFormHtml(draft);
  extras.hydrate(el);
}

async function addPhotos(files) {
  const room = 3 - (draft.keep.length + draft.added.length);
  const list = [...files].slice(0, Math.max(0, room));
  let msg = files.length > list.length ? "写真は3枚までなので、入りきらなかった分は入れていません。" : "";
  for (const f of list) {
    try {
      const blob = await shrinkForEvent(f);
      if (blob) draft.added.push({ blob, url: URL.createObjectURL(blob) });
      else msg = "写真を読み込めませんでした。";
    } catch (e) { msg = "写真を読み込めませんでした。"; }
  }
  renderForm(msg);
}

// 保存した予定に、写真を付け外しする。失敗した枚数と理由を返す
async function persistPhotos(eventId, d) {
  const fails = [];
  if (d.removed.length) {
    if (await extras.removeFiles(d.removed.map((p) => p.path))) {
      const { error } = await supabase.from("cal_photos").delete().in("id", d.removed.map((p) => p.id));
      if (error) fails.push(friendlyText(error.message));
    } else fails.push("写真を外せませんでした");
  }
  for (const a of d.added) {
    const path = `${S.userId}/e-${extras.uuid()}.jpg`;
    try {
      await extras.upload(path, a.blob, "image/jpeg");
      const { error } = await supabase.from("cal_photos").insert({ event_id: eventId, path, size_bytes: a.blob.size });
      if (error) { await extras.removeFiles([path]); throw error; }
    } catch (e) { fails.push(friendlyText(e.message || String(e))); }
  }
  return fails;
}

function renderForm(message = "") {
  showPanel(); // 開いていなければ開く(開いているときは、そのまま)
  const d = draft;
  const labels = ownLabels();
  const title = d.id ? (d.mode === "occ" ? "この回だけ編集" : "予定を編集") : "予定を追加";
  const time = d.allDay ? "" : `<div class="row2"><div class="fld"><label class="lb" for="f-st">開始時刻</label><input class="in" type="time" step="60" id="f-st" data-f="startTime" value="${esc(d.startTime)}"></div><div class="fld"><label class="lb" for="f-et">終了時刻</label><input class="in" type="time" step="60" id="f-et" data-f="endTime" value="${esc(d.endTime)}"></div></div>`;
  const rep = d.mode === "occ" ? "" : `<div class="fld"><label class="lb" for="f-rep">繰り返し</label><select class="in" id="f-rep" data-f="repeat">${Object.entries(REPEAT).map(([k, v]) => `<option value="${k}"${d.repeat === k ? " selected" : ""}>${v}</option>`).join("")}</select></div>
    ${d.repeat !== "none" ? `<div class="fld"><label class="lb" for="f-until">繰り返しの終わり(空なら続く)</label><input class="in" type="date" id="f-until" data-f="until" value="${esc(d.until)}"></div>` : ""}
    ${d.repeat === "yearly" ? `<div class="fld"><label class="lb" for="f-years">年数の表示</label><select class="in" id="f-years" data-f="yearsLabel"><option value=""${d.yearsLabel === "" ? " selected" : ""}>なし</option><option value="age"${d.yearsLabel === "age" ? " selected" : ""}>○歳(誕生日など)</option><option value="anniv"${d.yearsLabel === "anniv" ? " selected" : ""}>○周年</option></select></div>` : ""}`;
  const tpls = d.mode === "new" && S.templates.length
    ? `<div class="fld"><span class="lb">テンプレートから入れる</span><div class="tpls">${S.templates.map((t) => `<button type="button" class="btn sm tpb" data-act="tp-use" data-id="${esc(t.id)}">${esc(t.title)}</button>`).join("")}</div></div>` : "";
  $("panel").innerHTML = `${head(title)}<div class="pb">${tpls}
    <div class="fld"><label class="lb" for="f-title">タイトル</label><input class="in" id="f-title" data-f="title" maxlength="100" value="${esc(d.title)}" autocomplete="off"></div>
    <div class="fld"><label class="lb" for="f-label">ラベル</label><select class="in" id="f-label" data-f="labelId">${labels.map((l) => `<option value="${esc(l.id)}"${d.labelId === l.id ? " selected" : ""}>${esc(l.name)}</option>`).join("")}</select></div>
    <div class="row2"><div class="fld"><label class="lb" for="f-start">開始日</label><input class="in" type="date" id="f-start" data-f="start" value="${esc(d.start)}"></div><div class="fld"><label class="lb" for="f-end">終了日</label><input class="in" type="date" id="f-end" data-f="end" value="${esc(d.end)}"></div></div>
    <div class="fld"><label class="tg"><input type="checkbox" id="f-allday" data-f="allDay"${d.allDay ? " checked" : ""}> 終日</label></div>
    ${time}${rep}
    <div class="fld"><label class="lb" for="f-memo">メモ</label><textarea class="in" id="f-memo" data-f="memo" maxlength="1000">${esc(d.memo)}</textarea></div>
    ${extras.annFieldHtml("f", d.announce, "", false)}
    <div id="cp-wrap">${copyBlockHtml(d)}</div>
    <div id="photo-block">${photosFormHtml(d)}</div>
    <p class="msg err" id="form-msg">${esc(message)}</p>
    <div class="btns"><button class="btn pri" data-act="save" id="f-save">${esc(saveLabel(d))}</button><button class="btn" data-act="close">やめる</button></div></div>`;
  pick = d.pick || null;
  extras.hydrate($("panel"));
}

function readDraftField(el) {
  const f = el.dataset.f;
  if (!f || !draft) return;
  const v = el.type === "checkbox" ? el.checked : el.value;
  draft[f] = v;
  if (f === "start" && draft.end < draft.start) draft.end = draft.start;
  if (f === "allDay" || f === "repeat") renderForm();
  else if (f === "start" || f === "end") {
    if (f === "start") { const end = $("f-end"); if (end) end.value = draft.end; }
    // コピーの元の日(選べない日)は、開始日に合わせる。開始日と同じ日を選んでいたら外す
    if (draft.pick && /^\d{4}-\d\d-\d\d$/.test(draft.start)) {
      draft.pick.base = draft.start;
      draft.pick.sel = draft.pick.sel.filter((x) => x !== draft.start);
      // まだ日を選んでいなければ、開始日の月を出す(選んでいる途中なら、今の月のまま。AN4)
      if (!draft.pick.sel.length) { draft.pick.y = Number(draft.start.slice(0, 4)); draft.pick.m = Number(draft.start.slice(5, 7)); }
    }
    refreshPhotoBlock(); // 日付を変えると、写真を付けられるか(期限)が変わる。入力中の欄は作り直さず、写真の欄だけ入れ替える
    refreshCopyBlock();
  }
}

function draftError(d) {
  if (!d.labelId) return "ラベルを選んでください(設定でラベルを作れます)。";
  if (!d.start || !d.end) return "日付を入れてください。";
  if (d.end < d.start) return "終了日は開始日より前にできません。";
  if (!d.allDay) {
    if (!d.startTime) return "開始時刻を入れてください。";
    if (d.start === d.end && d.endTime && d.endTime < d.startTime) return "終了時刻が開始時刻より前です。日をまたぐときは、終了日を次の日にしてください。";
  }
  if (d.repeat !== "none" && d.until && d.until < d.start) return "繰り返しの終わりが開始日より前です。";
  // 12か月より前に終わる予定は、夜の処理で消えるので作らせない(L5)。誕生日などの繰り返し(終わりが無い・新しい)は、昔の日付から始めてよい
  const oldest = oldestDate(S.today);
  if (d.repeat === "none" && d.end < oldest) return `${Number(oldest.slice(0, 4))}年${Number(oldest.slice(5, 7))}月より前の予定は作れません(12か月より前の予定は、自動で消えるためです)。`;
  if (d.repeat !== "none" && d.until && d.until < oldest) return "繰り返しの終わりが12か月より前です(12か月より前の予定は、自動で消えるためです)。";
  if (photosClosed({ end: d.end, repeat: d.repeat }, S.today) && d.added.length) return "終わって1か月以上たった予定には、写真を付けられません。写真を外すか、日付を直してください。";
  return "";
}

const rowFromDraft = (d, over = {}) => ({
  title: (d.title || "").trim() || "（タイトルなし）", start_date: d.start, end_date: d.end < d.start ? d.start : d.end, all_day: !!d.allDay,
  start_time: d.allDay ? "" : d.startTime, end_time: d.allDay ? "" : d.endTime || "", label_id: d.labelId, memo: d.memo || "",
  repeat_rule: d.repeat, repeat_until: d.repeat !== "none" && d.until ? d.until : null, years_label: d.repeat === "yearly" ? d.yearsLabel || "" : "",
  announce: d.announce && ["dated", "plain"].includes(d.announce) ? d.announce : "none", ...over,
});

async function saveDraft() {
  const d = draft;
  const err = draftError(d);
  if (err) return renderForm(err);
  const copies = copyDates(d);
  $("f-save").disabled = true;
  let eventId = d.id;
  try {
    if (d.mode === "new" && copies.length) {
      // 別の日へのコピーも、1回でまとめて入れる(途中で失敗したときは、1件も入らない)。写真は元の予定(開始日)にだけ付ける
      // コピーにはアナウンスを付けない(同じものが何件も流れないように)
      const rows = [rowFromDraft(d), ...copies.map((s) => { const sp = shiftSpan(d.start, d.end, s); return rowFromDraft(d, { start_date: sp.start, end_date: sp.end, announce: "none" }); })];
      const { data, error } = await supabase.from("cal_events").insert(rows).select();
      if (error) throw error;
      const base = (data || []).find((r) => r.start_date === d.start) || (data || [])[0];
      if (!base) throw new Error("保存できませんでした。もう一度お試しください。");
      eventId = base.id;
    } else if (d.mode === "new") {
      const { data, error } = await supabase.from("cal_events").insert(rowFromDraft(d)).select().single();
      if (error) throw error;
      eventId = data.id;
    } else if (d.mode === "all") {
      const { data, error } = await supabase.from("cal_events").update(rowFromDraft(d)).eq("id", d.id).eq("version", d.version).select();
      if (error) throw error;
      if (!data || !data.length) { await reloadAll(); return renderForm(`${couple() ? "相手か別の端末" : "別の端末"}で変更されたか、消されています。読み直しました。もう一度直してください。`); }
    } else {
      // この回だけ: 元の予定からこの日を外し、変えた内容を1回だけの予定として作る
      const ex = [...new Set([...(d.exdates || []), d.occ])];
      const upd = await supabase.from("cal_events").update({ exdates: ex }).eq("id", d.id).eq("version", d.version).select();
      if (upd.error) throw upd.error;
      if (!upd.data || !upd.data.length) { await reloadAll(); return renderForm(`${couple() ? "相手か別の端末" : "別の端末"}で変更されたか、消されています。読み直しました。もう一度直してください。`); }
      const ins = await supabase.from("cal_events").insert(rowFromDraft({ ...d, repeat: "none", until: "" })).select().single();
      if (ins.error) {
        await supabase.from("cal_events").update({ exdates: d.exdates || [] }).eq("id", d.id); // 元に戻す
        throw ins.error;
      }
      eventId = ins.data.id;
    }
    // 写真の付け外し(予定は保存できているので、写真だけ失敗したときは、予定は残して知らせる)
    const fails = d.keep.length + d.added.length + d.removed.length ? await persistPhotos(eventId, d) : [];
    draft = null;
    let reloadErr = null;
    try { await reloadAll({ keepShifts: true }); } catch (e) { reloadErr = e; }
    closePanel();
    if (reloadErr) setNotice(`予定は保存しました。ただ、画面を読み直せませんでした(${esc(friendlyText(reloadErr.message || String(reloadErr)))})。電波の良いところで、画面を開き直してください。`);
    else if (fails.length) setNotice(`予定は保存しました。写真${fails.length}件は保存できませんでした(${esc(fails[0])})。予定を開いて、もう一度付けてください。`);
    else if (copies.length) setNotice(`同じ予定を、ほかに${copies.length}日に入れました(${esc(datesText(copies, d.start.slice(0, 4)))})。`);
  } catch (e) {
    if (draft) renderForm(friendlyText(e.message || String(e)));
    else fail(e);
  }
}

// ---------- 別の日にコピー(日を選ぶ小さなカレンダー) ----------
// 予定の追加のフォーム(新しい予定のときだけ)と、予定の詳細の「別の日にコピー」で使う。日をタップで選び、もう一度で外す。
// 選んだ日に、同じ内容(タイトル・ラベル・終日/時刻・メモ)の、繰り返しなしの予定を作る。何日かにまたがる予定は、選んだ日から同じ長さ。写真はコピーしない

const COPY_MAX = 31; // 1回でコピーできる日の数
let pick = null;     // 今出ている日の選び { y, m, base(元の日・選べない), sel(選んだ日), msg, onChange, busy(保存中) }
let copyFrom = null; // 詳細からのコピー { uid, e(その回の予定) }

function newPick(base, onChange) {
  return { y: Number(base.slice(0, 4)), m: Number(base.slice(5, 7)), base, sel: [], msg: "", onChange, busy: false };
}

function pickHtml(p) {
  const lim = monthLimits(S.today);
  const oldest = oldestDate(S.today), last = dateKey(lim.max.y, lim.max.m, daysInMonth(lim.max.y, lim.max.m));
  const first = dateKey(p.y, p.m, 1);
  const cells = [];
  for (let i = 0; i < weekday(first); i++) cells.push("<span></span>");
  for (let d = 1; d <= daysInMonth(p.y, p.m); d++) {
    const iso = dateKey(p.y, p.m, d), wd = weekday(iso);
    const isBase = iso === p.base, on = p.sel.includes(iso), out = iso < oldest || iso > last;
    const cls = ["pkd", on ? "on" : "", isBase ? "base" : "", iso === S.today ? "tdy" : "", wd === 0 || S.holidays.has(iso) ? "sun" : wd === 6 ? "sat" : ""].filter(Boolean).join(" ");
    cells.push(`<button type="button" class="${cls}" data-act="pk-day" data-date="${iso}"${isBase || out ? " disabled" : ""} aria-pressed="${on}" aria-label="${p.m}月${d}日${isBase ? "(元の予定)" : ""}">${d}</button>`);
  }
  const mi = monthIndex(p.y, p.m);
  const prevOk = mi > monthIndex(lim.min.y, lim.min.m), nextOk = mi < monthIndex(lim.max.y, lim.max.m);
  const note = p.sel.length ? `ほかに${p.sel.length}日コピーします: ${datesText(p.sel, p.base.slice(0, 4))}` : "コピーしたい日をタップしてください(もう一度タップで外します)。";
  return `<div class="pk"><div class="pkh"><button type="button" class="btn sm" data-act="pk-prev"${prevOk ? "" : " disabled"} aria-label="前の月">‹</button><b>${p.y}年${p.m}月</b><button type="button" class="btn sm" data-act="pk-next"${nextOk ? "" : " disabled"} aria-label="次の月">›</button></div>
    <div class="pkg">${WEEKDAYS.map((w, i) => `<span class="pkw${i === 0 ? " sun" : i === 6 ? " sat" : ""}">${w}</span>`).join("")}${cells.join("")}</div>
    <p class="sub" id="pk-note">${esc(note)}</p>${p.msg ? `<p class="msg err">${esc(p.msg)}</p>` : ""}</div>`;
}

function pickAct(act, el) {
  const p = pick;
  if (!p || p.busy) return; // 保存している間は、選びを変えない(押せなくしたボタンが、また押せるようにならないように。AN3)
  p.msg = "";
  if (act === "pk-prev" || act === "pk-next") { const t = addMonths(p.y, p.m, act === "pk-prev" ? -1 : 1); p.y = t.y; p.m = t.m; }
  else if (act === "pk-day") {
    const d = el.dataset.date;
    if (p.sel.includes(d)) p.sel = p.sel.filter((x) => x !== d);
    else if (p.sel.length >= COPY_MAX) p.msg = `1回でコピーできるのは${COPY_MAX}日までです。`;
    else p.sel = [...p.sel, d].sort();
  }
  const box = $("pk-block");
  if (box) box.innerHTML = pickHtml(p);
  if (p.onChange) p.onChange();
}

// 追加のフォームの中の「別の日にもコピー」(新しい予定で、繰り返しが「なし」のときだけ)
const canCopy = (d) => d.mode === "new" && d.repeat === "none";
const copyDates = (d) => (canCopy(d) && d.pick ? d.pick.sel.filter((x) => x !== d.start) : []);
const saveLabel = (d) => { const n = copyDates(d).length; return n ? `保存(${n + 1}日分)` : "保存"; };
function spanNote(start, end) {
  const dur = diffDays(start, end);
  return dur > 0 ? `<p class="sub">選んだ日から、同じ長さ(${dur + 1}日間)で入れます。</p>` : "";
}
function copyBlockHtml(d) {
  if (!canCopy(d)) return "";
  if (!d.pick) return '<div class="fld"><button type="button" class="btn" data-act="cp-open">＋ 別の日にもコピー</button></div>';
  return `<div class="fld"><label class="lb">別の日にもコピー</label>${spanNote(d.start, d.end)}<div id="pk-block">${pickHtml(d.pick)}</div>
    <p class="sub">写真は、元の予定にだけ付きます。</p><button type="button" class="btn sm" data-act="cp-cancel">コピーをやめる</button></div>`;
}
function refreshSaveLabel() { const b = $("f-save"); if (b && draft) b.textContent = saveLabel(draft); }
function refreshCopyBlock() {
  const el = $("cp-wrap");
  if (el && draft) el.innerHTML = copyBlockHtml(draft);
  refreshSaveLabel();
}
function copyFormAct(act) {
  if (!draft) return;
  if (act === "cp-open") draft.pick = newPick(/^\d{4}-\d\d-\d\d$/.test(draft.start) ? draft.start : S.today, refreshSaveLabel);
  else draft.pick = null;
  pick = draft.pick;
  refreshCopyBlock();
}

// 予定の詳細の「別の日にコピー」
function copyBtnText(n) { return n ? `コピー(${n}日分)` : "コピー"; }
function copyHtml(msg = "") {
  const { e, uid } = copyFrom;
  const rep = e.repeat && e.repeat !== "none";
  return `${head("別の日にコピー")}<div class="pb">
    <p style="margin:0 0 2px"><b>${esc(e.title || "（タイトルなし）")}</b></p><p class="sub" style="margin-top:0">${esc(whenText(e))}</p>
    ${rep ? '<p class="sub">繰り返しの予定は、この回の内容を、繰り返しなしの予定としてコピーします。</p>' : ""}${spanNote(e.start, e.end)}
    <div id="pk-block">${pickHtml(pick)}</div>
    <p class="sub">写真はコピーしません。</p>
    <p class="msg err" id="copy-msg">${esc(msg)}</p>
    <div class="btns"><button class="btn pri" data-act="copy-save" id="copy-save"${pick.sel.length ? "" : " disabled"}>${esc(copyBtnText(pick.sel.length))}</button><button class="btn" data-act="copy-back" data-uid="${esc(uid)}">やめる</button></div></div>`;
}
function openCopy(uid) {
  const e = S.byUid.get(uid);
  if (!e || e.src !== "own") return;
  copyFrom = { uid, e };
  pick = newPick(e.start, () => { const b = $("copy-save"); if (b) { b.disabled = !pick.sel.length; b.textContent = copyBtnText(pick.sel.length); } });
  openPanel(copyHtml());
}
async function saveCopy() {
  const c = copyFrom, p = pick;
  if (!c || !p || !p.sel.length || p.busy) return;
  const e = c.e;
  const src = { title: e.title, labelId: e.labelId, start: e.start, end: e.end, allDay: e.allDay, startTime: e.startTime, endTime: e.endTime, memo: e.memo, repeat: "none", until: "", yearsLabel: "", announce: "none" };
  const rows = p.sel.map((s) => { const sp = shiftSpan(e.start, e.end, s); return rowFromDraft(src, { start_date: sp.start, end_date: sp.end }); });
  const btn = $("copy-save");
  if (btn) btn.disabled = true;
  p.busy = true;
  try {
    const { error } = await supabase.from("cal_events").insert(rows).select();
    if (error) throw error;
    const done = p.sel.slice();
    copyFrom = null;
    let reloadErr = null;
    try { await reloadAll({ keepShifts: true }); } catch (err) { reloadErr = err; }
    closePanel();
    if (reloadErr) setNotice(`コピーしました。ただ、画面を読み直せませんでした(${esc(friendlyText(reloadErr.message || String(reloadErr)))})。電波の良いところで、画面を開き直してください。`);
    else setNotice(`「${esc(e.title || "（タイトルなし）")}」を、${done.length}日にコピーしました(${esc(datesText(done, e.start.slice(0, 4)))})。`);
  } catch (err) {
    p.busy = false;
    if (copyFrom && S.panel) { setPanel(copyHtml(friendlyText(err.message || String(err)))); }
    else fail(err);
  }
}

async function deleteEvent(uid, mode) {
  const e = S.byUid.get(uid);
  if (!e || e.src !== "own") return;
  const base = S.own.find((x) => x.id === (e.baseId || e.id));
  if (!base) return;
  const repeating = base.repeat !== "none";
  const text = mode === "occ" ? "この回だけ" : repeating ? "全ての回" : "この予定";
  if (!window.confirm(`${text}を削除します。よろしいですか？`)) return;
  try {
    if (mode === "occ" && repeating) {
      const ex = [...new Set([...(base.exdates || []), e.occ])];
      const { data, error } = await supabase.from("cal_events").update({ exdates: ex }).eq("id", base.id).eq("version", base.version).select();
      if (error) throw error;
      if (!data || !data.length) { await reloadAll(); $("detail-msg").textContent = "別の端末で変更されています。読み直しました。"; return; }
    } else {
      // 写真のファイルを先に消す(予定を消すと、写真の行も一緒に消え、ファイルだけが残ってしまうため)
      const photos = S.photos.get(base.id) || [];
      if (photos.length && !(await extras.removeFiles(photos.map((p) => p.path)))) throw new Error("写真を消せませんでした。もう一度お試しください。");
      const { error } = await supabase.from("cal_events").delete().eq("id", base.id);
      if (error) throw error;
    }
    await reloadAll({ keepShifts: true });
    closePanel();
  } catch (err) {
    $("detail-msg").textContent = friendlyText(err.message || String(err));
  }
}

// ---------- 予定のテンプレート ----------
// よく入れる予定(タイトル・ラベル・終日/時刻・メモ。日付は持たない)を登録しておき、「予定を追加」の上のボタン1つで入れる。
// 設定の「予定のテンプレート」で作る・直す・並べ替え・消す。予定の詳細の「この予定をテンプレートにする」からも作れる。1人30個まで(DB でも決めてある)

const TEMPLATE_MAX = 30;
let tpl = null; // 作る・直すテンプレートの下書き { id, title, labelId, allDay, startTime, endTime, memo, from(詳細から作るときの予定の uid) }

const tplTime = (t) => (t.all_day ? "終日" : `${(t.start_time || "").replace(/^0/, "")}${t.end_time ? "〜" + t.end_time.replace(/^0/, "") : ""}`);
function templatesCardHtml() {
  const n = S.templates.length;
  const rows = S.templates.map((t, i) => `<div class="lrow tprow" data-tpid="${esc(t.id)}"><span class="tpdot" style="--c:${esc(colorOf(t.label_id))}"></span><span class="tpt"><b>${esc(t.title)}</b><small>${esc(tplTime(t))}</small></span>
      <button class="btn sm" data-act="tp-up" data-id="${esc(t.id)}"${i === 0 ? " disabled" : ""} aria-label="上へ">↑</button><button class="btn sm" data-act="tp-down" data-id="${esc(t.id)}"${i === n - 1 ? " disabled" : ""} aria-label="下へ">↓</button>
      <button class="btn sm" data-act="tp-edit" data-id="${esc(t.id)}">直す</button><button class="btn sm dng" data-act="tp-del" data-id="${esc(t.id)}" aria-label="消す">✕</button></div>`).join("");
  return `<div class="card" id="tpl"><h3>予定のテンプレート</h3>
    <p class="sub">よく入れる予定を登録しておくと、「予定を追加」のいちばん上のボタン1つで、タイトル・ラベル・時刻・メモが入ります(日付は入りません)。予定の詳細の「この予定をテンプレートにする」からも作れます。${TEMPLATE_MAX}個まで(いま${n}個)。</p>
    ${rows}<div class="btns"><button class="btn pri" data-act="tp-new"${n >= TEMPLATE_MAX ? " disabled" : ""}>＋ テンプレートを追加</button></div><p class="msg err" id="tp-msg"></p></div>`;
}
function tplFormHtml(msg = "") {
  const t = tpl, labels = ownLabels();
  const time = t.allDay ? "" : `<div class="row2"><div class="fld"><label class="lb" for="tp-st">開始時刻</label><input class="in" type="time" step="60" id="tp-st" data-tp="startTime" value="${esc(t.startTime)}"></div><div class="fld"><label class="lb" for="tp-et">終了時刻</label><input class="in" type="time" step="60" id="tp-et" data-tp="endTime" value="${esc(t.endTime)}"></div></div>`;
  return `${head(t.id ? "テンプレートを直す" : "テンプレートを作る")}<div class="pb">
    <p class="sub">ボタンには、タイトルがそのまま出ます。日付は入りません(使うときの日付のまま)。</p>
    <div class="fld"><label class="lb" for="tp-title">タイトル</label><input class="in" id="tp-title" data-tp="title" maxlength="100" value="${esc(t.title)}" autocomplete="off"></div>
    <div class="fld"><label class="lb" for="tp-label">ラベル</label><select class="in" id="tp-label" data-tp="labelId">${labels.map((l) => `<option value="${esc(l.id)}"${t.labelId === l.id ? " selected" : ""}>${esc(l.name)}</option>`).join("")}</select></div>
    <div class="fld"><label class="tg"><input type="checkbox" id="tp-allday" data-tp="allDay"${t.allDay ? " checked" : ""}> 終日</label></div>
    ${time}
    <div class="fld"><label class="lb" for="tp-memo">メモ</label><textarea class="in" id="tp-memo" data-tp="memo" maxlength="1000">${esc(t.memo)}</textarea></div>
    <p class="msg err" id="tp-fmsg">${esc(msg)}</p>
    <div class="btns"><button class="btn pri" data-act="tp-save" id="tp-save">保存</button><button class="btn" data-act="tp-back">やめる</button></div></div>`;
}
function openTplForm(src, from = null) {
  const labels = ownLabels();
  const okLabel = (id) => (labels.some((l) => l.id === id) ? id : labels[0] ? labels[0].id : "");
  tpl = src && src.src === "own"
    ? { id: null, title: src.title || "", labelId: okLabel(src.labelId), allDay: !!src.allDay, startTime: src.startTime || "09:00", endTime: src.endTime || "", memo: src.memo || "", from }
    : src
      ? { id: src.id, title: src.title, labelId: okLabel(src.label_id), allDay: src.all_day, startTime: src.start_time || "09:00", endTime: src.end_time || "", memo: src.memo || "", from: null }
      : { id: null, title: "", labelId: okLabel(""), allDay: true, startTime: "09:00", endTime: "10:00", memo: "", from: null };
  openPanel(tplFormHtml());
}
function readTplField(el) {
  if (!tpl) return;
  const f = el.dataset.tp;
  tpl[f] = el.type === "checkbox" ? el.checked : el.value;
  if (f === "allDay") { const p = $("panel"), top = p.scrollTop; setPanel(tplFormHtml()); p.scrollTop = top; }
}
// テンプレートの画面を閉じて、来たところ(設定の「予定のテンプレート」か、予定の詳細)へ戻る
function tplDone(okMsg = "") {
  const from = tpl && tpl.from;
  tpl = null;
  if (from && S.byUid.has(from)) {
    openEvent(from);
    if (okMsg) { const m = $("detail-msg"); if (m) { m.className = "msg ok"; m.textContent = okMsg; } }
    return;
  }
  openPanel(settingsHtml());
  const card = $("tpl");
  if (card) card.scrollIntoView({ block: "start" });
}
async function saveTpl() {
  const t = tpl;
  if (!t) return;
  const title = (t.title || "").trim();
  if (!title) return setPanel(tplFormHtml("タイトルを入れてください(ボタンに出ます)。"));
  if (!t.allDay && !t.startTime) return setPanel(tplFormHtml("開始時刻を入れてください。"));
  const row = { title, label_id: t.labelId || null, all_day: !!t.allDay, start_time: t.allDay ? "" : t.startTime, end_time: t.allDay ? "" : t.endTime || "", memo: t.memo || "" };
  const btn = $("tp-save");
  if (btn) btn.disabled = true;
  try {
    if (t.id) {
      const { data, error } = await supabase.from("cal_templates").update(row).eq("id", t.id).select().single();
      if (error) throw error;
      Object.assign(S.templates.find((x) => x.id === t.id) || {}, data);
    } else {
      if (S.templates.length >= TEMPLATE_MAX) throw new Error(`予定のテンプレートは${TEMPLATE_MAX}個までです。`);
      row.sort = S.templates.reduce((m, x) => Math.max(m, x.sort || 0), 0) + 1;
      const { data, error } = await supabase.from("cal_templates").insert(row).select().single();
      if (error) throw error;
      S.templates.push(data);
    }
    tplDone(t.from ? `テンプレート「${title}」にしました。予定を追加するときに使えます(設定の「予定のテンプレート」で直せます)。` : "");
  } catch (e) {
    if (tpl) setPanel(tplFormHtml(friendlyText(e.message || String(e))));
  }
}
async function tplAction(act, el) {
  const msg = (m) => { const x = $("tp-msg"); if (x) x.textContent = m; };
  const id = el.dataset.id;
  try {
    if (act === "tp-new") return openTplForm(null);
    if (act === "tp-edit") { const t = S.templates.find((x) => x.id === id); if (t) openTplForm(t); return; }
    if (act === "tp-save") return saveTpl();
    if (act === "tp-back") return tplDone();
    if (act === "tp-from") {
      const e = S.byUid.get(el.dataset.uid);
      if (!e || e.src !== "own") return;
      if (S.templates.length >= TEMPLATE_MAX) { const m = $("detail-msg"); if (m) m.textContent = `予定のテンプレートは${TEMPLATE_MAX}個までです。設定の「予定のテンプレート」で、使わないものを消してください。`; return; }
      return openTplForm(e, el.dataset.uid);
    }
    if (act === "tp-use") return useTemplate(id);
    const p = $("panel"), top = p.scrollTop;
    if (act === "tp-del") {
      const t = S.templates.find((x) => x.id === id);
      if (!t || !window.confirm(`テンプレート「${t.title}」を消します。よろしいですか？(入れた予定は消えません)`)) return;
      const { error } = await supabase.from("cal_templates").delete().eq("id", id);
      if (error) return msg(friendlyText(error.message));
      S.templates = S.templates.filter((x) => x.id !== id);
    } else if (act === "tp-up" || act === "tp-down") {
      const i = S.templates.findIndex((x) => x.id === id), j = i + (act === "tp-up" ? -1 : 1);
      if (i < 0 || j < 0 || j >= S.templates.length) return;
      const order = S.templates.slice();
      [order[i], order[j]] = [order[j], order[i]];
      for (let k = 0; k < order.length; k++) if (order[k].sort !== k + 1) {
        const { error } = await supabase.from("cal_templates").update({ sort: k + 1 }).eq("id", order[k].id);
        if (error) return msg(friendlyText(error.message));
        order[k].sort = k + 1;
      }
      S.templates = order;
    }
    setPanel(settingsHtml());
    p.scrollTop = top;
  } catch (e) {
    msg(friendlyText(e.message || String(e)));
  }
}
// 予定の追加で、テンプレートのボタンを押したとき。日付・繰り返し・コピーの選びはそのまま。アナウンスは付けない
function useTemplate(id) {
  const t = S.templates.find((x) => x.id === id);
  if (!t || !draft) return;
  const labels = ownLabels();
  Object.assign(draft, {
    title: t.title, labelId: labels.some((l) => l.id === t.label_id) ? t.label_id : draft.labelId, allDay: !!t.all_day,
    startTime: t.start_time || "09:00", endTime: t.all_day ? draft.endTime : t.end_time || "", memo: t.memo || "", announce: "none",
  });
  renderForm();
}

// ---------- アナウンス(カレンダーの上の1行) ----------
// 予定と重要メモで「アナウンスに出す」にしたものを、1件ずつ切り替えて流す(cal-ann.js)。並べ方と10件までは cal-core.js の announceItems

function refreshAnn() { if (announcer) announcer.set(announceItems(S.own, S.importants, S.today)); }
function openAnnItem(it) {
  if (!it) return;
  if (it.kind === "memo") return extras.openImportantMemo(it.id);
  // 隠したラベルの予定や、今の画面の範囲の外の回でも開けるように、その回を入れておく
  if (!S.byUid.has(it.id) && it.ev) S.byUid.set(it.id, { ...it.ev, labelRank: rankOf(it.ev.labelId) });
  openEvent(it.id);
}
let annList = [];
function openAnnList(all) {
  annList = all.slice();
  const rows = annList.map((it, i) => `<button class="erow" data-act="ann-open" data-i="${i}" style="--c:${esc(it.kind === "memo" ? "var(--accent)" : colorOf(it.ev && it.ev.labelId))}"><span class="dot"></span><span><div class="t">${esc(it.text)}</div><div class="m">${it.kind === "memo" ? "重要メモ" : "予定"}${it.dated ? "" : "(日付なし)"}${i >= ANNOUNCE_MAX ? "・上には流していません" : ""}</div></span></button>`).join("");
  openPanel(`${head(`アナウンス ${annList.length}件`)}<div class="pb">
    ${annList.length > ANNOUNCE_MAX ? `<p class="sub">上に流すのは${ANNOUNCE_MAX}件までです(日付の近いものから)。この一覧には全部出ます。</p>` : ""}
    ${rows || '<p class="sub">アナウンスはありません。</p>'}
    <p class="sub">予定は、予定の詳細の「アナウンスに出す」で、重要メモは、メモを直す画面で、付け外しできます。</p></div>`);
}
// 予定の詳細の「アナウンスに出す/出すのをやめる」(出すときは日付あり)。繰り返しの予定は、全部の回(次の回を出す)
async function toggleAnnounce(uid) {
  const e = S.byUid.get(uid);
  const base = e && S.own.find((x) => x.id === (e.baseId || e.id));
  if (!base) return;
  const next = base.announce && base.announce !== "none" ? "none" : "dated";
  const say = (t) => { const m = $("detail-msg"); if (m) m.textContent = t; };
  try {
    const { data, error } = await supabase.from("cal_events").update({ announce: next }).eq("id", base.id).eq("version", base.version).select();
    if (error) throw error;
    await reloadAll({ keepShifts: true });
    // 隠したラベルの予定は、読み直したあとの画面の予定に入らないので、入れてから開く(入れないと、案内を出す前に画面が閉じていた。AO6)
    if (!S.byUid.has(uid)) S.byUid.set(uid, e);
    openEvent(uid);
    if (!data || !data.length) say("別の端末で変更されています。読み直しました。もう一度押してください。");
  } catch (err) {
    say(friendlyText(err.message || String(err)));
  }
}

// ---------- 設定 ----------

// 自分が使っている写真・画像の量(保存してある大きさの合計)
function usageText() {
  let photos = 0, photoBytes = 0;
  for (const list of S.photos.values()) for (const p of list) { photos++; photoBytes += Number(p.size_bytes) || 0; }
  const galleryBytes = S.gallery.reduce((n, g) => n + (Number(g.size_bytes) || 0), 0);
  const mb = (b) => (b < 104858 ? "0.1MB未満" : `${Math.round((b / 1048576) * 10) / 10}MB`);
  return `約 ${mb(photoBytes + galleryBytes)}(画像の置き場 ${S.gallery.length}/${S.galleryMax || 10}枚・予定の写真 ${photos}枚)`;
}

// 設定の折りたたみ(ラベル・このカレンダーに出すもの)が開いているか。設定を開き直すたびに閉じた状態から始める。
// 設定の中身を描き直したとき(ラベルの追加・チェックの切り替えなど)に閉じてしまわないよう、開閉をここに覚える(保存はしない)
let settingsFold = { labels: false, calview: false, share: false };

// 「このカレンダーに出すもの」を閉じていても分かるように、見出しの横に出す一言(例: 勤務・休日)
function calViewNote() {
  const on = [S.cfg.duty && "勤務", S.cfg.off && "休日", S.cfg.offduty && "非番を別に"].filter(Boolean);
  return on.length ? on.join("・") : "なし";
}

// 夫婦のカレンダー: 自分で作ったラベルを「自分だけ」(相手に見せない)にする切り替え。相手が作ったラベルには出さない
function privRow(l) {
  if (!couple() || l.kind !== "custom" || (l.created_by && l.created_by !== S.userId)) return "";
  return `<label class="tg priv"><input type="checkbox" data-priv="${esc(l.id)}"${l.private_to ? " checked" : ""}> 🔒 自分だけ(${esc(givenOf(couple().name))}さんに見せない)</label>`;
}

function settingsHtml() {
  const theme = storageGet(THEME_KEY) || "auto";
  const vis = visibleLabels();
  const labelRows = vis.map((l, i) => `<div class="lrow" data-lid="${esc(l.id)}">
      <input type="color" value="${esc(l.color)}" data-lf="color" aria-label="色">
      <input class="in" value="${esc(l.name)}" maxlength="20" data-lf="name" aria-label="名前">
      <button class="btn sm" data-act="l-up" data-lid="${esc(l.id)}"${i === 0 ? " disabled" : ""} aria-label="上へ">↑</button>
      <button class="btn sm" data-act="l-down" data-lid="${esc(l.id)}"${i === vis.length - 1 ? " disabled" : ""} aria-label="下へ">↓</button>
      ${l.kind === "custom" ? `<button class="btn sm dng" data-act="l-del" data-lid="${esc(l.id)}" aria-label="削除">✕</button>` : '<span style="width:34px"></span>'}
    </div>${privRow(l)}`).join("");
  const customCount = S.labels.filter((l) => l.kind === "custom").length;
  return (`${head("設定")}<div class="pb">
    <div class="links2">
      <a class="btn${S.dots.notices ? " has-dot" : ""}" id="to-notices" href="../notices.html">📢 お知らせ</a>
      <a class="btn${S.dots.contact ? " has-dot" : ""}" id="to-contact" href="../contact.html">✉️ お問い合わせ</a>
    </div>
    <p class="sub links2-note">※ 意見・要望はお問い合わせから</p>
    <details class="card fold" id="about"><summary><h3>shiftflowカレンダーについて</h3></summary>
      <ul>
        <li><b>できること</b>: 勤務入力で保存した勤務と、自分で作る予定を、月の画面で見られます。</li>
        <li><b>勤務の予定</b>は、勤務入力で直します(ここからは直せません)。名前や時間の付き方は、勤務入力の設定どおりです。</li>
        <li><b>上のラベルのボタン</b>を押すと、そのラベルの予定が消えます。もう一度押すと戻ります。色と並び順は、設定の「ラベル」で決めます。</li>
        <li><b>時刻</b>は分単位で入れられます。日をまたぐ予定は、終了日を次の日にします。カレンダーの帯には名前だけが出ます(時刻は、予定をタップすると出ます)。</li>
        <li><b>別の日にコピー</b>: 予定の追加の「＋ 別の日にもコピー」か、予定をタップして「別の日にコピー」で、同じ予定を選んだ日にも入れられます。</li>
        <li>下から出る画面は、「✕」のほかに、上の部分を下に引いても閉じます。</li>
        <li><b>予定のテンプレート</b>: この設定の下の「予定のテンプレート」に登録すると、予定の追加のいちばん上のボタンで、タイトル・時刻などが入ります。</li>
        <li><b>アナウンス</b>: 予定・重要メモで「アナウンスに出す」にすると、上のラベルの下に、1件ずつ切り替えて出ます(日付ありは「あと○日」)。右の「1/3」で一覧です。</li>
        <li><b>見返せる期間</b>は、過去1年までです。予定の写真は、予定が終わって1か月で消えます(1つの予定に3枚まで)。</li>
        <li><b>1つのアカウントで1人分</b>のカレンダーです。ほかの利用者と勤務を見せ合うときは、この設定の「👥 カレンダーの共有」で、相手の社員番号にお誘いを送ります(5人まで。見せる範囲は自分で決めます。相手の勤務は名前のラベルで出て、見るだけです)。夫婦は、招待した人のカレンダーを2人で一緒に使えます(予定・TODO・写真なども2人で見て直せます。「自分だけ」にしたラベルの予定は相手に見えません)。アプリを使っていない家族には、勤務をGoogleカレンダーに登録して共有します。</li>
        <li><b>画像にする</b>: 下の「月のカレンダーを画像にする」と「選んだ日に〇をつけて画像にする」で、カレンダーを1枚の画像にして、LINEで送ったり印刷したりできます(画像は端末の中で作ります)。</li>
        <li>ホーム画面に追加すると、アプリのように開けます。最初に1回、社員番号とPINでログインします。</li>
        <li>ホーム画面のアイコンと、画面の色合いは、この設定の下の方で変えられます。「ラベル」と「このカレンダーに出すもの」は、見出しを押すと開きます。</li>
      </ul></details>
    ${imager ? imager.sectionsHtml() : ""}
    ${templatesCardHtml()}
    <details class="card fold" id="labels" data-fold="labels"${settingsFold.labels ? " open" : ""}><summary><h3>ラベル</h3><span class="fold-note">${vis.length}個</span></summary>
      <p class="sub">名前と色、並び順を決めます。自分で作れるのは10個までです。勤務・休日・非番のラベルは、勤務の予定の色です(非番は、「〜」とその時間。設定で非番の時間用カレンダーを使っている人だけに出ます)。</p>
      ${labelRows}
      <div class="lrow"><input type="color" id="nl-color" value="#8e44ad" aria-label="新しいラベルの色"><input class="in" id="nl-name" maxlength="20" placeholder="新しいラベルの名前" aria-label="新しいラベルの名前"><button class="btn sm pri" data-act="l-add"${customCount >= 10 ? " disabled" : ""}>追加</button></div>
      <p class="msg err" id="label-msg"></p></details>
    <details class="card fold" id="calview" data-fold="calview"${settingsFold.calview ? " open" : ""}><summary><h3>このカレンダーに出すもの</h3><span class="fold-note">${esc(calViewNote())}</span></summary>
      <label class="tg"><input type="checkbox" data-cv="cal_show_duty" id="cv-duty"${S.cfg.duty ? " checked" : ""}> 勤務</label>
      <label class="tg"><input type="checkbox" data-cv="cal_show_off" id="cv-off"${S.cfg.off ? " checked" : ""}> 休日</label>
      <label class="tg"><input type="checkbox" data-cv="cal_offduty_label" id="cv-offduty"${S.cfg.offduty ? " checked" : ""}> 非番の時間を別のボタンにする</label>
      <p class="sub">チェックを外したものは、このカレンダーに出ません(ボタンも出ません)。Googleカレンダーに登録している人で、休日用のカレンダーを作っていない人は、休日が外れた状態から始まります。非番は、「非番を2段で出す」設定のとき、「〜」の下に出る退勤時間の帯が、別のボタン・別の色になります(外すと、勤務に含めて出します)。</p>
      <p class="msg err" id="cv-msg"></p></details>
    ${shareCardHtml()}
    ${appIcon.sectionHtml(esc)}
    <div class="card"><h3>画面の色合い</h3><div class="seg" role="radiogroup">
      ${[["auto", "自動"], ["light", "ライト"], ["dark", "ダーク"]].map(([v, t]) => `<label><input type="radio" name="theme" value="${v}"${theme === v ? " checked" : ""}><span>${t}</span></label>`).join("")}
    </div><p class="sub">「自動」は、端末のダークモードの設定に合わせます。この端末だけの設定です。</p></div>
    <div class="card" id="my-usage"><h3>あなたの写真・画像の量</h3><p>${esc(usageText())}</p><p class="sub">画像の置き場は1人10枚(夫婦のカレンダーは20枚)まで、予定の写真は1つの予定に3枚までです。写真は予定が終わって1か月で消えます。</p></div>
  </div>`);
}
function openSettings() { openPanel(settingsHtml()); }

// まだ見ていないお知らせ・お問い合わせの返事があれば、下のメニューの「設定」と、設定の中のボタンに赤い点を付ける。
// 見た記録は勤務入力側と同じもの(この端末に1つ)。見て「戻る」で戻ると、画面を読み直す(app.js)ので点も付け直る。
// 読めないときは点を出さない(カレンダーの動きは止めない)
async function loadDots() {
  const [notices, replyAt, inbox] = await Promise.all([fetchNotices().catch(() => null), fetchContactReplyAt().catch(() => null), fetchShareInboxCount().catch(() => null)]);
  // 共有のお誘いは、返事をするまで点を出す(お知らせのいちばん上と、設定の「カレンダーの共有」に出る)
  S.dots = { notices: !!(notices && unseenNotices(notices).length) || !!inbox, contact: hasUnseenReply(replyAt), share: !!inbox };
  $("tab-settings").classList.toggle("has-dot", S.dots.notices || S.dots.contact);
  $("to-notices")?.classList.toggle("has-dot", S.dots.notices); // 読めるより先に設定を開いていたとき
  $("to-contact")?.classList.toggle("has-dot", S.dots.contact);
  $("share-sum")?.classList.toggle("has-dot", S.dots.share);
}

// カレンダーに出すもの(勤務・休日・非番): 保存して、すぐ反映する
async function saveCalView(col, value) {
  // upsert は使わない(利用者は user_id を書き換える権限が無く、「permission denied」になる)。あれば更新、無ければ追加(設定ページと同じ)
  const upd = await supabase.from("user_settings").update({ [col]: value }).eq("user_id", S.userId).select("user_id");
  if (upd.error) throw upd.error;
  const hit = Array.isArray(upd.data) ? upd.data.length : upd.data ? 1 : 0;
  if (!hit) {
    const ins = await supabase.from("user_settings").insert({ user_id: S.userId, [col]: value });
    if (ins.error) throw ins.error;
  }
  S.settingsRow = { ...(S.settingsRow || {}), [col]: value };
  S.cfg = resolveCalView(S.settingsRow);
}

async function labelUpdate(id, patch) {
  const { error } = await supabase.from("cal_labels").update(patch).eq("id", id);
  if (error) throw error;
}

async function moveLabel(id, delta) {
  const vis = visibleLabels(); // 出していないラベル(使っていない非番)は、並べ替えの相手にしない
  const i = vis.findIndex((l) => l.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= vis.length) return;
  const order = vis.map((l) => l.id);
  [order[i], order[j]] = [order[j], order[i]];
  for (const l of S.labels) if (!order.includes(l.id)) order.push(l.id);
  for (let k = 0; k < order.length; k++) {
    const l = S.labels.find((x) => x.id === order[k]);
    if (l.sort !== k + 1) await labelUpdate(l.id, { sort: k + 1 });
  }
  await loadLabels();
}

function labelMsg(text) { const el = $("label-msg"); if (el) el.textContent = text || ""; }

async function settingsAction(act, el) {
  try {
    if (act === "l-up" || act === "l-down") {
      await moveLabel(el.dataset.lid, act === "l-up" ? -1 : 1);
    } else if (act === "l-del") {
      const l = labelOf(el.dataset.lid);
      if (!l || !window.confirm(`ラベル「${l.name}」を削除します。よろしいですか？`)) return;
      const { error } = await supabase.from("cal_labels").delete().eq("id", l.id);
      if (error) {
        labelMsg(/foreign key|violates/i.test(error.message || "") ? "このラベルを使っている予定があるので、削除できません。先に予定のラベルを変えてください。" : friendlyText(error.message));
        return;
      }
      S.hidden.delete(l.id);
      await Promise.all([loadLabels(), loadTemplates().catch(() => {})]); // ラベルを消すと、そのラベルのテンプレートはラベルが空になる
    } else if (act === "l-add") {
      const name = $("nl-name").value.trim();
      if (!name) return labelMsg("名前を入れてください。");
      const { error } = await supabase.from("cal_labels").insert({ name, color: $("nl-color").value, sort: S.labels.length + 1 });
      if (error) return labelMsg(friendlyText(error.message));
      await loadLabels();
    }
    setPanel(settingsHtml()); // 開いたまま中身だけ入れ替える(openSettings だと、いちばん上までスクロールが戻ってしまう)
    render();
  } catch (err) {
    labelMsg(friendlyText(err.message || String(err)));
  }
}

async function labelFieldChanged(el) {
  const row = el.closest("[data-lid]");
  if (!row) return;
  const id = row.dataset.lid;
  const l = labelOf(id);
  if (!l) return;
  try {
    if (el.dataset.lf === "color") {
      await labelUpdate(id, { color: el.value });
      l.color = el.value;
    } else if (el.dataset.lf === "name") {
      const name = el.value.trim();
      if (!name) { el.value = l.name; return labelMsg("名前は空にできません。"); }
      if (name !== l.name) { await labelUpdate(id, { name }); l.name = name; }
    }
    labelMsg("");
    render();
  } catch (err) {
    labelMsg(friendlyText(err.message || String(err)));
  }
}

// ---------- カレンダーの共有(docs/share/DESIGN.md) ----------
// 設定の「アイコンの設定」のすぐ上。共有している人・届いているお誘い・返事待ち・新しく共有する
let shareNote = { text: "", kind: "" }; // 直前の操作の結果(描き直しても消えないように、ここに持つ)

function shareCount() { return S.share.links.length + S.share.sent.filter((x) => x.state === "pending").length; }

function shareCardHtml() {
  const sh = S.share;
  const scopeSelect = (link) => `<select class="in" data-shscope="${esc(link.id)}" aria-label="${esc(link.partner_name)}さんに見せる範囲">${SCOPES.map(([v, t]) => `<option value="${v}"${v === link.my_scope ? " selected" : ""}>${t}</option>`).join("")}</select>`;
  const labelEdit = (link) => {
    const v = sh.views.find((x) => x.owner_id === link.partner_id);
    if (!v || link.their_scope === "none") return "";
    const row = (nameKey, colorKey, what) => `<div class="lrow"><input type="color" value="${esc(v[colorKey])}" data-mv="${colorKey}" data-owner="${esc(v.owner_id)}" aria-label="${what}のラベルの色"><input class="in" value="${esc(v[nameKey])}" maxlength="10" data-mv="${nameKey}" data-owner="${esc(v.owner_id)}" aria-label="${what}のラベルの名前"><span class="fold-note">${what}</span></div>`;
    return row("name", "color", "勤務") + (link.their_scope === "duty_off" ? row("off_name", "off_color", "休日") : "");
  };
  const links = sh.links.map((l) => `<div class="share-row">
      <p><b>${esc(l.partner_name)}</b>さん(${kindText(l.kind)})</p>
      ${l.kind === "couple" ? `<p class="sub">${l.inviter ? "あなたのカレンダーを、2人で一緒に使っています。" : `${esc(l.partner_name)}さんのカレンダーを、2人で一緒に使っています。`}勤務・休日のラベルの名前と色は、設定の「ラベル」で変えられます(2人で同じ)。</p>` : ""}
      <label class="sub">あなたが見せる範囲 ${scopeSelect(l)}</label>
      <p class="sub">相手から見せてもらう範囲: <b>${esc(scopeText(l.their_scope))}</b></p>
      ${labelEdit(l)}
      <div class="btns"><button class="btn sm dng" data-act="sh-stop" data-id="${esc(l.id)}" data-name="${esc(l.partner_name)}" data-kind="${esc(l.kind)}" data-partner="${esc(l.partner_id)}" data-inviter="${l.inviter ? "1" : ""}">共有をやめる</button></div>
    </div>`).join("");
  const sent = sh.sent.map((x) => x.state === "pending"
    ? `<div class="lrow"><span class="tpt">${esc(x.employee_no)} さんへ(${kindText(x.kind)}・${esc(mdText(x.expires_at))}まで)</span><button class="btn sm" data-act="sh-cancel" data-id="${esc(x.id)}">取り消す</button></div>`
    : `<div class="lrow"><span class="tpt">${esc(x.employee_no)} さん: 共有されませんでした</span><button class="btn sm" data-act="sh-cancel" data-id="${esc(x.id)}" aria-label="消す">✕</button></div>`).join("");
  const full = shareCount() >= SHARE_MAX;
  return `<details class="card fold" id="share" data-fold="share"${settingsFold.share || sh.received.length ? " open" : ""}><summary id="share-sum" class="${S.dots.share ? "has-dot" : ""}"><h3>👥 カレンダーの共有</h3><span class="fold-note">${shareCount()}/${SHARE_MAX}人</span></summary>
      <p class="sub">相手の社員番号でお誘いを送り、相手が「共有する」を押すと共有できます。<b>仲間</b>: お互いの勤務を見せ合います(見るだけ。相手の勤務は相手の名前のラベルで出ます。名前と色は、ここで変えられます。相手には関係しません)。<b>夫婦</b>: あなたのカレンダーを2人で一緒に使います(1組まで)。どこまで勤務を見せるかは、それぞれが決めます。</p>
      ${sh.received.length ? `<h4>届いているお誘い</h4>${receivedHtml(sh.received)}` : ""}
      ${sh.links.length ? `<h4>共有している人</h4>${links}` : ""}
      ${sh.sent.length ? `<h4>返事待ち</h4>${sent}` : ""}
      <h4>新しく共有する</h4>
      <input class="in" id="sh-no" inputmode="numeric" autocomplete="off" maxlength="7" placeholder="相手の社員番号(7桁)" aria-label="相手の社員番号">
      <p class="sub">種類</p>
      <div class="seg" role="radiogroup"><label><input type="radio" name="sh-kind" value="mate" checked><span>仲間</span></label><label><input type="radio" name="sh-kind" value="couple"${couple() ? " disabled" : ""}><span>夫婦</span></label></div>
      <p class="sub">あなたの勤務を見せる範囲</p>
      ${scopeSeg("sh-scope", "duty")}
      <div class="btns"><button class="btn pri" data-act="sh-send"${full ? " disabled" : ""}>お誘いを送る</button></div>
      ${full ? `<p class="sub">共有できるのは${SHARE_MAX}人までです(返事待ちも数えます)。</p>` : ""}
      <p class="msg${shareNote.kind ? " " + shareNote.kind : ""}" id="share-msg">${esc(shareNote.text)}</p></details>`;
}

// 共有を変えたあと: 一覧を読み直し、必要なら勤務(相手の分)も読み直して描き直す
async function shareRefresh(reloadShifts) {
  await loadShare();
  if (reloadShifts) {
    S.shifts = new Map();
    try { await ensureAround(); } catch (e) { fail(e); }
  }
  if (S.panel) setPanel(settingsHtml());
  render();
  loadDots().catch(() => {});
}

// 夫婦を始めた・やめたとき: 使うカレンダーが変わるので、全部読み直す
async function coupleChanged() {
  try { await reloadAll(); } catch (e) { fail(e); }
  if (S.panel) setPanel(settingsHtml());
  loadDots().catch(() => {});
}

function shareSay(text, kind = "") {
  shareNote = { text: friendlyText(text || ""), kind };
  const m = $("share-msg");
  if (m) { m.textContent = shareNote.text; m.className = "msg" + (kind ? " " + kind : ""); }
}

async function shareAction(act, el) {
  try {
    if (act === "sh-send") {
      const no = toHalfWidth($("sh-no").value).replace(/\D/g, "");
      if (no.length !== 7) return shareSay("社員番号は7桁の数字で入れてください。", "err");
      const sc = $("panel").querySelector('input[name="sh-scope"]:checked');
      const kd = $("panel").querySelector('input[name="sh-kind"]:checked');
      const kind = kd ? kd.value : "mate";
      if (kind === "couple" && !window.confirm("夫婦のお誘いを送ります。相手が「共有する」を押すと、あなたのカレンダー(予定・TODO・写真など)を2人で一緒に使います。よろしいですか？")) return;
      el.disabled = true;
      await shareRpc("cal_share_send", { p_employee_no: no, p_kind: kind, p_scope: sc ? sc.value : "duty" });
      // 相手がいてもいなくても、同じ文(登録しているか探れないように)
      shareSay(`${no} さんにお誘いを送りました(相手が使っていれば、お知らせに届きます。返事は14日まで待てます)。`, "ok");
      await shareRefresh(false);
    } else if (act === "sh-cancel") {
      await shareRpc("cal_share_cancel", { p_invite: el.dataset.id });
      shareSay("");
      await shareRefresh(false);
    } else if (act === "sh-stop") {
      const isCouple = el.dataset.kind === "couple";
      if (isCouple) {
        // 招待された側が作ったものは、招待された側のカレンダーに戻る(招待した側には残らない)
        const member = el.dataset.inviter ? el.dataset.partner : S.userId;
        const who = member === S.userId ? "あなた" : `${el.dataset.name}さん`;
        const evs = S.own.filter((e) => e.createdBy === member).length;
        let photos = 0;
        for (const list of S.photos.values()) photos += list.filter((p) => p.created_by === member).length;
        if (!window.confirm(`${el.dataset.name}さんとの夫婦の共有をやめますか？\n${who}が作った予定 ${evs}件・写真 ${photos}枚(TODO・重要メモ・画像なども)は、${who}のカレンダーに移ります。`)) return;
      } else if (!window.confirm(`${el.dataset.name}さんとの共有をやめますか？(お互いのカレンダーから、相手の勤務が消えます)`)) return;
      await shareRpc("cal_share_stop", { p_link: el.dataset.id });
      shareSay(`${el.dataset.name}さんとの共有をやめました。`, "ok");
      if (isCouple) await coupleChanged(); else await shareRefresh(true);
    }
  } catch (err) {
    el.disabled = false;
    shareSay(err.message || String(err), "err");
  }
}

// 届いているお誘いの「共有する」「断る」(お知らせと同じ部品)
async function shareInviteClick(el) {
  el.disabled = true;
  try {
    const text = await receivedAction(el, $("panel"));
    if (text) shareSay(text, "ok");
    if (text && el.dataset.share === "accept" && el.dataset.kind === "couple") await coupleChanged();
    else await shareRefresh(el.dataset.share === "accept");
  } catch (err) {
    el.disabled = false;
    shareSay(err.message || String(err), "err");
  }
}

// 見せる範囲(select)・名前のラベルの名前と色を変えたとき
async function shareFieldChanged(el) {
  try {
    if (el.dataset.shscope) {
      await shareRpc("cal_share_set_scope", { p_link: el.dataset.shscope, p_scope: el.value });
      shareSay(`見せる範囲を「${scopeText(el.value)}」にしました。相手が次にカレンダーを開いたときに変わります。`, "ok");
      await shareRefresh(false);
      return;
    }
    const key = el.dataset.mv, owner = el.dataset.owner;
    const v = S.share.views.find((x) => x.owner_id === owner);
    if (!v) return;
    let value = el.value;
    if (key === "name" || key === "off_name") {
      value = value.trim();
      if (!value) { el.value = v[key]; return shareSay("名前は空にできません。", "err"); }
    }
    if (value === v[key]) return;
    const { error } = await supabase.from("cal_share_views").update({ [key]: value }).eq("viewer_id", S.userId).eq("owner_id", owner);
    if (error) throw error;
    v[key] = value;
    shareSay("");
    render();
  } catch (err) {
    shareSay(err.message || String(err), "err");
  }
}

// ---------- 月の移動 ----------

// 月の移動(◀ ▶ のボタン): その月の最初の週が上に来るまで、なめらかに動く。月の表示と読み込みは、スクロールの動きに合わせて追いかける
function goMonth(y, m) {
  const lim = monthLimits(S.today);
  const idx = monthIndex(y, m);
  if (idx < monthIndex(lim.min.y, lim.min.m) || idx > monthIndex(lim.max.y, lim.max.m)) return;
  scrollToDate(dateKey(y, m, 1), 0, true);
}

let scrollQueued = false;
function onScroll() {
  if (scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(() => {
    scrollQueued = false;
    const v = visibleMonth();
    if (v.y === S.y && v.m === S.m) return;
    S.y = v.y; S.m = v.m;
    S.notice = ""; // 前の月の失敗の案内は消す(この月の失敗は、下で出し直す)
    updateHeader();
    showBanner();
    const y = S.y, m = S.m;
    ensureAround().then((loaded) => { if (loaded && S.y === y && S.m === m) render(); }).catch((e) => { if (S.y === y && S.m === m) fail(e); });
  });
}

// ---------- 起動 ----------

function bind() {
  $("prev").addEventListener("click", () => { const n = addMonths(S.y, S.m, -1); goMonth(n.y, n.m); });
  $("next").addEventListener("click", () => { const n = addMonths(S.y, S.m, 1); goMonth(n.y, n.m); });
  const toToday = () => { closePanel(); scrollToDate(S.today, 1, true); };
  $("cal").addEventListener("scroll", onScroll, { passive: true });
  $("today").addEventListener("click", toToday);
  $("tab-today").addEventListener("click", toToday);
  $("tab-new").addEventListener("click", () => {
    const inMonth = S.today.slice(0, 7) === dateKey(S.y, S.m, 1).slice(0, 7);
    openForm(null, inMonth ? S.today : dateKey(S.y, S.m, 1));
  });
  $("tab-settings").addEventListener("click", () => { settingsFold = { labels: false, calview: false, share: false }; openSettings(); });
  // 折りたたみの開閉を覚える(toggle は泡立たないので、取り込みの段階で受ける)
  $("panel").addEventListener("toggle", (ev) => { const k = ev.target.dataset && ev.target.dataset.fold; if (k) settingsFold[k] = ev.target.open; }, true);
  $("tab-todo").addEventListener("click", () => extras.openTodo());
  $("tab-stamp").addEventListener("click", () => extras.toggleStampMode());
  $("btn-imp").addEventListener("click", () => extras.openImportant());
  $("btn-gal").addEventListener("click", () => extras.openGallery());
  $("tray").addEventListener("click", (ev) => extras.trayClick(ev));
  $("viewer").addEventListener("click", closeViewer);
  extras.bindDrag();
  bindSheetSwipe();
  // 暗い背景を押したら閉じる。ただし、背景を押し始めた(pointerdown)ときだけ。
  // スタンプをタップして編集を開いた直後、同じタップの click が出てきた背景に当たり、開いてすぐ閉じていた
  $("scrim").addEventListener("pointerdown", () => { scrimDown = true; });
  $("scrim").addEventListener("click", () => { if (!scrimDown) return; scrimDown = false; closePanel(); });

  $("markbar").addEventListener("click", (ev) => { const a = ev.target.closest("[data-act]"); if (a) imager.act(a.dataset.act, a); });
  // 日を選んでいるあいだに、ほかの画面(予定の追加・設定・TODO・スタンプなど)を開くときは、選ぶのをやめる(選んだ日は残る)
  for (const id of ["tab-new", "tab-settings", "tab-todo", "tab-stamp", "btn-imp", "btn-gal"]) $(id).addEventListener("click", () => imager.end());

  $("banner").addEventListener("click", (ev) => { if (ev.target.closest('[data-act="dismiss-notice"]')) setNotice(""); });
  $("chips").addEventListener("click", (ev) => {
    if (ev.target.closest("[data-chip-stamps]")) {
      setStampsOff(!S.stampsOff);
      render();
      return;
    }
    const b = ev.target.closest("[data-chip]");
    if (!b) return;
    const id = b.dataset.chip;
    if (S.hidden.has(id)) S.hidden.delete(id); else S.hidden.add(id);
    storageSet(HIDDEN_KEY, JSON.stringify([...S.hidden]));
    render();
  });

  $("weeks").addEventListener("click", (ev) => {
    // 〇をつける日を選んでいるとき: タップした日に〇をつける・外す(帯やスタンプの上でも、その下の日)
    if (imager.isMarking()) {
      const c = extras.cellAt(ev.clientX, ev.clientY);
      if (c) imager.toggleDate(c.dataset.date);
      return;
    }
    // スタンプの画面: 帯やスタンプの上のタップも、その下のマスのタップとして受ける(M4)。スタンプを選んでいないときのスタンプのタップは、編集を開く(別に処理)
    if (extras.stampMode()) {
      if (ev.target.closest(".stamp") && !extras.hasPick()) return;
      const c = extras.cellAt(ev.clientX, ev.clientY);
      if (c) {
        const r = c.getBoundingClientRect();
        extras.cellTap(c.dataset.date, { x: (ev.clientX - r.left) / r.width, y: (ev.clientY - r.top) / r.height });
      }
      return;
    }
    const bar = ev.target.closest("[data-uid]");
    if (bar) return openEvent(bar.dataset.uid);
    const cell = ev.target.closest("[data-date]");
    if (cell) openDay(cell.dataset.date);
  });
  // 日を長押し(0.5秒)すると、その日の予定の追加を直接開く(タップは、これまでどおり、その日の予定の一覧)。
  // 指が動いた・スクロールが始まった・指を離したのどれかで取りやめる(スクロールが始まるとブラウザが pointercancel を出す)。
  // 〇をつける日を選んでいるとき・スタンプの画面・スタンプの上は、長押しにしない。
  // 長押しで開いたあとに続く click は、日の一覧が重ねて開かないように捨てる
  const LONG_PRESS_MS = 500, LONG_PRESS_MOVE = 10;
  let press = null, pressFired = 0;
  const pressCancel = () => { if (press) { clearTimeout(press.timer); press = null; } };
  $("weeks").addEventListener("pointerdown", (ev) => {
    pressCancel();
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    if (imager.isMarking() || extras.stampMode() || ev.target.closest(".stamp")) return;
    const c = extras.cellAt(ev.clientX, ev.clientY);
    if (!c) return;
    const date = c.dataset.date;
    press = {
      x: ev.clientX, y: ev.clientY,
      timer: setTimeout(() => {
        press = null;
        pressFired = Date.now();
        try { if (navigator.vibrate) navigator.vibrate(15); } catch (_) { /* 振動できなくても開く */ }
        openForm(null, date);
      }, LONG_PRESS_MS),
    };
  });
  $("weeks").addEventListener("pointermove", (ev) => {
    if (press && Math.hypot(ev.clientX - press.x, ev.clientY - press.y) > LONG_PRESS_MOVE) pressCancel();
  });
  $("weeks").addEventListener("pointerup", pressCancel);
  $("weeks").addEventListener("pointercancel", pressCancel);
  $("cal").addEventListener("scroll", pressCancel, { passive: true });
  $("weeks").addEventListener("click", (ev) => {
    if (Date.now() - pressFired < 1000) { pressFired = 0; ev.stopImmediatePropagation(); ev.preventDefault(); }
  }, true);
  // スマホの長押しで出る「コピー」などのメニュー(contextmenu)は、長押しの追加の邪魔なので出さない
  $("weeks").addEventListener("contextmenu", (ev) => { if (ev.pointerType !== "mouse" || Date.now() - pressFired < 1000) ev.preventDefault(); });

  $("weeks").addEventListener("keydown", (ev) => {
    if ((ev.key === "Enter" || ev.key === " ") && ev.target.dataset && ev.target.dataset.date) { ev.preventDefault(); if (imager.isMarking()) imager.toggleDate(ev.target.dataset.date); else openDay(ev.target.dataset.date); }
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    if (imager.isMarking()) return imager.end();
    if (!$("viewer").hidden) closeViewer(); else if (S.panel) closePanel();
  });

  $("panel").addEventListener("click", (ev) => {
    const inv = ev.target.closest("[data-share]");
    if (inv) return shareInviteClick(inv);
    const el = ev.target.closest("[data-act],[data-uid]");
    if (!el) return;
    const act = el.dataset.act;
    if (!act && el.dataset.uid) return openEvent(el.dataset.uid);
    if (act === "close") return closePanel();
    if (act === "new") return openForm(null, el.dataset.date);
    if (act === "edit") return openForm(S.byUid.get(el.dataset.uid), null, el.dataset.mode);
    if (act === "del") return deleteEvent(el.dataset.uid, el.dataset.mode);
    if (act === "save") return saveDraft();
    if (act === "copy") return openCopy(el.dataset.uid);
    if (act.startsWith("tp-")) return tplAction(act, el);
    if (act === "ann-toggle") return toggleAnnounce(el.dataset.uid);
    if (act === "ann-open") return openAnnItem(annList[Number(el.dataset.i)]);
    if (act === "copy-save") return saveCopy();
    if (act === "copy-back") { copyFrom = null; return openEvent(el.dataset.uid); }
    if (act === "cp-open" || act === "cp-cancel") return copyFormAct(act);
    if (act.startsWith("pk-")) return pickAct(act, el);
    if (act.startsWith("l-")) return settingsAction(act, el);
    if (act.startsWith("sh-")) return shareAction(act, el);
    if (act.startsWith("img-") || act.startsWith("mark-")) return imager.act(act, el);
    if (act === "ph-view") {
      const cap = el.dataset.exp ? `この写真は${Number(el.dataset.exp.slice(5, 7))}月${Number(el.dataset.exp.slice(8, 10))}日に消えます` : "";
      extras.urlFor(el.dataset.path).then((u) => openViewer(u || el.src, cap));
      return;
    }
    if (act === "ph-rm" && draft) { const p = draft.keep.find((x) => x.id === el.dataset.id); draft.keep = draft.keep.filter((x) => x.id !== el.dataset.id); if (p) draft.removed.push(p); return renderForm(); }
    if (act === "ph-rm-new" && draft) { const i = Number(el.dataset.i); const a = draft.added[i]; if (a) URL.revokeObjectURL(a.url); draft.added.splice(i, 1); return renderForm(); }
    extras.panelClick(el, act);
  });
  $("panel").addEventListener("keydown", (ev) => { extras.panelKey(ev); });
  $("panel").addEventListener("input", (ev) => {
    if (tpl && ev.target.dataset.tp && ev.target.type !== "checkbox") return readTplField(ev.target);
    if (draft && ev.target.dataset.f && ev.target.type !== "checkbox" && ev.target.tagName !== "SELECT") return readDraftField(ev.target);
    extras.panelInput(ev.target);
  });
  $("panel").addEventListener("change", (ev) => {
    const el = ev.target;
    if (draft && el.id === "f-photo") { addPhotos(el.files).then(() => { el.value = ""; }); return; }
    if (draft && el.dataset.f) return readDraftField(el);
    if (tpl && el.dataset.tp) return readTplField(el);
    if (el.dataset.lf) return labelFieldChanged(el);
    if (el.dataset.priv) {
      const on = el.checked;
      if (on && !window.confirm("このラベルと、このラベルの予定を、相手から見えなくします。よろしいですか？")) { el.checked = false; return; }
      labelUpdate(el.dataset.priv, { private_to: on ? S.userId : null }).then(async () => { await loadLabels(); setPanel(settingsHtml()); render(); })
        .catch((err) => { el.checked = !on; labelMsg(friendlyText(err.message || String(err))); });
      return;
    }
    if (el.dataset.shscope || el.dataset.mv) return shareFieldChanged(el);
    if (el.name === "theme") { storageSet(THEME_KEY, el.value); applyTheme(); return; }
    if (el.name === "appicon") { appIcon.choose(el.value); return; }
    if (el.dataset.cv) {
      saveCalView(el.dataset.cv, el.checked).then(() => { setPanel(settingsHtml()); render(); }).catch((err) => { el.checked = !el.checked; const m = $("cv-msg"); if (m) m.textContent = friendlyText(err.message || String(err)); });
      return;
    }
    extras.panelChange(el);
  });

  // 勤務入力などから戻ったときは、勤務の予定を読み直す(保存した内容を出すため)。入力中のパネルは触らない
  let hiddenAt = 0;
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "hidden") { hiddenAt = Date.now(); return; }
    const away = hiddenAt && Date.now() - hiddenAt >= 2000;
    hiddenAt = 0;
    S.today = todayJst();
    if (!away || S.panel) return;
    try { await reloadAll(); } catch (e) { fail(e); }
  });
  // 画面の大きさが変わったとき。幅が変わったときだけ、続けて起きる間引いて1回だけ描き直す(スマホはアドレスバーの出入り・キーボードで何度も起きる。高さだけの変化では、描き直さなくてよい)
  let lastW = window.innerWidth, resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (window.innerWidth !== lastW) { lastW = window.innerWidth; render(); } }, 150);
  });
}

async function main() {
  applyTheme();
  const session = await currentSession();
  if (!session) return go("index.html");
  const profile = await loadProfile(session);
  if (!profile) return go("index.html");
  if (profile.role === "admin") return go("admin.html");
  const settings = await loadSettings(session).catch(() => null);
  S.session = session;
  S.settingsRow = settings;
  S.cfg = resolveCalView(settings);
  try {
    const saved = JSON.parse(storageGet(HIDDEN_KEY) || "[]");
    if (Array.isArray(saved)) S.hidden = new Set(saved.filter((x) => typeof x === "string"));
  } catch (_) { /* 読めなければ全部表示 */ }
  S.stampsOff = storageGet(STAMPS_OFF_KEY) === "1";
  S.y = Number(S.today.slice(0, 4));
  S.m = Number(S.today.slice(5, 7));
  S.userId = session.user.id;
  extras = createExtras({
    S, $, esc, supabase, openPanel, setPanel, closePanel, openViewer, head, render, fail, friendlyText, selectAllPages, userId: session.user.id, isMarking: () => !!imager && imager.isMarking(),
    onImportantsChange: () => refreshAnn(),
    setStampsOff,
    onAnnField: (p, a) => { if (p === "f" && draft) draft.announce = a.announce; },
  });
  announcer = createAnnouncer({ el: $("ann"), esc, onOpen: openAnnItem, onList: openAnnList });
  imager = createImager({
    S, $, esc, eventsBetween, colorOf, barText, urlFor: (p) => extras.urlFor(p), ensureMonth: ensureMonthLoaded, openSettings, setNotice,
    render, setPanel, settingsHtml, closePanel, stampOff: () => { if (extras.stampMode()) extras.toggleStampMode(false); },
  });
  bind();
  loadDots().catch(() => {});
  appIcon.loadRemote(supabase, esc); // 管理画面で足したアイコン(読めなくても、はじめから入っているものは使える)
  // 速く出すため、読み込みは一緒に始める。勤務の予定は、まず見える範囲(今の月と前の月)だけ1回で読み、残りは出したあとに読む
  let firstErr = null;
  const prev = addMonths(S.y, S.m, -1);
  const firstShifts = loadShiftsRange([prev, { y: S.y, m: S.m }]).catch((e) => { firstErr = e; });
  await Promise.all([loadLabels(), loadOwn(), extras.load(), loadTemplates(), loadPhotos().catch(() => {}), loadShare(), firstShifts]);
  $("boot").hidden = true;
  render();
  scrollToDate(S.today, 1); // 今日の週が、上から2段目に来る位置から
  const v = visibleMonth();
  S.y = v.y; S.m = v.m;
  updateHeader();
  if (firstErr) fail(firstErr);
  // 前後の月は、出したあとに読む(読めたら描き直す)
  ensureAround().then((loaded) => { if (loaded) render(); }).catch((e) => fail(e));
}

main().catch((e) => {
  const b = $("boot");
  b.hidden = false;
  b.className = "boot error";
  b.textContent = friendlyText(e && e.message ? e.message : String(e));
});
