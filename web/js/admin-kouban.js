// 管理画面「マスタ」: 交番表(天王寺車掌区の区所だけ)。切替日ごとに JSON を入れる・消す・保存する。設計は docs/kouban/DESIGN.md
import { $, friendlyText, supabase } from "./app.js?v=dev";
import { readTextFile } from "./csv.js?v=dev";
import { KOUBAN_OFFICE_WORD, officeHasKouban, parseKouban } from "./kouban.js?v=dev";

let target = null;   // { office, period, others: [{ office, period }] }
let current = null;  // 表示中の切替日の交番表 { data, updated_at } か null
let loadId = 0;

function setMessage(text, kind) {
  $("kouban-admin-message").textContent = friendlyText(text) || "";
  $("kouban-admin-message").className = "message" + (kind ? " " + kind : "");
}

// 「30行・名前の欄7(特急1・…)・30日ごと(1列目 2026-10-01)・行路の組 特1・特2・休み 特→特休」
export function koubanSummary(t) {
  return t.cells.length + "行・名前の欄" + t.cols.length + "(" + t.cols.map((c) => c.label).join("・") + ")・" + t.days + "日ごと(1列目 " + t.start + ")・" +
    "行路の組 " + Object.keys(t.routes).join("・") + "・休み " + Object.entries(t.off).map(([k, v]) => k + "→" + v).join("・");
}

function renderState() {
  if (!target) return;
  const { period } = target;
  if (current === undefined) {
    $("kouban-admin-state").textContent = "読み込み中…";
  } else if (!current) {
    $("kouban-admin-state").textContent = "この切替日(" + period.from + "〜)の交番表: まだありません。";
  } else {
    let summary;
    try {
      summary = koubanSummary(parseKouban(JSON.stringify(current.data)));
    } catch (err) {
      summary = "形がおかしい(" + err.message + ")。入れ直してください";
    }
    $("kouban-admin-state").textContent = "この切替日(" + period.from + "〜)の交番表: " + summary + "。";
  }
  $("kouban-admin-download").disabled = !current;
  $("kouban-admin-delete").disabled = !current;
  const n = target.others.length;
  $("kouban-admin-all-label").hidden = n === 0;
  $("kouban-admin-all-text").textContent = "同じ切替日の、名前に「" + KOUBAN_OFFICE_WORD + "」を含むほかの区所(" +
    target.others.map((o) => o.office.name).join("・") + ")にも入れる・消す";
}

// renderMasterPane から呼ぶ。office: 選んでいる区所、period: 選んでいる切替日({ id, from, name } か null)、
// others: 同じ切替日の、ほかの天王寺車掌区の区所 [{ office, period }]
export function renderKoubanAdmin(office, period, others) {
  const show = !!office && !!period && officeHasKouban(office.name);
  $("kouban-admin").hidden = !show;
  if (!show) {
    target = null;
    return;
  }
  const same = target && target.period.id === period.id;
  target = { office, period, others };
  if (!same) {
    $("kouban-admin-text").value = "";
    $("kouban-admin-file").value = "";
    $("kouban-admin-all").checked = true;
    setMessage("");
    load();
  }
  renderState();
}

async function load() {
  const id = ++loadId;
  current = undefined;
  renderState();
  const { data, error } = await supabase.from("kouban_tables").select("data, updated_at").eq("period_id", target.period.id).maybeSingle();
  if (id !== loadId) return;
  if (error) {
    current = null;
    setMessage(error.message, "error");
  } else {
    current = data || null;
  }
  renderState();
}

function periodIds() {
  return [target.period.id, ...($("kouban-admin-all").checked ? target.others.map((o) => o.period.id) : [])];
}

$("kouban-admin-file").addEventListener("change", async () => {
  const file = $("kouban-admin-file").files[0];
  if (!file) return;
  try {
    $("kouban-admin-text").value = await readTextFile(file);
  } catch (err) {
    setMessage(err.message, "error");
  }
});

$("kouban-admin-apply").addEventListener("click", async () => {
  if (!target) return;
  let table;
  try {
    table = parseKouban($("kouban-admin-text").value);
  } catch (err) {
    setMessage(err.message, "error");
    return;
  }
  const ids = periodIds();
  const where = [target.office.name, ...($("kouban-admin-all").checked ? target.others.map((o) => o.office.name) : [])].join("・");
  if (!confirm(where + " の「" + target.period.from + "〜」の交番表を、この内容で入れ替えます。\n" + koubanSummary(table) +
    "\n(名前は入っていませんか。名前は入れないでください)\nよろしいですか？")) return;
  $("kouban-admin-apply").disabled = true;
  const { data, error } = await supabase.rpc("save_kouban", { p_period_ids: ids, p_data: table });
  $("kouban-admin-apply").disabled = false;
  if (error) return setMessage(error.message, "error");
  $("kouban-admin-text").value = "";
  $("kouban-admin-file").value = "";
  setMessage(data + "区所に交番表を入れました。", "ok");
  load();
});

$("kouban-admin-delete").addEventListener("click", async () => {
  if (!target || !current) return;
  if (!confirm("「" + target.period.from + "〜」の交番表を消しますか？(利用者の勤務入力の「交番表」が、この切替日から後の日に使えなくなります)")) return;
  const { data, error } = await supabase.rpc("delete_kouban", { p_period_ids: periodIds() });
  if (error) return setMessage(error.message, "error");
  setMessage(data + "区所の交番表を消しました。", "ok");
  load();
});

$("kouban-admin-download").addEventListener("click", () => {
  if (!target || !current) return;
  const blob = new Blob([JSON.stringify(current.data)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "kouban_" + target.office.name + "_" + target.period.from + ".json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
