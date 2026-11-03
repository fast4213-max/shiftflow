// shiftflowカレンダー(アプリ内のカレンダー)。設計は docs/mycalendar/DESIGN.md。
// 勤務の予定は、勤務の記録から Edge Function(calendar-shifts)が、勤務入力の設定どおりに組み立てて返す(Google には何も書かない・読まない)。
// 自分で作る予定・ラベルは、Supabase の cal_* の表(本人の行だけ・RLS)。
import { callFunction, currentSession, friendlyText, go, loadProfile, loadSettings, selectAllPages, supabase } from "../js/app.js?v=dev";
import { createExtras, shrinkForEvent } from "./cal-extra.js?v=dev";
import {
  addDays, addMonths, compareForDay, dateKey, diffDays, expandEvent, resolveCalView, gridRange, layoutWeek, monthIndex, monthLimits, oldestDate, photosClosed, textOn, todayJst, weekday, whenText, WEEKDAYS,
  yearsText,
} from "./cal-core.js?v=dev";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const HIDDEN_KEY = "shiftflow-cal-hidden";
const THEME_KEY = "shiftflow-cal-theme";
const FALLBACK = { duty: "#3b6fd4", off: "#e0553f", custom: "#6b7280" };
const REPEAT = { none: "なし", daily: "毎日", weekly: "毎週", monthly: "毎月", yearly: "毎年" };

const S = {
  labels: [],          // cal_labels(並び順)
  own: [],             // cal_events(自分で作る予定。画面用に整えたもの)
  shifts: new Map(),   // "年-月" → { events, loadedAt }(勤務の予定。月の画面の範囲ぶん)
  holidays: new Map(), // 日付 → 祝日の名前
  hidden: new Set(),   // 隠すラベルの id
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
};
let extras = null;

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

// カレンダーに出すもの(設定の「このカレンダーに出すもの」。自動のときは Google の設定から決める)。
// 出さないものは、ラベルのボタンも予定も出さない。非番は、チェックが無ければ勤務に含めて出す
const labelShown = (l) => l.kind === "duty" ? S.cfg.duty : l.kind === "off" ? S.cfg.off : l.kind === "offduty" ? S.cfg.offduty : true;
const visibleLabels = () => S.labels.filter(labelShown);
const groupShown = (g) => g === "off" ? S.cfg.off : g === "offduty" ? (S.cfg.offduty || S.cfg.duty) : S.cfg.duty;
const labelForGroup = (g) => {
  const duty = labelKind("duty");
  if (g === "off") return labelKind("off");
  if (g === "offduty") return S.cfg.offduty ? labelKind("offduty") || duty : duty;
  return duty;
};
const labelOf = (id) => S.labels.find((l) => l.id === id);
const labelKind = (kind) => S.labels.find((l) => l.kind === kind);
const colorOf = (id) => (labelOf(id) || {}).color || FALLBACK.custom;
const rankOf = (id) => { const i = S.labels.findIndex((l) => l.id === id); return i < 0 ? 99 : i; };

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
  if (!rows.length || ["duty", "off", "offduty"].some((k) => !rows.some((r) => r.kind === k))) {
    const { error } = await supabase.rpc("cal_ensure_default_labels");
    if (error) throw error;
    rows = await read();
  }
  S.labels = rows;
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

// 勤務の予定(月の画面の範囲)。同じ月は読み直さない(勤務入力から戻ったときは、cache を空にして読み直す)
async function loadShifts(y, m) {
  const key = `${y}-${m}`;
  const g = gridRange(y, m);
  const res = await callFunction("calendar-shifts", { from: g.from, to: g.to }, { timeoutMs: 40000 });
  for (const h of res.holidays || []) S.holidays.set(h.date, h.name);
  S.needOffice = !!res.needOffice;
  // どのラベルになるかは、画面に出すとき(eventsBetween)に決める(設定を変えても、読み直さなくてよいように)。
  // server の group が無いとき(古い版)は、休日かそれ以外かだけ
  const events = (res.shifts || []).map((e, i) => ({
    src: "shift", id: `s:${e.date}:${i}`, title: e.title, start: e.date, end: e.endDate, allDay: e.allDay,
    startTime: e.startTime, endTime: e.endTime, kind: e.kind || "", group: e.group || (e.calendar === "holiday" ? "off" : "duty"), memo: e.description || "", repeat: "none",
  }));
  S.shifts.set(key, { events });
}

async function reloadAll({ keepShifts = false } = {}) {
  if (!keepShifts) S.shifts.clear();
  // 設定で非番の時間用カレンダーを足した・外したあとに、反映する(読めなければ、今のまま)
  try { const st = await loadSettings(S.session); S.settingsRow = st; S.cfg = resolveCalView(st); } catch (_) { /* 今のまま */ }
  await Promise.all([loadLabels(), loadOwn(), extras.load()]);
  await loadPhotos().catch(() => {});
  await ensureAround();
  S.notice = ""; // 読み直しが成功したので、前の失敗の案内は消す(残ったままにならないように)
  render();
}

// 今の月の前後2か月ぶんの勤務の予定を読む(まだ読んでいない月だけ)。読めたら true
const loadingMonths = new Set();
async function ensureAround() {
  const lim = monthLimits(S.today);
  let loaded = false;
  const jobs = [];
  for (let k = -2; k <= 2; k++) {
    const t = addMonths(S.y, S.m, k);
    const idx = monthIndex(t.y, t.m);
    const key = `${t.y}-${t.m}`;
    if (idx < monthIndex(lim.min.y, lim.min.m) || idx > monthIndex(lim.max.y, lim.max.m) || S.shifts.has(key) || loadingMonths.has(key)) continue;
    loadingMonths.add(key);
    jobs.push(loadShifts(t.y, t.m).then(() => { loaded = true; }).finally(() => loadingMonths.delete(key)));
  }
  const results = await Promise.allSettled(jobs);
  const failed = results.find((r) => r.status === "rejected");
  if (failed) throw failed.reason;
  return loaded;
}

// ---------- 画面に出す予定 ----------

function eventsBetween(a, b) {
  const out = [];
  for (const e of S.own) for (const o of expandEvent(e, a, b)) out.push({ ...o, baseStart: e.start });
  const seen = new Set();
  for (const { events } of S.shifts.values()) {
    for (const e of events) {
      if (e.end < a || e.start > b || !groupShown(e.group)) continue;
      const label = labelForGroup(e.group);
      const labelId = label ? label.id : "";
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

// ---------- 描画: 月の画面 ----------

function renderChips() {
  const el = $("chips");
  el.innerHTML = visibleLabels().map((l) =>
    `<button class="chip${S.hidden.has(l.id) ? " off" : ""}" data-chip="${esc(l.id)}" style="--c:${esc(l.color)}" aria-pressed="${S.hidden.has(l.id) ? "false" : "true"}"><i></i>${esc(l.name)}</button>`).join("");
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
    const cls = ["cell", c === 0 ? "sun" : c === 6 ? "sat" : "", hol ? "hol" : "", d === S.today ? "tdy" : "", Number(d.slice(5, 7)) % 2 === 0 ? "alt" : ""].filter(Boolean).join(" ");
    const wd = WEEKDAYS[c];
    // 日付の横に祝日の名前(赤い小さな字)。例: 「3 文化の日」
    cells += `<div class="${cls}" data-date="${d}" role="button" tabindex="0" aria-label="${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日(${wd})${hol ? " " + esc(hol) : ""}"><span class="dtop"><span class="dn">${Number(d.slice(8, 10))}</span>${hol ? `<span class="hn">${esc(hol)}</span>` : ""}</span>${over[c] ? `<span class="more">+${over[c]}</span>` : ""}</div>`;
  }
  const barHtml = bars.map((b) => {
    const e = b.event;
    const col = colorOf(e.labelId);
    const cls = ["bar", b.cutLeft ? "cl" : "", b.cutRight ? "cr" : ""].filter(Boolean).join(" ");
    // 「時間」の帯(出勤・退勤の時間。名前が時間そのもの)は、名前だけ。時間を2回出さない
    const text = titleOf(e) + (e.allDay || !e.startTime || e.kind === "time" ? "" : ` ${e.startTime.replace(/^0/, "")}`);
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

function showPanel(onClose) {
  if (S.panel) { if (onClose !== undefined) S.panel.onClose = onClose; return; }
  $("panel").hidden = false;
  $("scrim").hidden = false;
  S.panel = { onClose };
  pushLayer(hidePanel);
}
function hidePanel() {
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
  if (e.src === "shift") {
    actions = '<p class="sub">勤務の予定は、勤務入力で直します。</p><div class="btns"><a class="btn" href="../input.html">勤務入力を開く</a></div>';
  } else if (e.repeat && e.repeat !== "none") {
    actions = `<div class="btns"><button class="btn" data-act="edit" data-uid="${esc(uid)}" data-mode="occ">この回だけ編集</button><button class="btn" data-act="edit" data-uid="${esc(uid)}" data-mode="all">すべての回を編集</button></div>
      <div class="btns"><button class="btn dng" data-act="del" data-uid="${esc(uid)}" data-mode="occ">この回だけ削除</button><button class="btn dng" data-act="del" data-uid="${esc(uid)}" data-mode="all">すべての回を削除</button></div>`;
  } else {
    actions = `<div class="btns"><button class="btn" data-act="edit" data-uid="${esc(uid)}" data-mode="all">編集</button><button class="btn dng" data-act="del" data-uid="${esc(uid)}" data-mode="all">削除</button></div>`;
  }
  openPanel(`${head(e.title || "（タイトルなし）")}<div class="pb">
    <p class="sub">${esc(whenText(e))}</p>
    ${label ? `<p><span class="chip" style="--c:${esc(colorOf(e.labelId))}"><i></i>${esc(label.name)}</span></p>` : ""}
    ${rep ? `<p class="sub">繰り返し: ${esc(rep)}</p>` : ""}${yearsText(e) ? `<p class="sub">${esc(yearsText(e))}</p>` : ""}
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
        repeat: useOcc ? "none" : base.repeat, until: useOcc ? "" : base.until, yearsLabel: base.yearsLabel,
      }
    : {
        id: null, mode: "new", title: "", labelId: labels[0] ? labels[0].id : "", start: defaultDate, end: defaultDate, allDay: true,
        startTime: "09:00", endTime: "10:00", memo: "", repeat: "none", until: "", yearsLabel: "",
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
  $("panel").innerHTML = `${head(title)}<div class="pb">
    <div class="fld"><label class="lb" for="f-title">タイトル</label><input class="in" id="f-title" data-f="title" maxlength="100" value="${esc(d.title)}" autocomplete="off"></div>
    <div class="fld"><label class="lb" for="f-label">ラベル</label><select class="in" id="f-label" data-f="labelId">${labels.map((l) => `<option value="${esc(l.id)}"${d.labelId === l.id ? " selected" : ""}>${esc(l.name)}</option>`).join("")}</select></div>
    <div class="row2"><div class="fld"><label class="lb" for="f-start">開始日</label><input class="in" type="date" id="f-start" data-f="start" value="${esc(d.start)}"></div><div class="fld"><label class="lb" for="f-end">終了日</label><input class="in" type="date" id="f-end" data-f="end" value="${esc(d.end)}"></div></div>
    <div class="fld"><label class="tg"><input type="checkbox" id="f-allday" data-f="allDay"${d.allDay ? " checked" : ""}> 終日</label></div>
    ${time}${rep}
    <div class="fld"><label class="lb" for="f-memo">メモ</label><textarea class="in" id="f-memo" data-f="memo" maxlength="1000">${esc(d.memo)}</textarea></div>
    <div id="photo-block">${photosFormHtml(d)}</div>
    <p class="msg err" id="form-msg">${esc(message)}</p>
    <div class="btns"><button class="btn pri" data-act="save" id="f-save">保存</button><button class="btn" data-act="close">やめる</button></div></div>`;
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
    refreshPhotoBlock(); // 日付を変えると、写真を付けられるか(期限)が変わる。入力中の欄は作り直さず、写真の欄だけ入れ替える
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
  repeat_rule: d.repeat, repeat_until: d.repeat !== "none" && d.until ? d.until : null, years_label: d.repeat === "yearly" ? d.yearsLabel || "" : "", ...over,
});

async function saveDraft() {
  const d = draft;
  const err = draftError(d);
  if (err) return renderForm(err);
  $("f-save").disabled = true;
  let eventId = d.id;
  try {
    if (d.mode === "new") {
      const { data, error } = await supabase.from("cal_events").insert(rowFromDraft(d)).select().single();
      if (error) throw error;
      eventId = data.id;
    } else if (d.mode === "all") {
      const { data, error } = await supabase.from("cal_events").update(rowFromDraft(d)).eq("id", d.id).eq("version", d.version).select();
      if (error) throw error;
      if (!data || !data.length) { await reloadAll(); return renderForm("別の端末で変更されたか、消されています。読み直しました。もう一度直してください。"); }
    } else {
      // この回だけ: 元の予定からこの日を外し、変えた内容を1回だけの予定として作る
      const ex = [...new Set([...(d.exdates || []), d.occ])];
      const upd = await supabase.from("cal_events").update({ exdates: ex }).eq("id", d.id).eq("version", d.version).select();
      if (upd.error) throw upd.error;
      if (!upd.data || !upd.data.length) { await reloadAll(); return renderForm("別の端末で変更されたか、消されています。読み直しました。もう一度直してください。"); }
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
    await reloadAll({ keepShifts: true });
    closePanel();
    if (fails.length) setNotice(`予定は保存しました。写真${fails.length}件は保存できませんでした(${esc(fails[0])})。予定を開いて、もう一度付けてください。`);
  } catch (e) {
    renderForm(friendlyText(e.message || String(e)));
  }
}

async function deleteEvent(uid, mode) {
  const e = S.byUid.get(uid);
  if (!e || e.src !== "own") return;
  const base = S.own.find((x) => x.id === (e.baseId || e.id));
  if (!base) return;
  const repeating = base.repeat !== "none";
  const text = mode === "occ" ? "この回だけ" : repeating ? "すべての回" : "この予定";
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

// ---------- 設定 ----------

// 自分が使っている写真・画像の量(保存してある大きさの合計)
function usageText() {
  let photos = 0, photoBytes = 0;
  for (const list of S.photos.values()) for (const p of list) { photos++; photoBytes += Number(p.size_bytes) || 0; }
  const galleryBytes = S.gallery.reduce((n, g) => n + (Number(g.size_bytes) || 0), 0);
  const mb = (b) => (b < 104858 ? "0.1MB未満" : `${Math.round((b / 1048576) * 10) / 10}MB`);
  return `約 ${mb(photoBytes + galleryBytes)}(画像の置き場 ${S.gallery.length}/10枚・予定の写真 ${photos}枚)`;
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
    </div>`).join("");
  const customCount = S.labels.filter((l) => l.kind === "custom").length;
  return (`${head("設定")}<div class="pb">
    <div class="card" id="about"><h3>shiftflowカレンダーについて</h3>
      <ul>
        <li><b>できること</b>: 勤務入力で保存した勤務と、自分で作る予定を、月の画面で見られます。</li>
        <li><b>勤務の予定</b>は、勤務入力で直します(ここからは直せません)。名前や時間の付き方は、勤務入力の設定どおりです。</li>
        <li><b>上のラベルのボタン</b>を押すと、そのラベルの予定が消えます。もう一度押すと戻ります。色と並び順は、下の「ラベル」で決めます。</li>
        <li><b>時刻</b>は分単位で入れられます。日をまたぐ予定は、終了日を次の日にします。</li>
        <li><b>見返せる期間</b>は、過去1年までです。予定の写真は、予定が終わって1か月で消えます(1つの予定に3枚まで)。</li>
        <li><b>1つのアカウントで1人分</b>のカレンダーです。家族に見せたいときは、このアプリのURLを教えて、その人が自分のアカウントでログインして使うか、勤務をGoogleカレンダーに登録して共有します。</li>
        <li>ホーム画面に追加すると、アプリのように開けます。最初に1回、社員番号とPINでログインします。</li>
        <li>画面の色合いは、この設定の一番下で変えられます。</li>
      </ul></div>
    <div class="card" id="calview"><h3>このカレンダーに出すもの</h3>
      <label class="tg"><input type="checkbox" data-cv="cal_show_duty" id="cv-duty"${S.cfg.duty ? " checked" : ""}> 勤務</label>
      <label class="tg"><input type="checkbox" data-cv="cal_show_off" id="cv-off"${S.cfg.off ? " checked" : ""}> 休日</label>
      <label class="tg"><input type="checkbox" data-cv="cal_offduty_label" id="cv-offduty"${S.cfg.offduty ? " checked" : ""}> 非番の時間を別のボタンにする</label>
      <p class="sub">チェックを外したものは、このカレンダーに出ません(ボタンも出ません)。Googleカレンダーに登録している人で、休日用のカレンダーを作っていない人は、休日が外れた状態から始まります。非番は、「非番を2段で出す」設定のとき、「〜」の下に出る退勤時間の帯が、別のボタン・別の色になります(外すと、勤務に含めて出します)。</p>
      <p class="msg err" id="cv-msg"></p></div>
    <div class="card"><h3>ラベル</h3><p class="sub">名前と色、並び順を決めます。自分で作れるのは10個までです。勤務・休日・非番のラベルは、勤務の予定の色です(非番は、「〜」とその時間。設定で非番の時間用カレンダーを使っている人だけに出ます)。</p>
      ${labelRows}
      <div class="lrow"><input type="color" id="nl-color" value="#8e44ad" aria-label="新しいラベルの色"><input class="in" id="nl-name" maxlength="20" placeholder="新しいラベルの名前" aria-label="新しいラベルの名前"><button class="btn sm pri" data-act="l-add"${customCount >= 10 ? " disabled" : ""}>追加</button></div>
      <p class="msg err" id="label-msg"></p></div>
    <div class="card" id="my-usage"><h3>あなたの写真・画像の量</h3><p>${esc(usageText())}</p><p class="sub">画像の置き場は1人10枚まで、予定の写真は1つの予定に3枚までです。写真は予定が終わって1か月で消えます。</p></div>
    <div class="card"><h3>画面の色合い</h3><div class="seg" role="radiogroup">
      ${[["auto", "自動"], ["light", "ライト"], ["dark", "ダーク"]].map(([v, t]) => `<label><input type="radio" name="theme" value="${v}"${theme === v ? " checked" : ""}><span>${t}</span></label>`).join("")}
    </div><p class="sub">「自動」は、端末のダークモードの設定に合わせます。この端末だけの設定です。</p></div>
  </div>`);
}
function openSettings() { openPanel(settingsHtml()); }

// カレンダーに出すもの(勤務・休日・非番): 保存して、すぐ反映する
async function saveCalView(col, value) {
  const { error } = await supabase.from("user_settings").upsert({ user_id: S.userId, [col]: value }, { onConflict: "user_id" });
  if (error) throw error;
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
      await loadLabels();
    } else if (act === "l-add") {
      const name = $("nl-name").value.trim();
      if (!name) return labelMsg("名前を入れてください。");
      const { error } = await supabase.from("cal_labels").insert({ name, color: $("nl-color").value, sort: S.labels.length + 1 });
      if (error) return labelMsg(friendlyText(error.message));
      await loadLabels();
    }
    openSettings();
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
  $("tab-settings").addEventListener("click", openSettings);
  $("tab-todo").addEventListener("click", () => extras.openTodo());
  $("tab-stamp").addEventListener("click", () => extras.toggleStampMode());
  $("btn-imp").addEventListener("click", () => extras.openImportant());
  $("btn-gal").addEventListener("click", () => extras.openGallery());
  $("tray").addEventListener("click", (ev) => extras.trayClick(ev));
  $("viewer").addEventListener("click", closeViewer);
  extras.bindDrag();
  $("scrim").addEventListener("click", closePanel);

  $("banner").addEventListener("click", (ev) => { if (ev.target.closest('[data-act="dismiss-notice"]')) setNotice(""); });
  $("chips").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-chip]");
    if (!b) return;
    const id = b.dataset.chip;
    if (S.hidden.has(id)) S.hidden.delete(id); else S.hidden.add(id);
    storageSet(HIDDEN_KEY, JSON.stringify([...S.hidden]));
    render();
  });

  $("weeks").addEventListener("click", (ev) => {
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
  $("weeks").addEventListener("keydown", (ev) => {
    if ((ev.key === "Enter" || ev.key === " ") && ev.target.dataset && ev.target.dataset.date) { ev.preventDefault(); openDay(ev.target.dataset.date); }
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    if (!$("viewer").hidden) closeViewer(); else if (S.panel) closePanel();
  });

  $("panel").addEventListener("click", (ev) => {
    const el = ev.target.closest("[data-act],[data-uid]");
    if (!el) return;
    const act = el.dataset.act;
    if (!act && el.dataset.uid) return openEvent(el.dataset.uid);
    if (act === "close") return closePanel();
    if (act === "new") return openForm(null, el.dataset.date);
    if (act === "edit") return openForm(S.byUid.get(el.dataset.uid), null, el.dataset.mode);
    if (act === "del") return deleteEvent(el.dataset.uid, el.dataset.mode);
    if (act === "save") return saveDraft();
    if (act.startsWith("l-")) return settingsAction(act, el);
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
    if (draft && ev.target.dataset.f && ev.target.type !== "checkbox" && ev.target.tagName !== "SELECT") return readDraftField(ev.target);
    extras.panelInput(ev.target);
  });
  $("panel").addEventListener("change", (ev) => {
    const el = ev.target;
    if (draft && el.id === "f-photo") { addPhotos(el.files).then(() => { el.value = ""; }); return; }
    if (draft && el.dataset.f) return readDraftField(el);
    if (el.dataset.lf) return labelFieldChanged(el);
    if (el.name === "theme") { storageSet(THEME_KEY, el.value); applyTheme(); return; }
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
  window.addEventListener("resize", () => render());
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
  S.y = Number(S.today.slice(0, 4));
  S.m = Number(S.today.slice(5, 7));
  S.userId = session.user.id;
  extras = createExtras({ S, $, esc, supabase, openPanel, setPanel, closePanel, openViewer, head, render, fail, friendlyText, selectAllPages, userId: session.user.id });
  bind();
  await Promise.all([loadLabels(), loadOwn(), extras.load()]);
  await loadPhotos().catch(() => {});
  $("boot").hidden = true;
  render();
  scrollToDate(S.today, 1); // 今日の週が、上から2段目に来る位置から
  const v = visibleMonth();
  S.y = v.y; S.m = v.m;
  updateHeader();
  try { await ensureAround(); render(); } catch (e) { fail(e); }
}

main().catch((e) => {
  const b = $("boot");
  b.hidden = false;
  b.className = "boot error";
  b.textContent = friendlyText(e && e.message ? e.message : String(e));
});
