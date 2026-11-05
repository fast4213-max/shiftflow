// 画面の確かめ(Chromium)。Supabase は偽物(page.route)。本番には接続しない。
// 使い方: docs/contact/test/README.md(Playwright が必要。画像は fixtures/、画面の画像は shots/ に出る)
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import assert from "node:assert/strict";

const DIR = new URL("./fixtures/", import.meta.url).pathname;
const WEB = new URL("../../../web/", import.meta.url).pathname;
const PORT = 8123;
const BASE = `http://127.0.0.1:${PORT}`;
const SB = "https://owotkyocoslifbgwwafm.supabase.co";
const OUT = process.env.SHOTS_DIR || new URL("./shots/", import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });

const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], { cwd: WEB, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch();

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function session(userId) {
  const exp = Math.floor(Date.now() / 1000) + 3600 * 24;
  const token = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub: userId, exp, role: "authenticated", session_id: "s1" })}.sig`;
  return { access_token: token, refresh_token: "r", expires_at: exp, expires_in: 86400, token_type: "bearer", user: { id: userId, aud: "authenticated", role: "authenticated", email: "x@users.shiftflow.invalid" } };
}

const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const NOTICES = [
  { id: 1, title: "システムメンテナンスのお知らせ", body: "10/12(日) 2:00〜4:00 は登録できません。\n終わったあとは、いつもどおり使えます。" + "長い説明".repeat(30), level: "important", starts_on: today, updated_at: "2026-10-06T00:00:00Z" },
  { id: 2, title: "11月のマスタを更新しました", body: "", level: "info", starts_on: today, updated_at: "2026-10-06T00:00:00Z" },
  { id: 3, title: "<img src=x onerror=alert(1)>タグは文字のまま", body: "<b>太字にならない</b>", level: "info", starts_on: today, updated_at: "2026-10-06T00:00:00Z" },
  { id: 4, title: "4件目(ログイン画面には出ない)", body: "", level: "info", starts_on: today, updated_at: "2026-10-06T00:00:00Z" },
];

// 偽の Supabase
function backend(opts = {}) {
  const st = { cal: { cal_labels: [], cal_events: [] }, calSeq: 0, uploads: [], removed: [], calls: [], inquiries: [], notices: [...NOTICES], nextNotice: 10,
    guides: (opts.guides || []).map((g, i) => ({ id: i + 1, kind: "video", visible: true, sort_order: i + 1, ...g })), nextGuide: 100,
    appIcons: (opts.appIcons || []).map((x, i) => ({ id: i + 1, visible: true, sort_order: i + 1, ...x })), nextAppIcon: 100, iconUploads: [], iconRemoved: [],
    offices: [{ id: 1, name: "A区所", sort_order: 1 }, { id: 2, name: "B区所", sort_order: 2 }, { id: 3, name: "C区所", sort_order: 3 }] };
  const handler = async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const body = req.postData() ? (() => { try { return JSON.parse(req.postData()); } catch { return req.postData(); } })() : null;
    st.calls.push({ path, method: req.method(), body, auth: req.headers()["authorization"], search: url.search });
    const json = (data, status = 200) => route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(data) });
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
    if (path === "/rest/v1/rpc/current_notices") {
      if (opts.noticesFail) return json({ message: "boom" }, 500);
      if (opts.noticesDelay) await new Promise((r) => setTimeout(r, opts.noticesDelay));
      return json(st.notices);
    }
    if (path === "/rest/v1/rpc/contact_offices") {
      if (opts.officesDelay) await new Promise((r) => setTimeout(r, opts.officesDelay));
      return opts.officesFail ? json({ message: "x" }, 500) : json(["A区所", "B区所"]);
    }
    if (path === "/rest/v1/profiles" && opts.profileAbort) return route.abort("failed");
    if (path === "/rest/v1/profiles") return json(opts.profile ? [opts.profile] : []);
    if (path === "/rest/v1/user_settings" && opts.noSettingsRow) {
      // 画面を開いたときは行が無く、保存(POST)は「もうできていた」の重複(R3)。そのあとの更新(PATCH)は通る
      if (req.method() === "POST") return json({ code: "23505", message: 'duplicate key value violates unique constraint "user_settings_pkey"' }, 409);
      if (req.method() === "PATCH") return json({ office_id: 1, work_calendar_id: "w", holiday_calendar_id: null, verified_at: null, ...body });
      return json([]);
    }
    if (path === "/rest/v1/user_settings") {
      st.settingsPatch = st.settingsPatch || {};
      const row = { office_id: 1, work_calendar_id: "w", holiday_calendar_id: null, verified_at: "2026-10-01", split_day_events: false, ...opts.settings, ...st.settingsPatch };
      // 保存(PATCH)は、送った値を足した行を返す(.single() なので1件だけ)
      if (req.method() === "PATCH") {
        // カレンダーの「出すもの」の保存(update): 送った値を覚えて、次に読むときに返す
        for (const k of Object.keys(body || {})) if (k.startsWith("cal_") || k === "kouban") st.settingsPatch[k] = body[k];
        return json({ ...row, ...body, verified_at: null });
      }
      if (req.method() === "POST" && body && body.user_id) {
        // 本物は、利用者が user_id を書き換える権限を持たないので、upsert(merge-duplicates)は「permission denied」になる
        if (/merge-duplicates/.test(req.headers()["prefer"] || "")) return json({ message: "permission denied for table user_settings", code: "42501" }, 403);
        Object.assign(st.settingsPatch, body); return json([{ ...row, ...body }], 201);
      }
      return json([row]);
    }
    // shiftflowカレンダー: 勤務の予定を組み立てる関数と、cal_* の表(メモリの中だけの偽物)
    if (path === "/functions/v1/calendar-shifts") {
      if (opts.shiftsFail) return json({ error: "勤務の予定を読めませんでした。" }, 500);
      return json({ shifts: opts.shifts || [], holidays: opts.calHolidays || [], needOffice: !!opts.needOffice });
    }
    if (path === "/rest/v1/rpc/cal_ensure_default_labels") {
      if (!st.cal.cal_labels.length) {
        for (const [kind, name, color, sort] of [["duty", "勤務", "#3b6fd4", 1], ["off", "休日", "#e0553f", 2], ["offduty", "非番", "#d4607a", 2], ["custom", "その他", "#6b7280", 3]]) {
          st.cal.cal_labels.push({ id: "L" + ++st.calSeq, user_id: "u1", kind, name, color, sort, created_at: "2026-11-02T00:00:00Z" });
        }
      } else if (!st.cal.cal_labels.some((l) => l.kind === "offduty")) {
        // 今の利用者(勤務・休日・その他だけ)には、非番だけが足される
        st.cal.cal_labels.push({ id: "L" + ++st.calSeq, user_id: "u1", kind: "offduty", name: "非番", color: "#d4607a", sort: 2, created_at: "2026-11-03T00:00:00Z" });
      }
      return json(null, 204);
    }
    // Storage の偽物(calendar バケット): 入れる・期限つき URL・読む(1ドットの画像)・消す
    if (path.startsWith("/storage/v1/object/")) {
      const rest = path.slice("/storage/v1/object/".length);
      if (rest.startsWith("sign/calendar") && req.method() === "POST") {
        const paths = body && body.paths ? body.paths : [rest.slice("sign/calendar/".length)];
        const list = paths.map((p) => ({ error: null, path: p, signedURL: `/object/sign/calendar/${p}?token=t` }));
        return json(body && body.paths ? list : list[0]);
      }
      if (rest.startsWith("sign/calendar/") && req.method() === "GET") {
        return route.fulfill({ status: 200, contentType: "image/png", headers: { "access-control-allow-origin": "*" }, body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64") });
      }
      if (rest.startsWith("calendar") && req.method() === "DELETE") {
        st.removed.push(...((body && body.prefixes) || []));
        return json([]);
      }
      // アイコンの置き場(公開): 入れる・消す・公開の URL で読む(1ドットの画像)
      if (rest.startsWith("public/app-icons/") && req.method() === "GET") {
        if ((opts.iconMissing || []).includes(Number(rest.split("/")[2]))) return route.fulfill({ status: 404, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: "{}" });
        return route.fulfill({ status: 200, contentType: "image/png", headers: { "access-control-allow-origin": "*" }, body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64") });
      }
      if (rest.startsWith("app-icons") && req.method() === "DELETE") {
        st.iconRemoved.push(...((body && body.prefixes) || []));
        return json([]);
      }
      if (rest.startsWith("app-icons/") && (req.method() === "POST" || req.method() === "PUT")) {
        if (opts.iconUploadFail && rest.endsWith("/192.png")) return json({ message: "upload failed" }, 500);
        const buf = req.postDataBuffer() || Buffer.alloc(0);
        st.iconUploads.push({ path: rest.slice("app-icons/".length), size: buf.length, head: buf.subarray(0, 400).toString("latin1") });
        return json({ Key: rest, Id: "x" });
      }
      if (rest.startsWith("calendar/") && (req.method() === "POST" || req.method() === "PUT")) {
        const buf = req.postDataBuffer() || Buffer.alloc(0);
        st.uploads.push({ path: rest.slice("calendar/".length), size: buf.length, head: buf.subarray(0, 400).toString("latin1") });
        return json({ Key: "calendar/" + rest.slice("calendar/".length), Id: "x" });
      }
    }
    if (path.startsWith("/rest/v1/cal_")) {
      const table = path.slice("/rest/v1/".length);
      const rows = st.cal[table] || (st.cal[table] = []);
      const filters = [...url.searchParams.entries()].filter(([, v]) => v.startsWith("eq.")).map(([k, v]) => [k, v.slice(3)]);
      const inFilters = [...url.searchParams.entries()].filter(([, v]) => v.startsWith("in.(")).map(([k, v]) => [k, v.slice(4, -1).split(",")]);
      const match = (r) => filters.every(([k, v]) => String(r[k]) === v) && inFilters.every(([k, list]) => list.includes(String(r[k])));
      const wantObject = (req.headers()["accept"] || "").includes("vnd.pgrst.object");
      const rep = (list) => json(wantObject ? list[0] ?? null : list);
      if (req.method() === "GET") return rep(rows.filter(match).sort((a, b) => (a.sort || 0) - (b.sort || 0)));
      if (req.method() === "POST") {
        const list = Array.isArray(body) ? body : [body];
        const made = list.map((b) => {
          const row = { id: "R" + ++st.calSeq, user_id: "u1", created_at: "2026-11-02T00:00:00Z", ...b };
          if (table === "cal_labels") Object.assign(row, { kind: "custom", ...b });
          if (table === "cal_todos") Object.assign(row, { done: false, ...b });
          if (table === "cal_stamps") Object.assign(row, { rotation: 0, notes: [], ...b });
          if (table === "cal_gallery") Object.assign(row, { title: "", ...b });
          if (table === "cal_importants") Object.assign(row, { body: "", ...b });
          if (table === "cal_photos") {
            // DB のトリガーと同じ: 消す日は、繰り返しでない予定の終了日の1か月後(繰り返しは消さない)
            const ev = st.cal.cal_events.find((e) => e.id === b.event_id);
            const [yy, mm, dd] = ev ? ev.end_date.split("-").map(Number) : [0, 0, 0];
            const last = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
            row.expires_on = ev && ev.repeat_rule === "none" ? new Date(Date.UTC(yy, mm, Math.min(dd, last))).toISOString().slice(0, 10) : null;
          }
          if (table === "cal_events") Object.assign(row, { exdates: [], repeat_rule: "none", memo: "", start_time: "", end_time: "", repeat_until: null, years_label: "", ...b, version: 1 });
          rows.push(row);
          return row;
        });
        return json(wantObject ? made[0] : made, 201);
      }
      if (req.method() === "PATCH") {
        const hit = rows.filter(match);
        hit.forEach((r) => { Object.assign(r, body); if (table === "cal_events") r.version += 1; });
        return rep(hit);
      }
      if (req.method() === "DELETE") {
        if (table === "cal_labels" && filters.some(([k, v]) => k === "id" && st.cal.cal_events.some((e) => e.label_id === v))) {
          return json({ code: "23503", message: 'update or delete on table "cal_labels" violates foreign key constraint' }, 409);
        }
        const gone = rows.filter(match);
        const keep = rows.filter((r) => !match(r));
        rows.length = 0;
        rows.push(...keep);
        // 外部キーの「消したら一緒に消える」(スタンプの種類 → 置いたスタンプ)
        // 予定を消すと、写真の行も一緒に消える
        if (table === "cal_events") st.cal.cal_photos = (st.cal.cal_photos || []).filter((x) => !gone.some((g) => g.id === x.event_id));
        if (table === "cal_stamp_defs") st.cal.cal_stamps = (st.cal.cal_stamps || []).filter((x) => !gone.some((g) => g.id === x.stamp_def_id));
        return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } });
      }
    }
    if (path === "/functions/v1/verify-calendar") return json({ ok: true });
    if (path === "/rest/v1/offices" && opts.twoOffices) {
      // 区所の並び替え(Y1・Y5): sort_order を持つ偽物。PATCH は opts.officeDelay だけ遅らせ、opts.officeFailId の行は失敗させる
      if (req.method() === "PATCH") {
        if (opts.officeDelay) await new Promise((r) => setTimeout(r, opts.officeDelay));
        const id = Number(url.searchParams.get("id").replace("eq.", ""));
        if (id === opts.officeFailId) return json({ message: "boom" }, 500);
        const o = st.offices.find((x) => x.id === id);
        if (o) Object.assign(o, body);
        return json(null, 204);
      }
      if (req.method() === "POST") {
        st.offices.push({ id: st.offices.length + 10, ...body });
        return json(null, 201);
      }
      const sorted = [...st.offices].sort((a, b) => a.sort_order - b.sort_order);
      // 区所を足すときの「いちばん大きい並びの番号」の問い合わせ(R8)
      if (url.searchParams.get("select") === "sort_order") return json(sorted.slice(-1).map((o) => ({ sort_order: o.sort_order })));
      return json(sorted);
    }
    if (path === "/rest/v1/offices") return json([{ id: 1, name: "A区所" }]);
    if (path === "/rest/v1/rpc/admin_stats" && opts.statsAbort) return route.abort("failed");
    if (path === "/rest/v1/rpc/admin_stats" && opts.statsFail) return json({ message: "statement timeout" }, 500);
    if (path === "/rest/v1/rpc/admin_stats" && opts.twoOffices) {
      const offices = [...st.offices].sort((a, b) => a.sort_order - b.sort_order).map((o) => ({ id: o.id, name: o.name, master_count: 1, user_count: 1, periods: [{ id: o.id * 100, starts_on: "2026-10-03", name: "ダイヤ修正", count: 1 }] }));
      return json({ users: 1, verified: 1, active_30d: 1, signup_password_set: true, today: "2026-10-15", offices, no_office: 0, users_list: [] });
    }
    if (path === "/rest/v1/rpc/admin_usage") {
      if (opts.usageFail) return json({ message: "boom" }, 500);
      return json(opts.usage || { db_bytes: 60 * 1048576, db_limit_bytes: 524288000, storage_bytes: 12 * 1048576, storage_files: 80, storage_limit_bytes: 1073741824, photos: 40, photo_bytes: 8 * 1048576, gallery: 12, gallery_bytes: 4 * 1048576, top_users: [{ employee_no: "7000001", name: "山田 太郎", bytes: 3 * 1048576 }] });
    }
    if (path === "/rest/v1/rpc/admin_stats") {
      return json({
        users: 1, verified: 1, active_30d: 1, signup_password_set: true, today: "2026-10-15",
        offices: [{ id: 1, name: "A区所", master_count: 1, user_count: 1, periods: opts.adminPeriods || [{ id: 1, starts_on: "2026-10-03", name: "ダイヤ修正", count: 1 }] }],
        no_office: 0, users_list: [], ...(opts.stats || {}),
      });
    }
    if (path === "/rest/v1/shift_master" && opts.masterFail) return json({ message: "boom" }, 500);
    // マスタは切替日(ダイヤ改正・ダイヤ修正)ごと。period_id の無い偽物の行は、いちばん古い切替日(id 1)の行にする
    if (path === "/rest/v1/shift_master") {
      // 分けて読む(.range = offset・limit)にも答える(AB14)
      const rows = (opts.master || []).map((r) => ({ period_id: 1, ...r }));
      const offset = Number(url.searchParams.get("offset") || 0);
      const limit = url.searchParams.get("limit");
      return json(limit === null ? rows : rows.slice(offset, offset + Number(limit)));
    }
    if (path === "/rest/v1/rpc/delete_master_period") return json(null);
    if (path === "/rest/v1/master_periods") return json(opts.periods || [{ id: 1, starts_on: "2026-10-03", name: "ダイヤ修正" }]);
    if (path === "/rest/v1/rpc/save_master_period") return json(opts.savedPeriodId || 3);
    if (path === "/rest/v1/rpc/save_master_period_all") return json(st.offices.length);
    if (path === "/rest/v1/rpc/master_affected_users") return json(opts.affected || 0);
    if (path === "/rest/v1/rpc/save_month_records") return json(Object.keys((body && body.p_entries) || {}).length);
    // 勤務入力の「保存」は register-month に saveOnly で送る(17回目の N1)。登録は件数を返す
    if (path === "/functions/v1/register-month") {
      await new Promise((r) => setTimeout(r, 300)); // 保存・登録の間の画面(押せないボタン)を確かめられるように
      if (body && body.saveOnly) return json(opts.periodError ? { saved: true, periodError: opts.periodError } : { saved: true });
      return json({ count: 0, skipped: 0 });
    }
    if (path === "/rest/v1/shift_records") return json(opts.records || []);
    if (path === "/rest/v1/holiday_years") return json([{ year: 2026 }, { year: 2027 }]);
    if (path === "/rest/v1/holidays") return json([]);
    if (path === "/functions/v1/sync-holidays") return json({ holidays: [] });
    if (path === "/rest/v1/rpc/current_guide_links") {
      if (opts.guidesFail) return json({ message: "boom" }, 500);
      return json(st.guides.filter((g) => g.visible).sort((a, b) => a.sort_order - b.sort_order).map(({ id, label, url, kind }) => ({ id, label, url, kind })));
    }
    if (path === "/rest/v1/rpc/move_guide_link") {
      const list = st.guides.sort((a, b) => a.sort_order - b.sort_order);
      const i = list.findIndex((g) => g.id === body.p_id); const j = i + (body.p_delta < 0 ? -1 : 1);
      if (i < 0) return json({ message: "リンクが見つかりません" }, 400);
      if (j >= 0 && j < list.length) [list[i], list[j]] = [list[j], list[i]];
      list.forEach((g, k) => { g.sort_order = k + 1; });
      return json(null, 204);
    }
    if (path === "/rest/v1/rpc/move_app_icon") {
      const list = st.appIcons.sort((a, b) => a.sort_order - b.sort_order);
      const i = list.findIndex((g) => g.id === body.p_id); const j = i + (body.p_delta < 0 ? -1 : 1);
      if (i < 0) return json({ message: "アイコンが見つかりません" }, 400);
      if (j >= 0 && j < list.length) [list[i], list[j]] = [list[j], list[i]];
      list.forEach((g, k) => { g.sort_order = k + 1; });
      return json(null, 204);
    }
    if (path === "/rest/v1/app_icons") {
      const id = Number((url.searchParams.get("id") || "").replace("eq.", ""));
      // 管理画面は全部(select=*)、利用者は表示中のものだけ(RLS)
      if (req.method() === "GET") return json([...st.appIcons].filter((x) => url.searchParams.get("select") === "*" || x.visible).sort((a, b) => a.sort_order - b.sort_order));
      if (req.method() === "POST") { const row = { id: st.nextAppIcon++, visible: true, ...body }; st.appIcons.push(row); return json({ id: row.id }, 201); }
      if (req.method() === "PATCH") { const g = st.appIcons.find((x) => x.id === id); if (g) Object.assign(g, body); return json(g ? [{ id }] : []); }
      if (req.method() === "DELETE") { st.appIcons = st.appIcons.filter((g) => g.id !== id); return json(null, 204); }
    }
    if (path === "/rest/v1/guide_links") {
      const id = Number((url.searchParams.get("id") || "").replace("eq.", ""));
      if (req.method() === "GET") return json([...st.guides].sort((a, b) => a.sort_order - b.sort_order));
      if (req.method() === "POST") { st.guides.push({ id: st.nextGuide++, visible: true, ...body }); return json(null, 201); }
      if (req.method() === "PATCH") { const g = st.guides.find((x) => x.id === id); if (g) Object.assign(g, body); return json(g ? [{ id }] : []); }
      if (req.method() === "DELETE") { st.guides = st.guides.filter((g) => g.id !== id); return json(null, 204); }
    }
    if (path === "/rest/v1/notices") {
      if (req.method() === "GET") return json(st.notices);
      if (req.method() === "POST") { st.notices.unshift({ id: st.nextNotice++, ...body, updated_at: new Date().toISOString() }); return json(null, 201); }
      // 直す(PATCH)は、PostgREST と同じく直した行を返す。行が無ければ 0件(エラーにはならない)
      if (req.method() === "PATCH") { const id = Number(url.searchParams.get("id").replace("eq.", "")); const n = st.notices.find((x) => x.id === id); if (n) Object.assign(n, body); return json(n ? [{ id }] : []); }
      if (req.method() === "DELETE") { const id = Number(url.searchParams.get("id").replace("eq.", "")); st.notices = st.notices.filter((n) => n.id !== id); return json(null, 204); }
    }
    if (path === "/auth/v1/logout") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } });
    if (path === "/auth/v1/token") {
      // ログインの更新(S2)。"down" は通信できない、それ以外は新しいログインを返す
      if (opts.refresh === "down") return route.abort("failed");
      return json(session("u1"));
    }
    if (path === "/functions/v1/app-config") {
      st.appConfigCalls = (st.appConfigCalls || 0) + 1;
      // 最初の1回だけ「ログインが切れた」を返す(S2)
      if (opts.firstUnauth && st.appConfigCalls === 1) return json({ error: "ログインし直してください。", code: "unauthenticated" }, 401);
      return json({ serviceAccountEmail: "sa@x.iam.gserviceaccount.com" });
    }
    if (path === "/functions/v1/contact") {
      if (opts.contactDelay) await new Promise((r) => setTimeout(r, opts.contactDelay));
      if (body.action === "submit") {
        if (opts.submitError) return json(opts.submitError, opts.submitError.status || 401);
        if (opts.submitDuplicate) return json({ id: 12, no: "#0012", duplicate: true, images: "none", reply_via: opts.submitDuplicate === "mail" ? "mail" : "screen" });
        const id = st.inquiries.length + 12;
        st.inquiries.push({ id, body });
        return json({ id, no: "#" + String(id).padStart(4, "0"), duplicate: false, images: body.images.length ? "ok" : "none" });
      }
      if (body.action === "view") {
        if (String(body.code).toUpperCase().replace("-", "") !== "K7QM4XPA") return json({ error: "受付番号か確認コードが違います。", code: "not_found" }, 404);
        return json({ no: "#0012", kind: "ログインできない", status: "replied", reply_via: "screen", created_at: "2026-10-06T00:00:00Z",
          messages: [{ from: "user", body: "PIN忘れ", at: "2026-10-06T00:00:00Z" }, { from: "admin", body: "<script>x</script>直接伝えます", at: "2026-10-06T01:00:00Z" }] });
      }
      if (body.action === "mine") return json({ inquiries: [{ no: "#0009", kind: "使い方・質問", status: "replied", reply_via: "screen", created_at: "2026-10-03T00:00:00Z",
        messages: [{ from: "user", body: "休日用は必須？", at: "2026-10-03T00:00:00Z" }, { from: "admin", body: "空欄でも使えます", at: "2026-10-04T00:00:00Z" }] }] });
    }
    if (path === "/functions/v1/admin-contact") {
      if (body.action === "list") {
        if (body.filter === "unmatched") return json({ filter: "unmatched", inquiries: [], unmatched_mails: [{ id: 90, inquiry_id: null, sender: "mail", channel: "mail", body: "質問です", body_full: null, from_email: "x@example.com", subject: "質問", attachment_names: null, bounce: false, gmail_message_id: "abc", gmail_thread_id: "def", mail_status: null, created_at: new Date().toISOString() }], counts: { todo: 2, unmatched: 1 }, statuses: {}, config: { discord: true, relay: true } });
        return json({ filter: body.filter, inquiries: [
          { id: 12, logged_in: false, employee_no: "1234567", name: opts.longName ? "とても長い名前".repeat(12) + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" : "山田 太郎", office_name: "A区所", kind: "login", reply_via: "mail", email: "taro@gmail.com", status: "open", has_new_mail: true, image_count: 2, last_activity_at: new Date().toISOString(), created_at: new Date().toISOString() },
          { id: 13, logged_in: true, employee_no: "7654321", name: "佐藤 花子", office_name: "B区所", kind: "bug", reply_via: "screen", email: null, status: "open", has_new_mail: false, image_count: 0, last_activity_at: new Date().toISOString(), created_at: new Date().toISOString() },
        ], unmatched_mails: [], counts: { todo: 2, unmatched: 1 },
        statuses: { gas: { value: { quota: 97 }, updated_at: new Date(Date.now() - 45 * 60e3).toISOString() } }, config: { discord: true, relay: true } });
      }
      if (body.action === "get") {
        return json({ inquiry: { id: 12, logged_in: false, employee_no: "1234567", name: "山田 太郎", office_name: "A区所", kind: "login", reply_via: "mail", email: "taro@gmail.com", status: "open", has_new_mail: false, image_count: 2, discord_status: "sent", receipt_status: "sent", receipt_message_id: "r1", last_activity_at: new Date().toISOString(), created_at: new Date().toISOString() },
          messages: [
            { id: 1, inquiry_id: 12, sender: "user", channel: "web", body: "PINを忘れました", created_at: new Date().toISOString() },
            { id: 2, inquiry_id: 12, sender: "admin", channel: "mail", body: "仮のPINを伝えます", mail_status: "failed", mail_error: "1日の上限", from_email: "taro@gmail.com", created_at: new Date().toISOString() },
            { id: 3, inquiry_id: 12, sender: "mail", channel: "mail", body: "<img src=x onerror=alert(2)>ありがとう", body_full: "ありがとう\n> 引用", from_email: "other@example.com", subject: "Re: お問い合わせ #0012", attachment_names: "a.jpg", gmail_thread_id: "ff01", created_at: new Date().toISOString() },
          ], registered: { name: "山田 太郎", officeName: "A区所" }, reply_to_email: "taro@gmail.com" });
      }
      if (body.action === "reply" && opts.replyDuplicate) return json({ message: { id: 9, body: "前の文", mail_status: "sent" }, duplicate: true });
      if (body.action === "reply") return json({ message: { id: 9, body: body.body, mail_status: body.via === "mail" ? "sent" : null }, duplicate: false });
      if (body.action === "resend") return json({ message: { id: 2, mail_status: "sent" } });
      if (body.action === "status") return json({ ok: true });
      if (body.action === "reply-unmatched") return json({ message: { mail_status: "sent" } });
    }
    return json({ error: "not mocked " + path }, 404);
  };
  return { st, handler };
}

const failures = [];
async function check(name, fn) {
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return; // ONLY=交番表 で、名前にその文字がある項目だけ
  try {
    await fn();
    console.log("ok  " + name);
  } catch (err) {
    failures.push(name);
    console.log("NG  " + name + "\n    " + String(err.stack || err).split("\n").slice(0, 4).join("\n    "));
  }
}

async function open(path, { opts = {}, userId = null, viewport = { width: 390, height: 844 }, beforeLoad } = {}) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  const be = backend(opts);
  await page.route(SB + "/**", be.handler);
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push("console: " + m.text()); });
  page.on("dialog", (d) => { errors.push("dialog: " + d.message()); d.dismiss(); });
  if (userId) {
    await page.addInitScript(([k, v]) => { if (!sessionStorage.getItem("__init")) { localStorage.setItem(k, v); sessionStorage.setItem("__init", "1"); } },
      ["sb-owotkyocoslifbgwwafm-auth-token", JSON.stringify(session(userId))]);
  }
  if (beforeLoad) await beforeLoad(page);
  await page.goto(BASE + "/" + path);
  return { page, ctx, be, errors };
}

const USER = { employee_no: "1234567", family_name: "山田", given_name: "太郎", role: "user" };
const ADMIN = { employee_no: null, family_name: "", given_name: "", role: "admin" };

// ---------- ログイン画面 ----------
await check("ログイン画面: お知らせは利用者タブの、タブと入力欄の間に最大3件。HTML は文字のまま", async () => {
  const { page, ctx, errors } = await open("index.html");
  await page.waitForSelector("#login-notices:not(.hidden)");
  const order = await page.evaluate(() => {
    const form = document.getElementById("user-form");
    const kids = [...form.children].map((e) => e.id || e.tagName);
    return kids.slice(0, 3);
  });
  assert.deepEqual(order, ["login-notices", "LABEL", "employee-no"]);
  assert.equal(await page.locator("#login-notices .notice-item").count(), 3);
  assert.equal(await page.locator("#login-notices img").count(), 0);
  assert.ok((await page.textContent("#login-notices")).includes("<img src=x onerror=alert(1)>"));
  // 長い本文は途中まで + 続きを読む
  assert.equal(await page.locator("#login-notices .link-button").count(), 1);
  await page.click("#login-notices .link-button");
  assert.ok((await page.textContent("#login-notices")).includes("長い説明長い説明"));
  assert.ok(await page.isVisible("text=ログインできないときは"));
  assert.equal(await page.getAttribute("a:has-text('お問い合わせ') >> nth=-1", "href"), "contact.html");
  await page.screenshot({ path: OUT + "login.png", fullPage: true });
  await page.click("#tab-admin");
  assert.equal(await page.isVisible("#login-notices"), false);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("ログイン画面: お知らせが読めない(500)ときは何も出さず、エラーも出さない(N1)", async () => {
  const { page, ctx, errors } = await open("index.html", { opts: { noticesFail: true } });
  await page.waitForTimeout(1500);
  assert.equal(await page.isVisible("#login-notices"), false);
  assert.equal(await page.isEnabled("#user-login"), true);
  assert.deepEqual(errors.filter((e) => !e.includes("500")), []);
  await ctx.close();
});

await check("ログイン画面: 入力を始めたあとに届いたお知らせは、欄をずらさずボタンの下に出す(N2)。遅いお知らせはログインを止めない", async () => {
  const { page, ctx, errors } = await open("index.html", { opts: { noticesDelay: 2500 } });
  await page.click("#employee-no");
  await page.keyboard.type("123");
  const before = await page.locator("#employee-no").boundingBox();
  await page.waitForSelector("#login-notices:not(.hidden)", { timeout: 6000 });
  const after = await page.locator("#employee-no").boundingBox();
  assert.equal(before.y, after.y);
  assert.ok(await page.evaluate(() => document.getElementById("login-notices").classList.contains("below")));
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("ログイン画面: 前回のログインの確認が通信エラーなら、ログインを消さずに知らせる。プロフィールが無いときだけ消す(Q1)", async () => {
  const key = "sb-owotkyocoslifbgwwafm-auth-token";
  const a = await open("index.html", { userId: "u1", opts: { profileAbort: true } });
  await a.page.waitForSelector("#user-message.error");
  assert.ok((await a.page.textContent("#user-message")).includes("確かめられませんでした"));
  assert.ok(await a.page.evaluate((k) => !!localStorage.getItem(k), key));
  assert.equal(await a.page.isEnabled("#user-login"), true);
  await a.ctx.close();
  const b = await open("index.html", { userId: "u1", opts: { profile: null } });
  await b.page.waitForFunction((k) => !localStorage.getItem(k), key);
  assert.equal(await b.page.textContent("#user-message"), "");
  await b.ctx.close();
});

await check("お問い合わせ: 前の送信がもう届いていた(duplicate)ときは、直した内容は届いていないと知らせる(Q6)", async () => {
  const { page, ctx } = await open("contact.html", { opts: { submitDuplicate: true } });
  await page.waitForSelector("#contact-form:not(.hidden)");
  await page.fill("#employee-no", "1234567");
  await page.fill("#name", "山田 太郎");
  await page.selectOption("#office", "A区所");
  await page.selectOption("#kind", "login");
  await page.fill("#body", "直した内容");
  await page.click("#submit");
  await page.waitForSelector("#sent:not(.hidden)");
  assert.ok((await page.textContent("#sent-images")).includes("もう届いていました"));
  await ctx.close();
});

await check("送り直しで前の問い合わせ(メールで受け取る)が届いていたら、使えない確認コードを出さない(S20)", async () => {
  const { page, ctx } = await open("contact.html", { opts: { submitDuplicate: "mail" } });
  await page.waitForSelector("#contact-form:not(.hidden)");
  await page.fill("#employee-no", "1234567");
  await page.fill("#name", "山田 太郎");
  await page.selectOption("#office", "A区所");
  await page.selectOption("#kind", "login");
  await page.fill("#body", "内容");
  await page.click("#submit");
  await page.waitForSelector("#sent:not(.hidden)");
  assert.equal(await page.isVisible("#sent-code"), false);
  assert.equal(await page.isVisible("#sent-mail"), true);
  await ctx.close();
});

await check("ログインの更新が遅れて「ログインが切れた」と言われたら、更新して1回だけ送り直す。更新できない(圏外)ときはログインを消さない(S2)", async () => {
  const key = "sb-owotkyocoslifbgwwafm-auth-token";
  const a = await open("settings.html", { userId: "u1", opts: { profile: USER, firstUnauth: true } });
  await a.page.waitForFunction(() => document.getElementById("sa-email").value === "sa@x.iam.gserviceaccount.com");
  assert.equal(a.be.st.appConfigCalls, 2);
  assert.ok(a.page.url().endsWith("settings.html"));
  await a.ctx.close();
  const b = await open("settings.html", { userId: "u1", opts: { profile: USER, firstUnauth: true, refresh: "down" } });
  // 圏外のとき、supabase-js はログインの更新を30秒ほど粘ってから諦める
  await b.page.waitForFunction(() => document.getElementById("sa-email").value.startsWith("取得できませんでした"), null, { timeout: 45000 });
  assert.ok((await b.page.inputValue("#sa-email")).includes("通信が不安定"));
  assert.ok(b.page.url().endsWith("settings.html"));
  assert.ok(await b.page.evaluate((k) => !!localStorage.getItem(k), key));
  await b.ctx.close();
});

await check("設定: 行が無いまま開いて保存したとき、もう行ができていても(重複)、更新でやり直して保存できる(R3)", async () => {
  const { page, ctx, be, errors } = await open("settings.html", { userId: "u1", opts: { profile: USER, noSettingsRow: true } });
  await page.waitForSelector("#office option[value='1']", { state: "attached" });
  await page.selectOption("#office", "1");
  await page.check("#google-sync"); // 新しい人は外した状態から。Googleにも登録するなら、チェックを入れてIDを入れる
  await page.fill("#work-id", "w@group.calendar.google.com");
  await page.click("#save");
  await page.waitForSelector("#result.ok");
  const methods = be.st.calls.filter((c) => c.path === "/rest/v1/user_settings").map((c) => c.method);
  assert.ok(methods.includes("POST") && methods.includes("PATCH"), methods.join());
  assert.ok(!(await page.textContent("#result")).includes("duplicate"));
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("設定: 「Googleカレンダーにも登録する」を外すと、IDも接続テストも無しで保存でき、勤務入力へ進める", async () => {
  const { page, ctx, be, errors } = await open("settings.html", {
    userId: "u1",
    opts: { profile: USER, settings: { google_sync: false, work_calendar_id: "", verified_at: null } },
  });
  await page.waitForSelector("#office option[value='1']", { state: "attached" });
  assert.equal(await page.isChecked("#google-sync"), false);
  // Google用の設定はたたむ。ボタンは「保存」
  assert.equal(await page.isVisible("#google-fields"), false);
  assert.equal(await page.isVisible("#google-top"), false);
  assert.equal((await page.textContent("#save")).trim(), "保存");
  await page.click("#save");
  await page.waitForSelector("#result.ok");
  assert.ok((await page.textContent("#result")).includes("Googleカレンダーには登録しません"));
  const saved = be.st.calls.find((c) => c.path === "/rest/v1/user_settings" && c.method === "PATCH").body;
  assert.equal(saved.google_sync, false);
  assert.ok(!be.st.calls.some((c) => c.path === "/functions/v1/verify-calendar"), "接続テストはしない");
  assert.equal(await page.isVisible("#go-input"), true);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("設定: 今の利用者(google_sync の値が無い行)は、チェックが入ったまま。保存は今までどおり接続テストをする", async () => {
  const { page, ctx, be, errors } = await open("settings.html", { userId: "u1", opts: { profile: USER } });
  await page.waitForSelector("#office option[value='1']", { state: "attached" });
  assert.equal(await page.isChecked("#google-sync"), true);
  assert.equal(await page.isVisible("#google-fields"), true);
  assert.equal((await page.textContent("#save")).trim(), "保存して接続テスト");
  await page.click("#save");
  await page.waitForSelector("#result.ok");
  const saved = be.st.calls.find((c) => c.path === "/rest/v1/user_settings" && c.method === "PATCH").body;
  assert.equal(saved.google_sync, true);
  assert.ok(be.st.calls.some((c) => c.path === "/functions/v1/verify-calendar"));
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("設定: Googleのチェックを入れたまま、IDが空だと保存できない。外せば、IDが入ったままでも接続テスト無しで保存できる(IDは残る)", async () => {
  const { page, ctx, be, errors } = await open("settings.html", {
    userId: "u1",
    opts: { profile: USER, settings: { work_calendar_id: "", verified_at: null } },
  });
  await page.waitForSelector("#office option[value='1']", { state: "attached" });
  await page.click("#save");
  await page.waitForSelector("#result.error");
  assert.ok((await page.textContent("#result")).includes("カレンダーID"));
  await page.fill("#work-id", "w@group.calendar.google.com");
  await page.uncheck("#google-sync");
  await page.click("#save");
  await page.waitForSelector("#result.ok");
  const saved = be.st.calls.find((c) => c.path === "/rest/v1/user_settings" && c.method === "PATCH").body;
  assert.equal(saved.google_sync, false);
  assert.equal(saved.work_calendar_id, "w@group.calendar.google.com");
  assert.ok(!be.st.calls.some((c) => c.path === "/functions/v1/verify-calendar"));
  // 入れ直すと、IDはそのまま使える
  await page.check("#google-sync");
  assert.equal(await page.inputValue("#work-id"), "w@group.calendar.google.com");
  assert.equal(await page.isVisible("#google-fields"), true);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("設定: 新しく使い始める人(行が無い)は外した状態から。区所だけで保存でき、チェックを入れるとGoogleの設定が出る", async () => {
  const { page, ctx, be, errors } = await open("settings.html", { userId: "u1", opts: { profile: USER, noSettingsRow: true } });
  await page.waitForSelector("#office option[value='1']", { state: "attached" });
  assert.equal(await page.isChecked("#google-sync"), false);
  assert.equal(await page.isVisible("#google-fields"), false);
  assert.equal((await page.textContent("#save")).trim(), "保存");
  await page.selectOption("#office", "1");
  await page.click("#save");
  await page.waitForSelector("#result.ok");
  assert.ok(!be.st.calls.some((c) => c.path === "/functions/v1/verify-calendar"));
  await page.check("#google-sync");
  assert.equal(await page.isVisible("#google-fields"), true);
  assert.equal((await page.textContent("#save")).trim(), "保存して接続テスト");
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("勤務入力: Googleに登録しない人は「登録」を隠し、「保存」だけ。接続テストの案内も出さない。保存はサーバーに saveOnly で送る", async () => {
  const { page, ctx, be, errors } = await open("input.html", {
    userId: "u1",
    opts: { profile: USER, settings: { google_sync: false, verified_at: null } },
  });
  await page.waitForSelector("#save:not([disabled])");
  assert.equal(await page.isVisible("#register"), false);
  assert.equal(await page.isVisible("#setup-note"), false);
  await page.click("#save");
  await page.waitForFunction(() => document.getElementById("status").textContent.includes("保存しました"));
  assert.ok(!(await page.textContent("#status")).includes("カレンダーにはまだ入っていません"));
  assert.ok((await page.textContent("#reset-note")).includes("Googleカレンダーの予定は消しません"));
  const saves = be.st.calls.filter((c) => c.path === "/functions/v1/register-month");
  assert.equal(saves.length, 1);
  assert.equal(saves[0].body.saveOnly, true);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("勤務入力: Googleに登録する今までの人は、「登録」も「保存」も今までどおり", async () => {
  const { page, ctx, errors } = await open("input.html", { userId: "u1", opts: { profile: USER } });
  await page.waitForSelector("#save:not([disabled])");
  assert.equal(await page.isVisible("#register"), true);
  assert.ok((await page.textContent("#reset-note")).includes("Googleカレンダーから削除"));
  await page.click("#save");
  await page.waitForFunction(() => document.getElementById("status").textContent.includes("保存しました"));
  assert.ok((await page.textContent("#status")).includes("アプリのカレンダーに出ます)。Googleカレンダーにはまだ入っていません"));
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("設定: 非番を2件・非番の時間用カレンダーIDを読み込み、保存で送る", async () => {
  const { page, ctx, be, errors } = await open("settings.html", {
    userId: "u1",
    opts: { profile: USER, settings: { split_offduty_events: true, offduty_calendar_id: "off@group.calendar.google.com" } },
  });
  await page.waitForFunction(() => document.getElementById("offduty-id").value === "off@group.calendar.google.com");
  assert.equal(await page.isChecked("#split-offduty"), true);
  assert.equal(await page.isChecked("#split-day"), false);
  await page.waitForSelector("#office option[value='1']", { state: "attached" });
  await page.uncheck("#split-offduty");
  // 変えたら、保存するまで「勤務入力へ」を出さない
  assert.equal(await page.isVisible("#go-input"), false);
  await page.fill("#offduty-id", "  off2@group.calendar.google.com ");
  await page.click("#save");
  await page.waitForSelector("#result.ok");
  const saved = be.st.calls.find((c) => c.path === "/rest/v1/user_settings" && c.method === "PATCH").body;
  assert.equal(saved.split_offduty_events, false);
  assert.equal(saved.offduty_calendar_id, "off2@group.calendar.google.com");
  assert.ok(be.st.calls.some((c) => c.path === "/functions/v1/verify-calendar"));
  assert.deepEqual(errors, []);
  await page.screenshot({ path: OUT + "settings-offduty.png", fullPage: true });
  await ctx.close();
});

await check("設定: 名前に時間を付ける(出勤・非番)を読み込み、保存で送る", async () => {
  const { page, ctx, be, errors } = await open("settings.html", {
    userId: "u1",
    opts: { profile: USER, settings: { title_day_time: true, title_offduty_time: false } },
  });
  await page.waitForFunction(() => document.getElementById("title-day").checked);
  assert.equal(await page.isChecked("#title-offduty"), false);
  await page.waitForSelector("#office option[value='1']", { state: "attached" });
  await page.uncheck("#title-day");
  await page.check("#title-offduty");
  // 変えたら、保存するまで「勤務入力へ」を出さない
  assert.equal(await page.isVisible("#go-input"), false);
  await page.click("#save");
  await page.waitForSelector("#result.ok");
  const saved = be.st.calls.find((c) => c.path === "/rest/v1/user_settings" && c.method === "PATCH").body;
  assert.equal(saved.title_day_time, false);
  assert.equal(saved.title_offduty_time, true);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("設定: 時間つきで登録するを読み込み、オンのあいだは「2件」「名前に時間」を押せない。保存で送る", async () => {
  const { page, ctx, be, errors } = await open("settings.html", {
    userId: "u1",
    opts: { profile: USER, settings: { timed_events: true, split_day_events: true } },
  });
  await page.waitForFunction(() => document.getElementById("timed-events").checked);
  for (const id of ["#split-day", "#split-offduty", "#title-day", "#title-offduty"]) {
    assert.equal(await page.isDisabled(id), true, id);
  }
  // チェックは残す(外したときに元の設定に戻る)
  assert.equal(await page.isChecked("#split-day"), true);
  await page.waitForSelector("#office option[value='1']", { state: "attached" });
  await page.uncheck("#timed-events");
  assert.equal(await page.isDisabled("#split-day"), false);
  assert.equal(await page.isVisible("#go-input"), false);
  await page.click("#save");
  await page.waitForSelector("#result.ok");
  const saved = be.st.calls.find((c) => c.path === "/rest/v1/user_settings" && c.method === "PATCH").body;
  assert.equal(saved.timed_events, false);
  assert.equal(saved.split_day_events, true);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("ログアウトは、この端末だけ(scope=local。S5)", async () => {
  const { page, ctx, be } = await open("notices.html", { userId: "u1", opts: { profile: USER } });
  await page.waitForSelector("text=ログアウト");
  // 押し間違い防止の確認が出る。キャンセルなら、ログアウトしない
  page.removeAllListeners("dialog");
  let asked = "";
  page.once("dialog", (d) => { asked = d.message(); d.dismiss(); });
  await page.click("text=ログアウト");
  assert.equal(asked, "ログアウトしますか？");
  assert.ok(!be.st.calls.some((c) => c.path === "/auth/v1/logout"));
  page.once("dialog", (d) => d.accept());
  await page.click("text=ログアウト");
  await page.waitForURL(/index\.html/);
  const out = be.st.calls.find((c) => c.path === "/auth/v1/logout");
  assert.ok(out && out.search.includes("scope=local"), JSON.stringify(out && out.search));
  await ctx.close();
});

await check("勤務入力: 登録していない変更があるときのログアウトは、確認が1回だけ(Y3)", async () => {
  const { page, ctx, be } = await open("input.html", { userId: "u1", opts: { profile: USER } });
  await page.waitForSelector("#register:not([disabled])");
  await page.locator("td.memo input").first().fill("メモ"); // 入力すると、未登録の変更になる
  page.removeAllListeners("dialog");
  const asked = [];
  page.on("dialog", (d) => { asked.push(d.message()); d.accept(); });
  await page.click("text=ログアウト");
  await page.waitForURL(/index\.html/);
  assert.deepEqual(asked, ["登録していない変更があります。移動しますか？"]);
  assert.ok(be.st.calls.some((c) => c.path === "/auth/v1/logout"));
  await ctx.close();
});

// ---------- 写真取込(docs/photo/DESIGN.md) ----------
const PHOTO_MASTER = [
  { code: "1", kind: "泊", weekday_start: "10:00", weekday_end: "9:00", holiday_start: "", holiday_end: "", stay: "京都", sort_order: 1 },
  { code: "25", kind: "日勤", weekday_start: "9:00", weekday_end: "17:45", holiday_start: "", holiday_end: "", stay: "", sort_order: 2 },
  { code: "公休", kind: "休日", weekday_start: "", weekday_end: "", holiday_start: "", holiday_end: "", stay: "", sort_order: 3 },
];
const nextMonth = (() => { const t = new Date(); const d = new Date(t.getFullYear(), t.getMonth() + 1, 1); return { y: d.getFullYear(), m: d.getMonth() + 1 }; })();
const importText = (obj) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
const ymd = (d) => `${nextMonth.y}-${String(nextMonth.m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

await check("写真取込: リンク(#import=)で開くと、確認のあとその月に入れ、アドレスから消す。泊の翌日の番号は消し、一覧にない番号は黄色", async () => {
  const text = importText({ v: 1, y: nextMonth.y, m: nextMonth.m, d: { 5: ["1", ""], 6: ["〜", "9:00"], 7: ["変7d", ""], 8: ["公休", ""], 9: ["２５", ""] } });
  const asked = [];
  const { page, ctx, be, errors } = await open("input.html#import=" + text, {
    userId: "u1",
    opts: { profile: USER, master: PHOTO_MASTER },
    beforeLoad: async (p) => { p.removeAllListeners("dialog"); p.on("dialog", (d) => { asked.push(d.message()); d.accept(); }); },
  });
  await page.waitForFunction(() => document.getElementById("status").textContent.includes("写真取込"));
  assert.equal(asked.length, 1);
  assert.ok(asked[0].includes(`${nextMonth.y}年${nextMonth.m}月`) && asked[0].includes("5日分"), asked[0]);
  assert.equal(await page.textContent("#title"), `${nextMonth.y}年${nextMonth.m}月`);
  assert.equal(new URL(page.url()).hash, "");
  const row = (d) => page.locator("#list tr").nth(d - 1);
  assert.equal(await row(5).locator(".pick").textContent(), "1");
  assert.equal((await row(6).locator(".offduty").textContent()), "非番");
  assert.equal(await row(6).locator(".memo input").inputValue(), "9:00");
  assert.equal(await row(7).locator(".code input").inputValue(), "変7d");
  assert.equal(await row(7).getAttribute("class"), "imported needtime");
  assert.equal(await row(8).locator(".pick").textContent(), "公休");
  assert.equal(await row(9).locator(".pick").textContent(), "25"); // 全角は一覧の番号に
  assert.equal(await page.locator("#list tr.imported").count(), 5);
  assert.ok((await page.textContent("#status")).includes("時間の無い日が1日"));
  // 一覧にない番号を並べる(L3)
  assert.ok((await page.textContent("#status")).includes("一覧にない番号: 変7d"));
  // 時間を入れると黄色が消える
  await row(7).locator(".memo input").fill("9:00〜18:00");
  assert.equal(await row(7).getAttribute("class"), "imported");

  // 保存: カレンダーには入れず、入力だけ保存する。登録と同じ register-month に saveOnly で送る(17回目の N1)。
  // 保存している間はリセットを押せない(N2)
  await page.click("#save");
  assert.equal(await page.isDisabled("#reset"), true);
  await page.waitForFunction(() => document.getElementById("status").textContent.includes("保存しました"));
  assert.equal(await page.isDisabled("#reset"), false);
  const saves = be.st.calls.filter((c) => c.path === "/functions/v1/register-month");
  assert.equal(saves.length, 1);
  const saved = saves[0].body;
  assert.equal(saved.saveOnly, true);
  assert.equal(saved.year, nextMonth.y);
  assert.equal(saved.month, nextMonth.m);
  assert.deepEqual(saved.entries[ymd(6)], { code: "", memo: "9:00" });
  assert.deepEqual(saved.entries[ymd(7)], { code: "変7d", memo: "9:00〜18:00" });
  assert.ok(!be.st.calls.some((c) => c.path === "/rest/v1/rpc/save_month_records"));
  assert.equal(await page.locator("#list tr.imported").count(), 0);
  await page.screenshot({ path: OUT + "photo-import.png" });
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("勤務入力: 画面に戻ったとき、登録していない変更が無ければ読み直す。変更があれば読み直さずに知らせる(L1)", async () => {
  const { page, ctx, be, errors } = await open("input.html", { userId: "u1", opts: { profile: USER, master: PHOTO_MASTER } });
  await page.waitForSelector("#register:not([disabled])");
  // 月の読み込みだけを数える(保存・登録のあとの翌月1日だけの読み直し[AB2]は数えない)
  const loads = () => be.st.calls.filter((c) => c.path === "/rest/v1/shift_records" && c.search.includes("gte")).length;
  const setVisible = (v) => page.evaluate((v) => {
    Object.defineProperty(document, "visibilityState", { value: v, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  }, v);
  const first = loads();
  await setVisible("hidden");
  await page.waitForTimeout(2100);
  await setVisible("visible");
  await page.waitForFunction((n) => document.querySelectorAll("#list tr").length > 0 && !document.getElementById("register").disabled, first);
  assert.equal(loads(), first + 1);
  // 変更があるときは読み直さない
  await page.locator("td.memo input").first().fill("メモ");
  await setVisible("hidden");
  await page.waitForTimeout(2100);
  await setVisible("visible");
  assert.equal(loads(), first + 1);
  assert.ok((await page.textContent("#status")).includes("古いまま"));
  assert.equal(await page.locator("td.memo input").first().inputValue(), "メモ");
  // すぐ戻ったとき(2秒未満)は何もしない
  await setVisible("hidden");
  await setVisible("visible");
  assert.equal(loads(), first + 1);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("勤務入力: 戻ったときの読み直しは、一覧を開いているあいだはしない(M1)。内容が同じなら前のメッセージを残す(M2)", async () => {
  const { page, ctx, be, errors } = await open("input.html", { userId: "u1", opts: { profile: USER, master: PHOTO_MASTER } });
  await page.waitForSelector("#register:not([disabled])");
  // 月の読み込みだけを数える(保存・登録のあとの翌月1日だけの読み直し[AB2]は数えない)
  const loads = () => be.st.calls.filter((c) => c.path === "/rest/v1/shift_records" && c.search.includes("gte")).length;
  const away = async () => {
    await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
    await page.waitForTimeout(2100);
    await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
  };
  // 保存したあとのメッセージは、戻って読み直しても(内容が同じなら)残る(M2)。偽のサーバーは保存した内容を覚えないので、変更なしで保存する
  await page.click("#save");
  await page.waitForFunction(() => document.getElementById("status").textContent.includes("保存しました"));
  const first = loads();
  await away();
  await page.waitForFunction((n) => !document.getElementById("register").disabled, first);
  assert.equal(loads(), first + 1);
  assert.ok((await page.textContent("#status")).includes("保存しました"));
  // 一覧を開いているあいだは読み直さない。選んだ番号はちゃんと入る(M1)
  await page.locator("#list tr").nth(1).locator(".pick").click();
  await away();
  assert.equal(loads(), first + 1);
  await page.click("#picker-duty button:has-text('25')");
  assert.equal(await page.locator("#list tr").nth(1).locator(".pick").textContent(), "25");
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("勤務入力: 泊地は、翌日が休日なら翌休泊、平日なら泊(17回目の N4)", async () => {
  const master = [
    { code: "301", kind: "泊", weekday_start: "9:00", weekday_end: "9:30", holiday_start: "9:10", holiday_end: "9:40", stay: "泊地A", stay_next_holiday: "泊地B", sort_order: 1 },
    { code: "302", kind: "泊", weekday_start: "10:00", weekday_end: "8:45", holiday_start: "", holiday_end: "", stay: "泊地C", sort_order: 2 },
  ];
  const { page, ctx, errors } = await open("input.html", { userId: "u1", opts: { profile: USER, master } });
  await page.waitForSelector("#register:not([disabled])");
  // 表示中の月で、翌日が土曜の日(金曜)と、翌日が平日の日(月曜)を探す(どちらも翌日が同じ月の中)
  const [y, m] = (await page.textContent("#title")).match(/\d+/g).map(Number);
  const days = new Date(y, m, 0).getDate();
  const find = (wd) => { for (let d = 1; d < days; d++) if (new Date(y, m - 1, d).getDay() === wd) return d; };
  const fri = find(5), mon = find(1);
  const pick = async (d, code) => {
    await page.locator("#list tr").nth(d - 1).locator(".pick").click();
    await page.click(`#picker-duty button:text-is("${code}")`);
  };
  await pick(fri, "301");
  await pick(mon, "301");
  const stayOf = (d) => page.locator("#list tr").nth(d - 1).locator(".memo .stay").textContent();
  assert.equal(await stayOf(fri), "泊地B");
  assert.equal(await stayOf(mon), "泊地A");
  // 翌休泊が空なら、翌日が休日でも泊
  await pick(fri, "302");
  assert.equal(await stayOf(fri), "泊地C");
  assert.deepEqual(errors, []);
  await ctx.close();
});

// ---------- マスタの切替(ダイヤ改正・ダイヤ修正) ----------
// 表示中の月(今月)の20日から、次のマスタに切り替わる
const thisMonth = (() => { const t = new Date(); return { y: t.getFullYear(), m: t.getMonth() + 1 }; })();
const switchDay = `${thisMonth.y}-${String(thisMonth.m).padStart(2, "0")}-20`;
const SWITCH_PERIODS = [{ id: 1, starts_on: "2000-01-01", name: "ダイヤ修正" }, { id: 2, starts_on: switchDay, name: "ダイヤ改正" }];
const OLD_MASTER = [
  { period_id: 1, code: "1", kind: "泊", weekday_start: "9:00", weekday_end: "9:30", holiday_start: "", holiday_end: "", stay: "", sort_order: 1 },
  { period_id: 1, code: "2", kind: "泊", weekday_start: "9:10", weekday_end: "9:40", holiday_start: "", holiday_end: "", stay: "", sort_order: 2 },
];
const NEW_MASTER = [
  { period_id: 2, code: "1", kind: "泊", weekday_start: "10:00", weekday_end: "8:05", holiday_start: "", holiday_end: "", stay: "", sort_order: 1 },
  { period_id: 2, code: "9", kind: "日勤", weekday_start: "7:00", weekday_end: "15:00", holiday_start: "", holiday_end: "", stay: "", sort_order: 2 },
];
const pickCode = async (page, d, code) => {
  await page.locator("#list tr").nth(d - 1).locator(".pick").click();
  await page.click(`#picker-duty button:text-is("${code}")`);
};

await check("マスタの切替: 次のマスタが未登録なら、上に知らせ、切替日の前日の泊と切替日から後の番号の行を赤くする", async () => {
  const { page, ctx, errors } = await open("input.html", { userId: "u1", opts: { profile: USER, master: OLD_MASTER, periods: SWITCH_PERIODS } });
  await page.waitForSelector("#register:not([disabled])");
  assert.ok((await page.textContent("#period-note")).includes("20日から「" + thisMonth.y + "年" + thisMonth.m + "月 ダイヤ改正」のマスタになります。まだ管理者がマスタを入れていない"));
  await pickCode(page, 19, "1");
  const row = (d) => page.locator("#list tr").nth(d - 1);
  assert.ok((await row(19).getAttribute("class")).includes("period-error"));
  assert.ok((await page.textContent("#period-note")).includes("非番の退勤時間が分かりません"));
  // 切替日から後の日に手入力すると、その行も赤くなる
  await row(22).locator(".pick").click();
  await page.click("#picker-manual");
  await row(22).locator(".code input").fill("公休");
  assert.ok((await row(22).getAttribute("class")).includes("period-error"));
  // 新しいマスタがまだ無い日の一覧は空なので、理由を出す。前の日は出さない
  await row(23).locator(".pick").click();
  assert.ok((await page.textContent("#picker-note")).includes("のマスタが、まだ登録されていません"));
  await page.click("#picker-cancel");
  await row(12).locator(".pick").click();
  assert.ok(await page.isHidden("#picker-note"));
  await page.click("#picker-cancel");
  await page.screenshot({ path: OUT + "period-input-missing.png", fullPage: true });
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("マスタの切替: 登録できない日があっても「保存」はできる(登録できない理由を添える)", async () => {
  const { page, ctx, be, errors } = await open("input.html", {
    userId: "u1", opts: { profile: USER, master: OLD_MASTER, periods: SWITCH_PERIODS, periodError: "10/22: まだ登録されていません。" },
  });
  await page.waitForSelector("#register:not([disabled])");
  await pickCode(page, 19, "1");
  await page.click("#save");
  await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("保存しました"));
  assert.ok((await page.textContent("#status")).includes("Googleカレンダーにはまだ入っていません。今は登録できません: 10/22: まだ登録されていません。"));
  assert.ok(be.st.calls.some((c) => c.path === "/functions/v1/register-month" && c.body.saveOnly === true));
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("マスタの切替: 新しいマスタで無くなった番号を入れてある日は、上に知らせて黄色にする", async () => {
  const mm = String(thisMonth.m).padStart(2, "0");
  const records = [{ date: `${thisMonth.y}-${mm}-23`, code: "2", memo: "" }, { date: `${thisMonth.y}-${mm}-12`, code: "2", memo: "" }];
  const { page, ctx, errors } = await open("input.html", { userId: "u1", opts: { profile: USER, master: [...OLD_MASTER, ...NEW_MASTER], periods: SWITCH_PERIODS, records } });
  await page.waitForSelector("#register:not([disabled])");
  assert.ok((await page.textContent("#period-note")).includes("新しいマスタに無い番号があります: 23日の「2」。"));
  const row = (d) => page.locator("#list tr").nth(d - 1);
  assert.ok((await row(23).getAttribute("class")).includes("needtime"));
  assert.ok(!(await row(12).getAttribute("class") || "").includes("needtime")); // 前のマスタの日は、その番号がある
  // 時間を入れると黄色が消える
  await row(23).locator(".memo input").fill("9:00〜17:00");
  assert.ok(!(await row(23).getAttribute("class")).includes("needtime"));
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("マスタの切替: 切替日の前日の泊の非番は、新しいマスタの退勤。切替日から後の一覧は新しいマスタの番号", async () => {
  const { page, ctx, errors } = await open("input.html", { userId: "u1", opts: { profile: USER, master: [...OLD_MASTER, ...NEW_MASTER], periods: SWITCH_PERIODS } });
  await page.waitForSelector("#register:not([disabled])");
  assert.ok((await page.textContent("#period-note")).includes("非番の退勤時間も新しいマスタから入ります"));
  const row = (d) => page.locator("#list tr").nth(d - 1);
  await pickCode(page, 19, "1");
  // 休日の列が空なので、平休に関係なく新しいマスタの 8:05(前のマスタなら 9:30)。泊の出勤は前のマスタの 9:00
  assert.equal(await row(20).locator(".memo input").inputValue(), "8:05");
  assert.equal(await row(19).locator(".memo input").inputValue(), "9:00");
  // 前のマスタだけにある泊(2)は、非番のメモに退勤時間を入れるまで赤い。赤いのはメモを入れる非番の日の行(AD8)
  const cls = async (d) => (await row(d).getAttribute("class")) || "";
  await pickCode(page, 19, "2");
  assert.ok((await cls(20)).includes("period-error"));
  assert.ok(!(await cls(19)).includes("period-error"));
  await row(20).locator(".memo input").fill("9:00");
  assert.ok(!(await cls(20)).includes("period-error"));
  // 切替日から後の日の一覧は、新しいマスタの番号だけ
  await row(23).locator(".pick").click();
  assert.deepEqual(await page.$$eval("#picker-duty button", (b) => b.map((x) => x.textContent)), ["1", "9"]);
  await page.click("#picker-cancel");
  await row(12).locator(".pick").click();
  assert.deepEqual(await page.$$eval("#picker-duty button", (b) => b.map((x) => x.textContent)), ["1", "2"]);
  await page.click("#picker-cancel");
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("マスタの切替(管理画面): タブ・CSV未登録の注意・次のマスタを作る(月で名前を選ぶ)・前のマスタとの違い", async () => {
  const adminPeriods = [{ id: 1, starts_on: "2026-10-03", name: "ダイヤ修正", count: 2 }, { id: 2, starts_on: "2027-03-14", name: "ダイヤ改正", count: 0 }];
  const { page, ctx, be, errors } = await open("admin.html", {
    userId: "a1", opts: { profile: ADMIN, adminPeriods, master: OLD_MASTER }, viewport: { width: 1200, height: 900 },
  });
  await page.waitForSelector("#alerts .alert");
  assert.ok((await page.textContent("#alerts")).includes("A区所: 「2027年3月 ダイヤ改正」(3/14〜、あと150日)のマスタ(CSV)がまだありません"));
  await page.click('.dtab[data-tab="master"]');
  await page.waitForFunction(() => document.getElementById("master-count").textContent.startsWith("2件"));
  const chips = await page.$$eval("#period-tabs .chip", (b) => b.map((x) => x.textContent));
  assert.deepEqual(chips, ["2026年10月 ダイヤ修正使用中10/3〜3/13", "2027年3月 ダイヤ改正⚠CSV未登録3/14〜", "＋ 次のマスタ"]);
  assert.ok(await page.isHidden("#period-delete")); // 使っているマスタは消せない
  // 次のマスタのタブ: 消せる。前のマスタをコピーできる
  await page.click("#period-tabs .chip >> nth=1");
  assert.ok(await page.isVisible("#period-delete"));
  assert.ok(await page.isVisible("#copy-prev"));
  // 次のマスタを作る: 10月を選ぶと名前がダイヤ修正になる
  await page.click("#period-tabs .chip.add");
  assert.ok(await page.isHidden("#period-csv"));
  assert.equal(await page.getAttribute("#period-date", "min"), "2026-10-04"); // 今月の1日より、いちばん古いマスタの翌日が後
  await page.fill("#period-date", "2027-10-02");
  await page.dispatchEvent("#period-date", "change");
  assert.equal(await page.inputValue("#period-name"), "ダイヤ修正");
  // 名前を手で選んだあとは、切替日を変えても名前を変えない
  await page.selectOption("#period-name", "");
  await page.fill("#period-date", "2027-03-02");
  await page.dispatchEvent("#period-date", "change");
  assert.equal(await page.inputValue("#period-name"), "");
  await page.selectOption("#period-name", "ダイヤ修正");
  await page.fill("#period-date", "2027-10-02");
  await page.click("#period-save");
  await page.waitForFunction(() => document.getElementById("period-message").textContent.includes("を作りました"));
  const saved = be.st.calls.find((c) => c.path === "/rest/v1/rpc/save_master_period").body;
  assert.deepEqual(saved, { p_office_id: 1, p_period_id: null, p_starts_on: "2027-10-02", p_name: "ダイヤ修正" });
  await page.screenshot({ path: OUT + "period-admin.png", fullPage: true });
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("マスタの切替(管理画面): 次のマスタは、全部の区所にまとめて作れる(外すと、選んでいる区所だけ)", async () => {
  const { page, ctx, be, errors } = await open("admin.html", { userId: "a1", opts: { profile: ADMIN, twoOffices: true }, viewport: { width: 1200, height: 900 } });
  await page.click('.dtab[data-tab="master"]');
  await page.waitForSelector("#period-tabs .chip.add");
  // いちばん古いマスタ(区所ごとに日が違う)には出さない
  assert.ok(await page.isHidden("#period-all-label"));
  await page.click("#period-tabs .chip.add");
  assert.equal(await page.textContent("#period-all-text"), "全部の区所(3)に同じ切替日で作る");
  assert.ok(await page.isChecked("#period-all"));
  await page.fill("#period-date", "2027-03-14");
  await page.dispatchEvent("#period-date", "change");
  await page.screenshot({ path: OUT + "period-admin-all.png" });
  await page.click("#period-save");
  await page.waitForFunction(() => document.getElementById("period-message").textContent.includes("3区所の"));
  assert.ok((await page.textContent("#period-message")).includes("CSV は区所ごとです"));
  assert.deepEqual(be.st.calls.find((c) => c.path === "/rest/v1/rpc/save_master_period_all").body,
    { p_old_starts_on: null, p_starts_on: "2027-03-14", p_name: "ダイヤ改正" });
  // チェックを外すと、選んでいる区所だけに作る
  await page.click("#period-tabs .chip.add");
  await page.uncheck("#period-all");
  await page.fill("#period-date", "2027-10-02");
  await page.click("#period-save");
  await page.waitForFunction(() => document.getElementById("period-message").textContent.includes("を作りました"));
  assert.equal(be.st.calls.filter((c) => c.path === "/rest/v1/rpc/save_master_period").length, 1);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("マスタの切替(管理画面): CSV の確認中にマスタを消すと、確認の表を消す(移った先のマスタを入れ替えない。AB1)", async () => {
  const adminPeriods = [{ id: 1, starts_on: "2026-10-03", name: "ダイヤ修正", count: 2 }, { id: 2, starts_on: "2027-03-14", name: "ダイヤ改正", count: 0 }];
  const { page, ctx, be, errors } = await open("admin.html", {
    userId: "a1", opts: { profile: ADMIN, adminPeriods, master: OLD_MASTER, affected: 2 }, viewport: { width: 1200, height: 900 },
  });
  await page.click('.dtab[data-tab="master"]');
  await page.waitForFunction(() => document.getElementById("master-count").textContent.startsWith("2件"));
  await page.click("#period-tabs .chip >> nth=1");
  await page.setInputFiles("#csv-file", { name: "m.csv", mimeType: "text/csv", buffer: Buffer.from("番号,種別,平日出勤,平日退勤,休日出勤,休日退勤\n7,日勤,8:00,17:00,,\n") });
  await page.waitForSelector("#csv-preview:not(.hidden)");
  page.removeAllListeners("dialog");
  const asked = [];
  page.on("dialog", (d) => { asked.push(d.message()); d.accept(); });
  await page.click("#period-delete");
  await page.waitForFunction(() => document.getElementById("period-message").textContent.includes("消しました"));
  assert.ok(await page.isHidden("#csv-preview"));
  assert.ok(!be.st.calls.some((c) => c.path === "/rest/v1/rpc/replace_shift_master"));
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("マスタの切替: 保存してある番号が一覧に無ければ、読み込んだときに一覧の番号に合わせる(「7」→「特7」。AB5)", async () => {
  const mm = String(thisMonth.m).padStart(2, "0");
  const master = [...OLD_MASTER, ...NEW_MASTER, { period_id: 2, code: "特7", kind: "日勤", weekday_start: "6:00", weekday_end: "14:00", holiday_start: "", holiday_end: "", stay: "", sort_order: 3 }];
  const records = [{ date: `${thisMonth.y}-${mm}-23`, code: "7", memo: "" }];
  const { page, ctx, errors } = await open("input.html", { userId: "u1", opts: { profile: USER, master, periods: SWITCH_PERIODS, records } });
  await page.waitForSelector("#register:not([disabled])");
  assert.equal(await page.locator("#list tr").nth(22).locator(".pick").textContent(), "特7");
  assert.ok((await page.textContent("#status")).includes("一覧の番号に合わせました: 23日「7」→「特7」"));
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("読み込みで合わせ直した番号(「7」→「特7」)が泊なら、翌日(非番)に残っていた番号とメモを消す(AD7)", async () => {
  const mm = String(thisMonth.m).padStart(2, "0");
  const master = [...OLD_MASTER, ...NEW_MASTER, { period_id: 2, code: "特7", kind: "泊", weekday_start: "9:00", weekday_end: "8:00", holiday_start: "", holiday_end: "", stay: "", sort_order: 3 }];
  const records = [{ date: `${thisMonth.y}-${mm}-23`, code: "7", memo: "" }, { date: `${thisMonth.y}-${mm}-24`, code: "9", memo: "13時 会議" }];
  const { page, ctx, errors } = await open("input.html", { userId: "u1", opts: { profile: USER, master, periods: SWITCH_PERIODS, records } });
  await page.waitForSelector("#register:not([disabled])");
  const row = page.locator("#list tr").nth(23);
  assert.equal(await row.locator(".memo input").inputValue(), "8:00");
  assert.ok(!(await row.textContent()).includes("9"));
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("勤務入力: 接続テストの前でも、区所を選んでいれば開けて「保存」できる(案内を出す)。区所が無ければ設定画面へ(AD2)", async () => {
  const a = await open("input.html", { userId: "u1", opts: { profile: USER, settings: { verified_at: null } } });
  await a.page.waitForSelector("#save:not([disabled])");
  assert.ok(a.page.url().endsWith("input.html"));
  assert.equal(await a.page.isVisible("#setup-note"), true);
  assert.deepEqual(a.errors, []);
  await a.ctx.close();
  const b = await open("input.html", { userId: "u1", opts: { profile: USER } });
  await b.page.waitForSelector("#save:not([disabled])");
  assert.equal(await b.page.isVisible("#setup-note"), false);
  await b.ctx.close();
  const c = await open("input.html", { userId: "u1", opts: { profile: USER, settings: { office_id: null, verified_at: null } } });
  await c.page.waitForURL(/settings\.html$/);
  await c.ctx.close();
});

await check("マスタの切替: CSV がまだ無い日のエラーは1行にまとめ、黄色(無くなった番号)にしない(AB6・AB7)", async () => {
  const mm = String(thisMonth.m).padStart(2, "0");
  const records = [21, 22, 23, 24].map((d) => ({ date: `${thisMonth.y}-${mm}-${d}`, code: "2", memo: "" }));
  const { page, ctx, errors } = await open("input.html", { userId: "u1", opts: { profile: USER, master: OLD_MASTER, periods: SWITCH_PERIODS, records } });
  await page.waitForSelector("#register:not([disabled])");
  const lines = await page.$$eval("#period-note p.error", (p) => p.map((x) => x.textContent));
  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith(`${thisMonth.m}/21〜${thisMonth.m}/24 の4日: `));
  assert.ok(!(await page.textContent("#period-note")).includes("新しいマスタに無い番号"));
  assert.ok(!(await page.locator("#list tr").nth(21).getAttribute("class")).includes("needtime"));
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("マスタの切替: 月末を今回はじめて泊にしたときは、翌月1日の用事のメモを非番のメモとみなさない(サーバーと同じ。AB2)", async () => {
  const next = new Date(thisMonth.y, thisMonth.m, 1);
  const nextFirst = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-01`;
  const last = new Date(thisMonth.y, thisMonth.m, 0).getDate();
  const periods = [{ id: 1, starts_on: "2000-01-01", name: "" }, { id: 2, starts_on: nextFirst, name: "ダイヤ改正" }];
  const records = [{ date: nextFirst, code: "", memo: "歯医者" }];
  const { page, ctx, errors } = await open("input.html", { userId: "u1", opts: { profile: USER, master: [...OLD_MASTER, ...NEW_MASTER], periods, records } });
  await page.waitForSelector("#register:not([disabled])");
  await pickCode(page, last, "2"); // 「2」は前のマスタだけにある泊
  assert.ok((await page.locator("#list tr").nth(last - 1).getAttribute("class")).includes("period-error"));
  assert.ok((await page.textContent("#period-note")).includes("この月を「保存」してから、翌月の画面で"));
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("マスタの切替(管理画面): 次のマスタの表は、前のマスタより増えた行が緑・変わった行が黄", async () => {
  const adminPeriods = [{ id: 1, starts_on: "2026-10-03", name: "ダイヤ修正", count: 2 }, { id: 2, starts_on: "2027-03-14", name: "ダイヤ改正", count: 2 }];
  const { page, ctx, errors } = await open("admin.html", {
    userId: "a1", opts: { profile: ADMIN, adminPeriods, master: [...OLD_MASTER, ...NEW_MASTER] }, viewport: { width: 1200, height: 900 },
  });
  await page.click('.dtab[data-tab="master"]');
  await page.waitForFunction(() => document.getElementById("master-count").textContent.startsWith("2件"));
  await page.click("#period-tabs .chip >> nth=1");
  assert.deepEqual(await page.$$eval("#master tr", (r) => r.map((x) => x.className)), ["changed", "added"]);
  assert.equal(await page.textContent("#master-diff"), "前のマスタ(2026年10月 ダイヤ修正)と比べて: 増えた 1(緑)・変わった 1(黄)・無くなった 1(2)");
  await page.screenshot({ path: OUT + "period-admin-diff.png", fullPage: true });
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("写真取込: 画面の読み込みに失敗したときは、取込の内容を捨てずに取っておく(K5)", async () => {
  const text = importText({ v: 1, y: nextMonth.y, m: nextMonth.m, d: { 5: ["25", ""] } });
  const { page, ctx } = await open("input.html#import=" + text, { userId: "u1", opts: { profile: USER, masterFail: true } });
  await page.waitForFunction(() => document.getElementById("status").className === "error");
  assert.equal(new URL(page.url()).hash, "");
  const kept = await page.evaluate(() => JSON.parse(sessionStorage.getItem("sf_import") || "null"));
  assert.equal(kept && kept.text, "import=" + text);
  await ctx.close();
});

await check("写真取込: 貼り付けで取込。違う文字はダイアログで知らせ、過ぎた月は取り込まない", async () => {
  const { page, ctx, errors } = await open("input.html", { userId: "u1", opts: { profile: USER, master: PHOTO_MASTER } });
  await page.waitForSelector("#register:not([disabled])");
  assert.equal(await page.getAttribute("#photo-import", "href"), "https://claude.ai/artifact/GivZHYnUXZoz4uqc9dWdXV");
  // 同じタブで開く(新しいタブだと、未登録の確認が出たのに画面が残り、変更が守られなくなる。K1・K2)
  assert.equal(await page.getAttribute("#photo-import", "target"), null);
  await page.click("#paste-import");
  await page.fill("#paste-text", "こんにちは");
  await page.click("#paste-run");
  assert.ok((await page.textContent("#paste-error")).includes("取込の文字ではありません"));
  await page.fill("#paste-text", "shiftflow-import:" + importText({ v: 1, y: 2026, m: 13, d: {} }));
  await page.click("#paste-run");
  assert.ok((await page.textContent("#paste-error")).includes("形が違います"));
  // 過ぎた月
  await page.fill("#paste-text", "shiftflow-import:" + importText({ v: 1, y: 2020, m: 1, d: { 1: ["25", ""] } }));
  await page.click("#paste-run");
  await page.waitForFunction(() => document.getElementById("status").className === "error");
  assert.ok((await page.textContent("#status")).includes("過ぎた月"));
  // 番号もメモも無い取込(0日分)は断る(M4)
  await page.click("#paste-import");
  await page.fill("#paste-text", "shiftflow-import:" + importText({ v: 1, y: nextMonth.y, m: nextMonth.m, d: { 2: ["", ""] } }));
  await page.click("#paste-run");
  await page.waitForFunction(() => document.getElementById("status").textContent.includes("取り込む日がありません"));
  // 正しい文字(先頭・末尾の空白や、リンクごと貼っても読む)
  page.removeAllListeners("dialog");
  page.on("dialog", (d) => d.accept());
  await page.click("#paste-import");
  await page.fill("#paste-text", "  https://fast4213-max.github.io/shiftflow/input.html#import=" + importText({ v: 1, y: nextMonth.y, m: nextMonth.m, d: { 3: ["25", "メモ<b>"] } }) + "\n");
  await page.click("#paste-run");
  await page.waitForFunction(() => document.getElementById("status").textContent.includes("写真取込: 1日分"));
  assert.equal(await page.locator("#list tr").nth(2).locator(".memo input").inputValue(), "メモ<b>");
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("写真取込: チャットの答えの文字(shiftflow:年-月・名前・日:番号)を貼ると取り込める。確認に年月と名前が出る(AA8)", async () => {
  const mm = String(nextMonth.m).padStart(2, "0");
  const asked = [];
  const { page, ctx, errors } = await open("input.html", {
    userId: "u1",
    opts: { profile: USER, master: PHOTO_MASTER },
    beforeLoad: async (p) => { p.removeAllListeners("dialog"); p.on("dialog", (d) => { asked.push(d.message()); d.accept(); }); },
  });
  await page.waitForSelector("#register:not([disabled])");
  await page.click("#paste-import");
  // 指示文と答えの両方を貼っても、最後の年月の行から読み、閉じの ``` で止まる(AA2)
  await page.fill("#paste-text", [
    "```", `shiftflow:${nextMonth.y}-${mm}`, "名前:読んだ行の名前", "1:15", "2:〜", "3:特休", "```",
    "", "```", `shiftflow:${nextMonth.y}-${mm}`, "名前:山田 太郎", "5:25", "６：公休", "7:", "```", "8:99",
  ].join("\n"));
  await page.click("#paste-run");
  await page.waitForFunction(() => document.getElementById("status").textContent.includes("「山田 太郎」の行の2日分を入れました"));
  assert.equal(asked.length, 1);
  assert.ok(asked[0].includes(`${nextMonth.y}年${nextMonth.m}月`) && asked[0].includes("山田 太郎") && asked[0].includes("2日分"), asked[0]);
  assert.equal(await page.locator("#list tr").nth(4).locator(".pick").textContent(), "25");
  assert.equal(await page.locator("#list tr").nth(5).locator(".pick").textContent(), "公休");
  assert.equal(await page.locator("#list tr.imported").count(), 2);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("写真取込: 指示文の例(名前:読んだ行の名前)をコピーして貼ったときは断る。年月の行が無いときも案内を出す(AA2・AA6)", async () => {
  const mm = String(nextMonth.m).padStart(2, "0");
  const { page, ctx, errors } = await open("input.html", { userId: "u1", opts: { profile: USER, master: PHOTO_MASTER } });
  await page.waitForSelector("#register:not([disabled])");
  await page.click("#paste-import");
  await page.fill("#paste-text", ["```", `shiftflow:${nextMonth.y}-${mm}`, "名前:読んだ行の名前", "1:15", "2:〜", "3:特休", "```"].join("\n"));
  await page.click("#paste-run");
  assert.ok((await page.textContent("#paste-error")).includes("指示文の例をコピーしています"));
  assert.ok(await page.isVisible("#paste-dialog"));
  await page.fill("#paste-text", "1:15\n2:〜");
  await page.click("#paste-run");
  assert.ok((await page.textContent("#paste-error")).includes("(年と月の行)がありません"));
  assert.equal(await page.locator("#list tr.imported").count(), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("勤務入力: 登録していない変更があるとき、リンクの確認で OK を押しても移らなかったら、変更を残す。戻ったときに読み直さない(AA9)", async () => {
  const { page, ctx, errors } = await open("input.html", { userId: "u1", opts: { profile: USER } });
  await page.waitForSelector("#register:not([disabled])");
  await page.locator("td.memo input").first().fill("メモ");
  page.removeAllListeners("dialog");
  const asked = [];
  page.on("dialog", (d) => { asked.push(d.message()); d.accept(); });
  // 確認の後で移動が止まった(Android で Claude のアプリが開き、この画面が残る)ようすにする
  await page.evaluate(() => document.addEventListener("click", (ev) => { if (ev.target.closest("a[href]")) ev.preventDefault(); }, true));
  await page.click('nav.topbar a[href="settings.html"]');
  assert.deepEqual(asked, ["登録していない変更があります。移動しますか？"]);
  assert.ok(page.url().includes("input.html"));
  // 画面が隠れて、しばらくして戻る
  await page.evaluate(() => {
    let state = "hidden";
    Object.defineProperty(document, "visibilityState", { get: () => state, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    const now = Date.now;
    Date.now = () => now() + 5000;
    state = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForFunction(() => document.getElementById("status").textContent.includes("登録していない変更があります"));
  assert.equal(await page.locator("td.memo input").first().inputValue(), "メモ");
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("管理画面: マスタを読み込めていないときは「CSVで保存」で前の区所のマスタを保存しない(S4)", async () => {
  const { page, ctx } = await open("admin.html", { userId: "a1", opts: { profile: ADMIN, masterFail: true }, viewport: { width: 1200, height: 900 } });
  await page.waitForSelector("#message.error");
  await page.click('.dtab[data-tab="master"]');
  const download = page.waitForEvent("download", { timeout: 1500 }).then(() => true, () => false);
  await page.click("#csv-download");
  assert.equal(await download, false);
  assert.ok((await page.textContent("#message")).includes("読み込めていません"));
  // 読み込みに失敗したとき、前の区所の表と件数を残さない(U2)
  assert.equal(await page.locator("#master tr").count(), 0);
  assert.equal(await page.textContent("#master-count"), "読み込み中…");
  await ctx.close();
});

// ---------- お問い合わせ(ログイン前) ----------
await check("お問い合わせ(ログイン前): 入力の確かめ・送信・受付番号と確認コード・返事を見る", async () => {
  const { page, ctx, be, errors } = await open("contact.html");
  await page.waitForSelector("#contact-form:not(.hidden)");
  assert.ok(await page.isVisible("#guest-fields"));
  assert.ok(!(await page.isVisible("#member-fields")));
  assert.deepEqual(await page.$$eval("#office option", (o) => o.map((x) => x.value)), ["", "A区所", "B区所", "わからない"]);
  assert.ok((await page.textContent("#contact-form")).includes("「ファイル」から選ぶと、送れないことがあります"));
  await page.click("#submit");
  assert.equal(await page.textContent("#message"), "社員番号は7桁の数字で入力してください。");
  await page.fill("#employee-no", "１２３４５６７");
  await page.fill("#name", "山田 太郎");
  await page.selectOption("#office", "A区所");
  await page.selectOption("#kind", "login");
  await page.fill("#body", "PINを忘れました");
  assert.equal(await page.textContent("#body-count"), "9");
  await page.screenshot({ path: OUT + "contact-guest.png", fullPage: true });
  // 二度押し
  await page.click("#submit");
  await page.click("#submit", { force: true, trial: false }).catch(() => {});
  await page.waitForSelector("#sent:not(.hidden)");
  const submits = be.st.calls.filter((c) => c.path === "/functions/v1/contact" && c.body.action === "submit");
  assert.equal(submits.length, 1);
  const p = submits[0].body;
  assert.equal(p.mode, "guest");
  assert.equal(p.employee_no, "1234567");
  assert.match(p.request_key, /^[0-9a-f-]{36}$/);
  assert.match(p.code, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(p.email, undefined);
  assert.deepEqual(p.images, []);
  assert.equal(await page.textContent("#sent-no"), "#0012");
  const shown = await page.textContent("#sent-code-value");
  assert.equal(shown.replace("-", ""), p.code);
  await page.screenshot({ path: OUT + "contact-sent.png", fullPage: true });
  // 返事を見る(違うコード → エラー、正しいコード → 返事。HTML は文字のまま)
  await page.fill("#view-no", "#0012");
  await page.fill("#view-code", "AAAA-AAAA");
  await page.click("#view-button");
  await page.waitForSelector("#view-message.error");
  await page.fill("#view-code", "k7qm-4xpa");
  await page.click("#view-button");
  await page.waitForSelector("#view-result .bubble.from-admin");
  assert.ok((await page.textContent("#view-result")).includes("<script>x</script>直接伝えます"));
  // 別の問い合わせ: 新しいキーとコードになる
  await page.click("#again");
  assert.equal(await page.inputValue("#body"), "");
  await page.fill("#body", "2件目");
  await page.selectOption("#kind", "other");
  await page.click("#submit");
  await page.waitForSelector("#sent:not(.hidden)");
  const s2 = be.st.calls.filter((c) => c.body?.action === "submit")[1].body;
  assert.notEqual(s2.request_key, p.request_key);
  assert.notEqual(s2.code, p.code);
  assert.deepEqual(errors.filter((e) => !e.includes("404")), []);
  await ctx.close();
});

await check("お問い合わせ: メールを選ぶと欄と迷惑メールの注意が出る。2回の不一致・規格外のアドレスの注意。画面に戻すとアドレスは送らない(C7・C9)", async () => {
  const { page, ctx, be, errors } = await open("contact.html");
  await page.waitForSelector("#contact-form:not(.hidden)");
  await page.fill("#employee-no", "1234567");
  await page.fill("#name", "山田");
  await page.selectOption("#office", "わからない");
  await page.selectOption("#kind", "bug");
  await page.fill("#body", "x");
  assert.equal(await page.isVisible("#email-fields"), false);
  await page.check('input[name="reply-via"][value="mail"]');
  assert.ok(await page.isVisible("#email-fields"));
  assert.ok((await page.textContent("#email-fields")).includes("shiftflow.kinmu@gmail.com"));
  assert.ok((await page.textContent("#email-fields")).includes("迷惑メール"));
  await page.fill("#email", "taro..x@docomo.ne.jp");
  assert.ok(await page.isVisible("#email-risky"));
  await page.fill("#email", "Taro@Gmail.com");
  assert.equal(await page.isVisible("#email-risky"), false);
  await page.fill("#email2", "taro@gmail.co");
  await page.click("#submit");
  assert.equal(await page.textContent("#message"), "メールアドレスが1回目と2回目で違います。");
  await page.fill("#email2", "ｔａｒｏ＠gmail.com");
  await page.screenshot({ path: OUT + "contact-mail.png", fullPage: true });
  await page.check('input[name="reply-via"][value="screen"]');
  await page.click("#submit");
  await page.waitForSelector("#sent:not(.hidden)");
  const p = be.st.calls.find((c) => c.body?.action === "submit").body;
  assert.equal(p.reply_via, "screen");
  assert.equal(p.email, undefined);
  assert.deepEqual(errors, []);
  await ctx.close();

  const r2 = await open("contact.html");
  await r2.page.waitForSelector("#contact-form:not(.hidden)");
  await r2.page.fill("#employee-no", "1234567");
  await r2.page.fill("#name", "山田");
  await r2.page.selectOption("#office", "A区所");
  await r2.page.selectOption("#kind", "bug");
  await r2.page.fill("#body", "x");
  await r2.page.check('input[name="reply-via"][value="mail"]');
  await r2.page.fill("#email", "taro@gmail.com");
  await r2.page.fill("#email2", "taro@gmail.com");
  await r2.page.click("#submit");
  await r2.page.waitForSelector("#sent:not(.hidden)");
  assert.ok(await r2.page.isVisible("#sent-mail"));
  assert.equal(await r2.page.isVisible("#sent-code"), false);
  assert.equal(await r2.page.textContent("#sent-email"), "taro@gmail.com");
  const p2 = r2.be.st.calls.find((c) => c.body?.action === "submit").body;
  assert.equal(p2.email, "taro@gmail.com");
  assert.equal(p2.code, undefined);
  await r2.page.screenshot({ path: OUT + "contact-sent-mail.png", fullPage: true });
  await r2.ctx.close();
});

await check("お問い合わせ: 画像を縮小して JPEG で送る。画像でないファイルは外す。3枚まで。外せる(I1・I3・I6・I11)", async () => {
  const { page, ctx, be, errors } = await open("contact.html");
  await page.waitForSelector("#contact-form:not(.hidden)");
  await page.setInputFiles("#image-input", [DIR + "big.png", DIR + "fake.jpg"]);
  await page.waitForFunction(() => document.querySelectorAll("#thumbs .thumb").length === 1 && document.getElementById("image-message").classList.contains("error"));
  assert.ok((await page.textContent("#image-message")).includes("この画像は使えません: fake.jpg"));
  await page.setInputFiles("#image-input", [DIR + "big.png"]); // 同じ画像はもう一度入れない
  await page.waitForTimeout(300);
  assert.equal(await page.locator("#thumbs .thumb").count(), 1);
  await page.setInputFiles("#image-input", [DIR + "photo.jpg"]);
  await page.waitForFunction(() => document.querySelectorAll("#thumbs .thumb").length === 2);
  // 3枚目(別のファイルとして) → 追加ボタンが消える
  await page.setInputFiles("#image-input", [{ name: "photo2.jpg", mimeType: "image/jpeg", buffer: fs.readFileSync(DIR + "photo.jpg") }]);
  await page.waitForFunction(() => document.querySelectorAll("#thumbs .thumb").length === 3);
  assert.equal(await page.isVisible("#add-image"), false);
  await page.screenshot({ path: OUT + "contact-images.png", fullPage: true });
  await page.click("#thumbs .thumb >> nth=2 >> .thumb-remove");
  assert.equal(await page.locator("#thumbs .thumb").count(), 2);
  assert.ok(await page.isVisible("#add-image"));
  await page.fill("#employee-no", "1234567");
  await page.fill("#name", "山田");
  await page.selectOption("#office", "A区所");
  await page.selectOption("#kind", "bug");
  await page.fill("#body", "画面が真っ白");
  await page.click("#submit");
  await page.waitForSelector("#sent:not(.hidden)");
  const p = be.st.calls.find((c) => c.body?.action === "submit").body;
  assert.equal(p.images.length, 2);
  for (const img of p.images) {
    const bytes = Buffer.from(img.data, "base64");
    assert.deepEqual([...bytes.subarray(0, 3)], [0xff, 0xd8, 0xff]); // JPEG
    assert.ok(bytes.length < 600_000, "size " + bytes.length);
  }
  // 3000x2000 の PNG は長い辺 1600 に縮む
  const first = Buffer.from(p.images[0].data, "base64");
  let i = 2, w = 0, h = 0;
  while (i < first.length) { if (first[i] === 0xff && first[i + 1] >= 0xc0 && first[i + 1] <= 0xc2) { h = first.readUInt16BE(i + 5); w = first.readUInt16BE(i + 7); break; } i += 2 + first.readUInt16BE(i + 2); }
  assert.deepEqual([w, h], [1600, 1067]);
  assert.ok((await page.textContent("#sent-images")).includes("画像も届きました"));
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("お問い合わせ: 読み直しても書いた内容が残る(C3)。所属の一覧が読めなくても「わからない」で送れる(C14)", async () => {
  const { page, ctx, errors } = await open("contact.html", { opts: { officesFail: true } });
  await page.waitForSelector("#contact-form:not(.hidden)");
  assert.deepEqual(await page.$$eval("#office option", (o) => o.map((x) => x.value)), ["", "わからない"]);
  await page.fill("#employee-no", "7654321");
  await page.fill("#name", "佐藤");
  await page.selectOption("#office", "わからない");
  await page.selectOption("#kind", "howto");
  await page.fill("#body", "下書きのテスト");
  await page.reload();
  await page.waitForSelector("#contact-form:not(.hidden)");
  assert.equal(await page.inputValue("#body"), "下書きのテスト");
  assert.equal(await page.inputValue("#employee-no"), "7654321");
  assert.equal(await page.inputValue("#kind"), "howto");
  assert.equal(await page.inputValue("#office"), "わからない");
  assert.deepEqual(errors.filter((e) => !e.includes("500")), []);
  await ctx.close();
});

// ---------- ログイン後 ----------
await check("ログイン後: メニューに お知らせ(未読の赤い点)・お問い合わせ。社員番号などは自動。送る値に社員番号を入れない", async () => {
  const { page, ctx, be, errors } = await open("contact.html", { userId: "u1", opts: { profile: USER } });
  await page.waitForSelector("#contact-form:not(.hidden)");
  const nav = await page.$$eval(".topbar a", (a) => a.map((x) => x.textContent));
  assert.deepEqual(nav, ["shiftflow", "勤務入力", "カレンダー", "設定", "お知らせ", "お問い合わせ", "使い方", "ログアウト"]);
  await page.waitForSelector("#nav-notices.has-dot");
  assert.equal(await page.textContent("#member-no"), "1234567");
  assert.equal(await page.textContent("#member-name"), "山田 太郎");
  assert.equal(await page.textContent("#member-office"), "A区所");
  assert.equal(await page.isVisible("#guest-fields"), false);
  assert.equal(await page.isVisible("#view-section"), false);
  await page.waitForSelector("#mine .bubble.from-admin");
  await page.selectOption("#kind", "howto");
  await page.fill("#body", "質問です");
  await page.screenshot({ path: OUT + "contact-member.png", fullPage: true });
  await page.click("#submit");
  await page.waitForSelector("#sent:not(.hidden)");
  const call = be.st.calls.find((c) => c.body?.action === "submit");
  assert.equal(call.body.mode, "member");
  assert.equal(call.body.employee_no, undefined);
  assert.equal(call.body.code, undefined);
  assert.ok(call.auth.includes(".sig")); // ログインのトークンで送っている
  assert.ok(await page.isVisible("#sent-member"));
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("ログイン後: ログインが切れていたら、ログイン画面へ飛ばず、書いた内容を残して知らせる(C3)", async () => {
  const { page, ctx } = await open("contact.html", { userId: "u1", opts: { profile: USER, submitError: { error: "ログインし直してください。", code: "unauthenticated", status: 401 } } });
  await page.waitForSelector("#contact-form:not(.hidden)");
  await page.selectOption("#kind", "howto");
  await page.fill("#body", "消えないで");
  await page.click("#submit");
  await page.waitForSelector("#message.error");
  assert.ok((await page.textContent("#message")).includes("書いた内容は残してあります"));
  assert.ok(page.url().endsWith("contact.html"));
  assert.equal(await page.inputValue("#body"), "消えないで");
  await ctx.close();
});

await check("お知らせのページ: 全部出し(NEW付き)、見たら赤い点が消える(N7・N8)", async () => {
  const { page, ctx, errors } = await open("notices.html", { userId: "u1", opts: { profile: USER } });
  await page.waitForSelector("#notices .card");
  assert.equal(await page.locator("#notices .card").count(), 4);
  assert.equal(await page.locator(".notice-new").count(), 4);
  assert.equal(await page.locator("#nav-notices.has-dot").count(), 0);
  await page.screenshot({ path: OUT + "notices.png", fullPage: true });
  await page.goto(BASE + "/contact.html");
  await page.waitForSelector("#contact-form:not(.hidden)");
  await page.waitForTimeout(800);
  assert.equal(await page.locator("#nav-notices.has-dot").count(), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("管理者がお問い合わせ・お知らせのページを開いたら、案内を出す / 管理画面へ(N10)", async () => {
  const { page, ctx } = await open("contact.html", { userId: "a1", opts: { profile: ADMIN } });
  await page.waitForSelector("#admin-note:not(.hidden)");
  assert.equal(await page.isVisible("#contact-form"), false);
  await page.goto(BASE + "/notices.html");
  await page.waitForURL(/admin\.html/);
  await ctx.close();
});

// ---------- 管理画面 ----------
await check("管理画面: お問い合わせタブの件数・GAS が止まっている注意・やり取り(文字のまま)・PIN の確かめ・返事", async () => {
  const { page, ctx, be, errors } = await open("admin.html", { userId: "a1", opts: { profile: ADMIN }, viewport: { width: 1200, height: 900 } });
  await page.waitForSelector("#contact-badge:not(.hidden)");
  assert.equal(await page.textContent("#contact-badge"), "2");
  assert.ok((await page.textContent("#contact-alert")).includes("未対応のお問い合わせが 2件"));
  await page.click('.dtab[data-tab="contact"]');
  await page.waitForSelector(".contact-item");
  assert.ok((await page.textContent("#contact-status")).includes("30分以上止まっています"));
  await page.click(".contact-item >> nth=0");
  await page.waitForSelector("#contact-detail .bubble");
  assert.equal(await page.locator("#contact-detail img").count(), 0);
  const detail = await page.textContent("#contact-detail");
  assert.ok(detail.includes("<img src=x onerror=alert(2)>ありがとう"));
  assert.ok(detail.includes("ログイン前の問い合わせです"));
  assert.ok(detail.includes("違う人からのメール"));
  assert.ok(detail.includes("送れませんでした: 1日の上限"));
  assert.ok(detail.includes("登録あり"));
  const gmail = await page.getAttribute("#contact-detail a.gmail-link >> nth=0", "href");
  assert.ok(gmail.startsWith("https://mail.google.com/mail/u/?authuser=shiftflow.kinmu%40gmail.com#all/r1"), gmail);
  await page.click("text=全文を見る");
  assert.ok((await page.textContent("#contact-detail")).includes("> 引用"));
  await page.screenshot({ path: OUT + "admin-contact.png", fullPage: true });
  // 4桁の数字 → 確かめのダイアログ(いいえ → 送らない)
  await page.fill(".reply-form textarea", "仮のPINは 1234 です");
  await page.click("text=返事を送る");
  await page.waitForTimeout(300);
  assert.ok(errors.some((e) => e.startsWith("dialog: ログイン前の問い合わせ")));
  assert.equal(be.st.calls.filter((c) => c.body?.action === "reply").length, 0);
  errors.length = 0;
  await page.fill(".reply-form textarea", "直接お伝えします");
  await page.click("text=返事を送る");
  await page.waitForSelector("#contact-detail-message.ok");
  const reply = be.st.calls.find((c) => c.body?.action === "reply").body;
  assert.equal(reply.via, "mail");
  assert.equal(reply.id, 12);
  assert.match(reply.request_key, /^[0-9a-f-]{36}$/);
  await page.click("text=もう一度送る");
  await page.waitForTimeout(300);
  assert.equal(be.st.calls.filter((c) => c.body?.action === "resend").length, 1);
  // 受信メール
  await page.click('.chip[data-filter="unmatched"]');
  await page.waitForSelector(".unmatched");
  await page.fill(".unmatched textarea", "回答です");
  await page.click(".unmatched >> text=返信する");
  await page.waitForSelector("#contact-list-message.ok");
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("管理画面: 前の返事がもう届いていて文が違うときは、直した文は送っていないと知らせる(Q6)", async () => {
  const { page, ctx } = await open("admin.html", { userId: "a1", opts: { profile: ADMIN, replyDuplicate: true }, viewport: { width: 1200, height: 900 } });
  await page.click('.dtab[data-tab="contact"]');
  await page.click(".contact-item >> nth=0");
  await page.waitForSelector(".reply-form textarea");
  await page.fill(".reply-form textarea", "直した文");
  await page.click("text=返事を送る");
  await page.waitForSelector("#contact-detail-message.error");
  assert.ok((await page.textContent("#contact-detail-message")).includes("直した文は送っていません"));
  await ctx.close();
});

await check("管理画面: 区所の名前は60文字まで(Q9)", async () => {
  const { page, ctx, be } = await open("admin.html", { userId: "a1", opts: { profile: ADMIN }, viewport: { width: 1200, height: 900 } });
  await page.waitForSelector("#new-office", { state: "attached" });
  assert.equal(await page.getAttribute("#new-office", "maxlength"), "60");
  await ctx.close();
  void be;
});

await check("お知らせの本文: https:// の URL は押せるリンクになる(句読点は含めない・HTML は読まない・途中で切っても壊れない)", async () => {
  const { page, ctx, errors } = await open("index.html");
  const r = await page.evaluate(async () => {
    const m = await import("/js/app.js");
    const e = m.noticeElement({ title: "t", body: "動画 https://drive.google.com/file/d/abc/view?usp=sharing 。<b>x</b> http://no.link/ javascript:alert(1)", level: "info", starts_on: "2026-10-15" });
    const c = m.noticeElement({ title: "t", body: "あ".repeat(5) + "https://example.com/abcdefghij" + "い".repeat(5), level: "info", starts_on: "2026-10-15" }, { clamp: 10 });
    const k = m.noticeElement({ title: "t", body: "(https://) と https:// だけ", level: "info", starts_on: "2026-10-15" });
    // URL が切れ目をまたいで最後まで続くときは、全部出して「続きを読む」を付けない(AD9)
    const tail = m.noticeElement({ title: "t", body: "あ".repeat(5) + "https://example.com/abcdefghij", level: "info", starts_on: "2026-10-15" }, { clamp: 10 });
    return {
      broken: k.querySelectorAll("a").length,
      tailMore: tail.querySelectorAll("button").length,
      tailText: tail.querySelector(".notice-body").textContent,
      links: [...e.querySelectorAll("a")].map((a) => [a.href, a.target, a.rel]),
      bold: e.querySelectorAll("b").length,
      clamp: [...c.querySelectorAll("a")].map((a) => a.textContent),
    };
  });
  assert.deepEqual(r.links, [["https://drive.google.com/file/d/abc/view?usp=sharing", "_blank", "noopener noreferrer"]]);
  assert.equal(r.bold, 0);
  assert.equal(r.broken, 0);
  assert.equal(r.tailMore, 0);
  assert.ok(!r.tailText.endsWith("…"));
  assert.deepEqual(r.clamp, ["https://example.com/abcdefghij"]);
  assert.deepEqual(errors, []);
  await ctx.close();
});

const GUIDES = [
  { label: "新規登録のしかた", url: "https://drive.google.com/file/d/AAA/view?usp=sharing" },
  { label: "写真取込のしかた", url: "https://drive.google.com/file/d/BBB/view" },
  { label: "隠したもの", url: "https://drive.google.com/file/d/CCC/view", visible: false },
  { label: "まとめ(文書)", url: "https://drive.google.com/file/d/DDD/view", kind: "doc" },
];

await check("使い方リンク: ログイン画面のカードの下に、並びどおり・表示中だけ・別タブのリンクで出る。0件・読めないときは枠ごと出ない", async () => {
  const { page, ctx, errors } = await open("index.html", { opts: { guides: GUIDES } });
  await page.waitForSelector("#login-guide:not(.hidden) .guide-link");
  const links = await page.$$eval("#login-guide .guide-link", (as) => as.map((a) => [a.textContent, a.href, a.target, a.rel]));
  assert.deepEqual(links, [
    ["▶\uFE0E新規登録のしかた", GUIDES[0].url, "_blank", "noopener noreferrer"],
    ["▶\uFE0E写真取込のしかた", GUIDES[1].url, "_blank", "noopener noreferrer"],
    ["📄まとめ(文書)", GUIDES[3].url, "_blank", "noopener noreferrer"],
  ]);
  // カード(利用者のフォーム)より下
  assert.ok(await page.evaluate(() => document.getElementById("user-form").compareDocumentPosition(document.getElementById("login-guide")) & Node.DOCUMENT_POSITION_FOLLOWING));
  assert.equal(await page.locator("#login-guide .guide-icon[aria-hidden=true]").count(), 3);
  // 管理タブでは隠し、利用者タブに戻すと出る
  await page.click("#tab-admin");
  assert.equal(await page.isVisible("#login-guide"), false);
  await page.click("#tab-user");
  assert.equal(await page.isVisible("#login-guide"), true);
  await page.screenshot({ path: OUT + "login-guide.png", fullPage: true });
  assert.deepEqual(errors, []);
  await ctx.close();
  for (const opts of [{}, { guides: GUIDES, guidesFail: true }]) {
    const o = await open("index.html", { opts });
    await o.page.waitForSelector("#login-notices:not(.hidden)");
    await o.page.waitForTimeout(300);
    assert.equal(await o.page.locator("#login-guide .guide-link").count(), 0);
    assert.equal(await o.page.isVisible("#login-guide"), false);
    assert.deepEqual(o.errors, []);
    await o.ctx.close();
  }
});

await check("使い方リンク: 管理タブで開いたとき(index.html#admin)は、枠が出ない", async () => {
  const { page, ctx, errors } = await open("index.html#admin", { opts: { guides: GUIDES } });
  await page.waitForSelector("#login-guide .guide-link", { state: "attached" }); // 読み込み済み(でも見えない)
  assert.equal(await page.isVisible("#tab-admin.active"), true);
  assert.equal(await page.isVisible("#login-guide"), false);
  await page.click("#tab-user");
  assert.equal(await page.isVisible("#login-guide"), true);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("使い方リンク: お知らせ画面・使い方ページにも出る。幅320pxではみ出さない", async () => {
  const long = [{ label: "とても長い名前をつけた動画のリンク", url: "https://drive.google.com/file/d/" + "x".repeat(200) }];
  for (const [path, opts] of [["notices.html", { profile: USER }], ["help.html", {}]]) {
    const { page, ctx, errors } = await open(path, { userId: path === "notices.html" ? "u1" : null, opts: { ...opts, guides: long }, viewport: { width: 320, height: 700 } });
    await page.waitForSelector("#guide .guide-link");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), path + " が横にはみ出す");
    assert.deepEqual(errors, []);
    await ctx.close();
  }
});

await check("管理画面: 使い方リンクを足す・直す・並べ替える・隠す・消す。https 以外と10件超は止める", async () => {
  const { page, ctx, be, errors } = await open("admin.html#notices", { userId: "a1", opts: { profile: ADMIN, guides: GUIDES }, viewport: { width: 1200, height: 900 } });
  await page.waitForSelector("#guide-list .notice-admin-row");
  assert.equal(await page.locator("#guide-list .notice-admin-row").count(), 4);
  // URL の欄も、他の欄と同じ大きさ(iPhone で拡大されない16px。AD4)
  assert.equal(await page.$eval("#guide-url", (e) => getComputedStyle(e).fontSize), "16px");
  // 誤り
  await page.click("#guide-save");
  assert.equal(await page.textContent("#guide-message"), "表示名を入力してください。");
  await page.fill("#guide-label", "新しい動画");
  await page.fill("#guide-url", "http://example.com/a");
  await page.click("#guide-save");
  assert.ok((await page.textContent("#guide-message")).includes("https://"));
  await page.fill("#guide-url", "javascript:alert(1)");
  await page.click("#guide-save");
  assert.ok((await page.textContent("#guide-message")).includes("https://"));
  assert.ok(!be.st.calls.some((c) => c.path === "/rest/v1/guide_links" && c.method === "POST"));
  // 足す
  await page.fill("#guide-url", "https://drive.google.com/file/d/EEE/view");
  await page.click("#guide-save");
  await page.waitForSelector("#guide-message.ok");
  const post = be.st.calls.find((c) => c.path === "/rest/v1/guide_links" && c.method === "POST").body;
  assert.deepEqual({ ...post }, { label: "新しい動画", url: "https://drive.google.com/file/d/EEE/view", kind: "video", sort_order: 5 });
  await page.waitForFunction(() => document.querySelectorAll("#guide-list .notice-admin-row").length === 5);
  // 直す
  await page.click("#guide-list .notice-admin-row:nth-child(5) >> text=編集");
  assert.equal(await page.inputValue("#guide-label"), "新しい動画");
  await page.fill("#guide-label", "直した動画");
  await page.click("#guide-save");
  await page.waitForSelector("#guide-message.ok");
  assert.equal(be.st.guides.find((g) => g.label === "直した動画").url, "https://drive.google.com/file/d/EEE/view");
  // 並べ替え(先頭の↑は押せない。2番目を上へ)
  assert.equal(await page.locator("#guide-list .notice-admin-row:nth-child(1) button:has-text('↑')").isDisabled(), true);
  await page.click("#guide-list .notice-admin-row:nth-child(2) button:has-text('↑')");
  await page.waitForFunction(() => document.querySelector("#guide-list .notice-admin-row strong").textContent.includes("写真取込"));
  // 隠す → 表示するもの(RPC)から消える
  await page.click("#guide-list .notice-admin-row:nth-child(1) button:has-text('隠す')");
  await page.waitForFunction(() => document.querySelector("#guide-list .notice-admin-row .status-badge").textContent === "非表示");
  assert.equal(be.st.guides.filter((g) => g.visible).length, 3);
  // 消す
  page.removeAllListeners("dialog");
  page.on("dialog", (d) => d.accept());
  await page.click("#guide-list .notice-admin-row:nth-child(1) button:has-text('削除')");
  await page.waitForFunction(() => document.querySelectorAll("#guide-list .notice-admin-row").length === 4);
  await page.screenshot({ path: OUT + "admin-guide.png", fullPage: true });
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("管理画面: 使い方リンクが10件あるときは、足せない", async () => {
  const ten = Array.from({ length: 10 }, (_, i) => ({ label: "L" + i, url: "https://example.com/" + i }));
  const { page, ctx, be, errors } = await open("admin.html#notices", { userId: "a1", opts: { profile: ADMIN, guides: ten }, viewport: { width: 1200, height: 900 } });
  await page.waitForFunction(() => document.querySelectorAll("#guide-list .notice-admin-row").length === 10);
  await page.fill("#guide-label", "11件目");
  await page.fill("#guide-url", "https://example.com/11");
  await page.click("#guide-save");
  assert.ok((await page.textContent("#guide-message")).includes("10件まで"));
  assert.ok(!be.st.calls.some((c) => c.path === "/rest/v1/guide_links" && c.method === "POST"));
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("管理画面: お知らせを出す・直す・消す。期間の誤りは止める", async () => {
  const { page, ctx, be, errors } = await open("admin.html#notices", { userId: "a1", opts: { profile: ADMIN }, viewport: { width: 1200, height: 900 } });
  await page.waitForSelector("#notice-list .notice-admin-row");
  assert.equal(await page.inputValue("#notice-start"), today);
  assert.ok((await page.textContent("label[for=notice-body]")).includes("https://"));
  await page.click("#notice-save");
  assert.equal(await page.textContent("#notice-message"), "タイトルを入力してください。");
  await page.fill("#notice-title", "新しいお知らせ");
  await page.fill("#notice-body", "本文");
  await page.check('input[name="notice-level"][value="important"]');
  await page.fill("#notice-end", "2000-01-01");
  await page.click("#notice-save");
  assert.ok((await page.textContent("#notice-message")).includes("始まりの日と同じか、それより後"));
  await page.fill("#notice-end", "");
  await page.click("#notice-save");
  await page.waitForSelector("#notice-message.ok");
  const post = be.st.calls.find((c) => c.path === "/rest/v1/notices" && c.method === "POST").body;
  assert.deepEqual({ ...post }, { title: "新しいお知らせ", body: "本文", level: "important", starts_on: today, ends_on: null });
  await page.click("#notice-list >> text=編集 >> nth=0");
  assert.equal(await page.inputValue("#notice-title"), "新しいお知らせ");
  await page.fill("#notice-title", "直したお知らせ");
  await page.click("#notice-save");
  await page.waitForSelector("#notice-message.ok");
  assert.ok(be.st.calls.some((c) => c.path === "/rest/v1/notices" && c.method === "PATCH"));
  await page.screenshot({ path: OUT + "admin-notices.png", fullPage: true });
  assert.deepEqual(errors, []);
  page.on("dialog", (d) => d.accept());
  await ctx.close();
});

await check("管理画面: 直している間にお知らせが消されていたら、「直しました」と出さず、書いた内容を残して新しく出せる(V3)", async () => {
  const { page, ctx, be, errors } = await open("admin.html#notices", { userId: "a1", opts: { profile: ADMIN }, viewport: { width: 1200, height: 900 } });
  await page.waitForSelector("#notice-list .notice-admin-row");
  await page.click("#notice-list >> text=編集 >> nth=0");
  const id = be.st.notices[0].id;
  be.st.notices = be.st.notices.filter((n) => n.id !== id); // 別のタブで消された
  await page.fill("#notice-title", "直したお知らせ");
  await page.click("#notice-save");
  await page.waitForSelector("#notice-message.error");
  assert.ok((await page.textContent("#notice-message")).includes("見つかりません"));
  assert.equal(await page.inputValue("#notice-title"), "直したお知らせ");
  assert.equal(await page.textContent("#notice-save"), "保存して公開");
  await page.click("#notice-save");
  await page.waitForSelector("#notice-message.ok");
  assert.ok((await page.textContent("#notice-message")).startsWith("公開しました。"));
  assert.equal(be.st.calls.filter((c) => c.path === "/rest/v1/notices" && c.method === "POST").length, 1);
  assert.deepEqual(errors, []);
  await ctx.close();
});

// ---------- 通信まわり(G・H・I・J) ----------
await check("管理画面: URL に #users が付いていても、読み込み失敗の理由が消えない。英語の通信エラーは日本語にする(G・J)", async () => {
  const a = await open("admin.html#users", { userId: "a1", opts: { profile: ADMIN, statsFail: true }, viewport: { width: 1200, height: 900 } });
  await a.page.waitForFunction(() => document.getElementById("message").textContent.includes("statement timeout"));
  assert.ok((await a.page.textContent("#message")).includes("statement timeout"));
  assert.ok((await a.page.getAttribute("#message", "class")).includes("error"));
  await a.ctx.close();
  const b = await open("admin.html#users", { userId: "a1", opts: { profile: ADMIN, statsAbort: true }, viewport: { width: 1200, height: 900 } });
  await b.page.waitForFunction(() => document.getElementById("message").textContent.includes("通信に失敗しました"));
  assert.ok(!(await b.page.textContent("#message")).includes("Failed to fetch"));
  await b.ctx.close();
});

await check("お知らせのページ: 読めなかったときは「見た記録」を触らない。赤い点も出さない(H)", async () => {
  const { page, ctx } = await open("notices.html", {
    userId: "u1",
    opts: { profile: USER, noticesFail: true },
    beforeLoad: (pg) => pg.addInitScript(() => { if (!localStorage.getItem("__seeded")) { localStorage.setItem("shiftflow-notices-seen", JSON.stringify(["1:2026-10-06T00:00:00Z"])); localStorage.setItem("__seeded", "1"); } }),
  });
  await page.waitForFunction(() => document.getElementById("message").textContent.includes("読み込めませんでした"));
  assert.equal(await page.evaluate(() => localStorage.getItem("shiftflow-notices-seen")), JSON.stringify(["1:2026-10-06T00:00:00Z"]));
  assert.equal(await page.locator("#notices .card").count(), 0);
  assert.equal(await page.locator("#nav-notices.has-dot").count(), 0);
  await ctx.close();
});

await check("お問い合わせ: 区所の取得が遅くても、フォームはすぐ出て「わからない」で送れる(I)", async () => {
  const { page, ctx, be } = await open("contact.html", { opts: { officesDelay: 20000 } });
  await page.waitForSelector("#contact-form:not(.hidden)", { timeout: 3000 });
  assert.deepEqual(await page.$$eval("#office option", (o) => o.map((x) => x.value)), ["", "わからない"]);
  await page.fill("#employee-no", "1234567");
  await page.fill("#name", "山田");
  await page.selectOption("#office", "わからない");
  await page.selectOption("#kind", "bug");
  await page.fill("#body", "遅いとき");
  await page.click("#submit");
  await page.waitForSelector("#sent:not(.hidden)");
  assert.equal(be.st.calls.find((c) => c.body?.action === "submit").body.office, "わからない");
  await ctx.close();
});

await check("お問い合わせ: 区所の一覧が読めたら、選択肢が増え、選んでいた所属は変わらない(I)", async () => {
  const { page, ctx } = await open("contact.html", { opts: { officesDelay: 1500 } });
  await page.waitForSelector("#contact-form:not(.hidden)");
  await page.selectOption("#office", "わからない");
  await page.waitForFunction(() => document.querySelectorAll("#office option").length === 4, null, { timeout: 8000 });
  assert.equal(await page.inputValue("#office"), "わからない");
  await ctx.close();
});

await check("通信の時間切れ: 返事が来ないときは、決めた時間で日本語のエラーになる(J)", async () => {
  const { page, ctx } = await open("contact.html", { opts: { contactDelay: 3000 } });
  await page.waitForSelector("#contact-form:not(.hidden)");
  const result = await page.evaluate(async () => {
    const m = await import("/js/app.js?v=dev");
    const t0 = Date.now();
    try {
      await m.callFunction("contact", { action: "mine" }, { stayOnLoss: true, timeoutMs: 400 });
      return { ok: true };
    } catch (e) {
      return { code: e.code, message: e.message, ms: Date.now() - t0 };
    }
  });
  assert.equal(result.code, "timeout");
  assert.ok(result.message.includes("通信に時間がかかっています"));
  assert.ok(result.ms < 2000, String(result.ms));
  await ctx.close();
});

// ---------- 公開直後(古い HTML と新しい JS) ----------
await check("古い HTML(版 OLD)と新しい JS(版 NEW)が混ざったら、1回だけ読み直す(E)。同じ版なら読み直さない", async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  const be = backend({});
  await page.route(SB + "/**", be.handler);
  let navs = 0;
  page.on("framenavigated", (f) => { if (f === page.mainFrame()) navs++; });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // HTML だけ版 OLD、JS の中の import は NEW(app.js を ?v=NEW で配る)にする
  await page.route(BASE + "/index.html", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, body: (await res.text()).replace("js/index.js?v=dev", "js/index.js?v=OLD1") });
  });
  await page.route(BASE + "/js/index.js*", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, body: (await res.text()).replaceAll("./app.js?v=dev", "./app.js?v=NEW1") });
  });
  await page.route(BASE + "/js/app.js*", async (route) => route.continue({ url: BASE + "/js/app.js?v=dev" }));
  await page.goto(BASE + "/index.html");
  await page.waitForTimeout(1500);
  assert.equal(navs, 2, "reload once: " + navs); // 最初の読み込み + 1回の読み直し
  assert.deepEqual(errors, []);
  await ctx.close();
  // 版が同じ(dev)なら読み直さない
  const ok = await open("index.html");
  let n2 = 0;
  ok.page.on("framenavigated", (f) => { if (f === ok.page.mainFrame()) n2++; });
  await ok.page.waitForTimeout(1200);
  assert.equal(n2, 0);
  await ok.ctx.close();
});

// ---------- 狭い画面 ----------
await check("幅320px: 管理画面のお問い合わせ一覧が、長い名前でもはみ出さない", async () => {
  const { page, ctx } = await open("admin.html#contact", {
    userId: "a1", opts: { profile: ADMIN, longName: true }, viewport: { width: 320, height: 640 },
  });
  await page.waitForSelector(".contact-item");
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  assert.ok(sw <= iw, `${sw} > ${iw}`);
  await ctx.close();
});

await check("幅320px: 横にはみ出さない(N9)", async () => {
  for (const [path, userId, profile] of [["index.html"], ["contact.html"], ["contact.html", "u1", USER], ["notices.html", "u1", USER], ["help.html"], ["input.html", "u1", USER], ["settings.html", "u1", USER]]) {
    const { page, ctx } = await open(path, { userId, opts: { profile }, viewport: { width: 320, height: 640 } });
    await page.waitForTimeout(1200);
    const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    assert.ok(sw <= iw, `${path} ${userId || ""}: ${sw} > ${iw}`);
    await page.screenshot({ path: OUT + `w320-${path.replace(".html", "")}${userId ? "-member" : ""}.png`, fullPage: true });
    await ctx.close();
  }
});


// ---------- 区所の並び替え(Y1・Y5) ----------
const officeNames = (page) => page.$$eval("#offices tr td:first-child", (tds) => tds.map((t) => t.textContent));
const officeOrders = (be) => be.st.calls.filter((c) => c.method === "PATCH" && c.path === "/rest/v1/offices").map((c) => c.body.sort_order);

await check("管理画面: 区所の↑↓で順が入れ替わる。端のボタンは押せない(Y5)", async () => {
  const { page, ctx, be, errors } = await open("admin.html", { userId: "a1", opts: { profile: ADMIN, twoOffices: true }, viewport: { width: 1200, height: 900 } });
  await page.click('.dtab[data-tab="master"]');
  await page.waitForSelector("#offices tr td");
  assert.deepEqual(await officeNames(page), ["A区所", "B区所", "C区所"]);
  const rows = page.locator("#offices tr");
  assert.equal(await rows.nth(0).locator("button", { hasText: "↑" }).isDisabled(), true);
  assert.equal(await rows.nth(2).locator("button", { hasText: "↓" }).isDisabled(), true);
  await rows.nth(1).locator("button", { hasText: "↑" }).click();
  await page.waitForFunction(() => document.querySelector("#offices tr td").textContent === "B区所");
  assert.deepEqual(await officeNames(page), ["B区所", "A区所", "C区所"]);
  assert.deepEqual(be.st.offices.map((o) => [o.name, o.sort_order]).sort((a, b) => a[1] - b[1]), [["B区所", 1], ["A区所", 2], ["C区所", 3]]);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("管理画面: 区所を足すと、今の最大の並びの番号+1 で入る(区所の数+1 ではない。R8)", async () => {
  const { page, ctx, be, errors } = await open("admin.html", { userId: "a1", opts: { profile: ADMIN, twoOffices: true }, viewport: { width: 1200, height: 900 } });
  be.st.offices[2].sort_order = 7; // 途中の区所を消したあと、のつもり(1・2・7)
  await page.click('.dtab[data-tab="master"]');
  await page.waitForSelector("#offices tr td");
  await page.fill("#new-office", "D区所");
  await page.click("#add-office");
  await page.waitForFunction(() => document.getElementById("message").textContent.includes("区所を追加しました"));
  const posted = be.st.calls.find((c) => c.method === "POST" && c.path === "/rest/v1/offices").body;
  assert.deepEqual([posted.name, posted.sort_order], ["D区所", 8]);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("管理画面: 区所の追加を2回押しても、1回だけ送る(AD11)。仮のPINは Esc で閉じても画面に残らない(AD12)", async () => {
  const { page, ctx, be, errors } = await open("admin.html", { userId: "a1", opts: { profile: ADMIN, twoOffices: true }, viewport: { width: 1200, height: 900 } });
  await page.click('.dtab[data-tab="master"]');
  await page.waitForSelector("#offices tr td");
  await page.fill("#new-office", "D区所");
  await page.dblclick("#add-office");
  await page.waitForFunction(() => document.getElementById("message").textContent.includes("区所を追加しました"));
  assert.equal(be.st.calls.filter((c) => c.method === "POST" && c.path === "/rest/v1/offices").length, 1);
  await page.evaluate(() => {
    document.getElementById("pin-value").textContent = "1234";
    document.getElementById("pin-dialog").showModal();
  });
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.getElementById("pin-dialog").open);
  // 閉じたあとの処理(close イベント)は、少し遅れて動く。値が消えるのを待つ(待たないと、ときどき落ちる)
  await page.waitForFunction(() => document.getElementById("pin-value").textContent === "");
  assert.equal(await page.textContent("#pin-value"), "");
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("管理画面: 区所の並び替えを連打しても、2回目は送らない。送っている間はボタンを押せない(Y1)", async () => {
  const { page, ctx, be } = await open("admin.html", { userId: "a1", opts: { profile: ADMIN, twoOffices: true, officeDelay: 300 }, viewport: { width: 1200, height: 900 } });
  await page.click('.dtab[data-tab="master"]');
  await page.waitForSelector("#offices tr td");
  const down = page.locator("#offices tr").nth(0).locator("button", { hasText: "↓" });
  await down.click();
  await page.locator("#offices tr").nth(1).locator("button", { hasText: "↓" }).dispatchEvent("click"); // 無効のボタンでも、イベントを送って確かめる
  assert.equal(await page.locator("#offices button").evaluateAll((bs) => bs.every((b) => b.disabled)), true);
  await page.waitForFunction(() => document.querySelector("#offices tr td").textContent === "B区所");
  assert.deepEqual(officeOrders(be), [1, 2, 3]); // 1回分(3件)だけ
  assert.deepEqual(await officeNames(page), ["B区所", "A区所", "C区所"]);
  await ctx.close();
});

await check("管理画面: 並び替えの途中で失敗したら、そこで止めて知らせ、並びを読み直す(Y1)", async () => {
  const { page, ctx, be } = await open("admin.html", { userId: "a1", opts: { profile: ADMIN, twoOffices: true, officeFailId: 1 }, viewport: { width: 1200, height: 900 } });
  await page.click('.dtab[data-tab="master"]');
  await page.waitForSelector("#offices tr td");
  await page.locator("#offices tr").nth(1).locator("button", { hasText: "↑" }).click();
  await page.waitForSelector("#message.error");
  // 並びは [B, A, C]。先頭の B(id=2)は成功し、次の A(id=1)で失敗して止まる。C へは送らない
  assert.deepEqual(officeOrders(be), [1, 2]);
  assert.equal(await page.locator("#offices button").first().isDisabled(), true); // 読み直したあとの先頭行の「↑」(端)
  assert.ok(await page.locator("#offices button", { hasText: "削除" }).first().isEnabled()); // 読み直したら、ボタンは戻る
  await ctx.close();
});

await check("幅320px: 管理画面の区所の行(↑ ↓ 名前変更 削除)が、はみ出さない(Y5)", async () => {
  const { page, ctx } = await open("admin.html", { userId: "a1", opts: { profile: ADMIN, twoOffices: true }, viewport: { width: 320, height: 640 } });
  await page.click('.dtab[data-tab="master"]');
  await page.waitForSelector("#offices tr td");
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  assert.ok(sw <= iw, `${sw} > ${iw}`);
  await ctx.close();
});

// ---------- shiftflowカレンダー ----------
const CAL_SHIFTS = [
  { date: today, endDate: today, allDay: true, startTime: "", endTime: "", calendar: "work", kind: "day", title: "25", description: "10:15〜19:02" },
  { date: today, endDate: today, allDay: false, startTime: "10:15", endTime: "19:02", calendar: "work", kind: "day", title: "研修", description: "" },
];
// 確認(confirm)は、OK にして、聞かれた文を asked に入れる(既存のテストと同じ)
const calOpen = (extra = {}, opts = {}) => open("calendar/index.html", {
  userId: "u1",
  opts: { profile: USER, shifts: CAL_SHIFTS, settings: { holiday_calendar_id: "h@group.calendar.google.com", offduty_calendar_id: "off@group.calendar.google.com" }, ...opts },
  beforeLoad: async (p) => { p.removeAllListeners("dialog"); p.on("dialog", (d) => d.accept().catch(() => {})); },
  ...extra,
});

await check("カレンダー: 開くと最初のラベル(勤務・休日・その他)が作られ、ラベルのボタンが並ぶ。今日に印。勤務の予定は帯(終日)と時間つきの帯で出る", async () => {
  const { page, ctx, be, errors } = await calOpen();
  await page.waitForSelector(".bar");
  assert.deepEqual(await page.locator("#chips .chip").allTextContents(), ["勤務", "休日", "非番", "その他"]);
  assert.equal(await page.locator(`.cell.tdy[data-date="${today}"]`).count(), 1);
  const bars = await page.locator(".bar").allTextContents();
  assert.ok(bars.includes("25"), bars.join());
  // 勤務の時間つきの予定は、帯は名前だけ(行路番号だけ)。時間は中の詳細に出る
  assert.ok(bars.includes("研修"), bars.join());
  assert.ok(!bars.some((t) => t.includes("10:15")), "帯に時間は出さない: " + bars.join());
  assert.ok(!bars.some((t) => /(\d+:\d+).*\1/.test(t)), "同じ時間が2回出ない: " + bars.join());
  assert.ok(be.st.calls.some((c) => c.path === "/functions/v1/calendar-shifts" && /^\d{4}-\d\d-\d\d$/.test(c.body.from) && c.body.from <= today && c.body.to >= today));
  assert.deepEqual(errors, []);
  await page.screenshot({ path: OUT + "calendar-month.png" });
  await ctx.close();
});

await check("カレンダー: ラベルのボタンを押すと、そのラベルの予定が消え、もう一度で戻る。選んだ状態は開き直しても残る", async () => {
  const { page, ctx, errors } = await calOpen();
  await page.waitForSelector(".bar");
  await page.click('#chips .chip:has-text("勤務")');
  assert.equal(await page.locator(".bar").count(), 0);
  assert.equal(await page.locator('#chips .chip.off').count(), 1);
  await page.reload();
  await page.waitForSelector("#chips .chip");
  await page.waitForTimeout(300);
  assert.equal(await page.locator(".bar").count(), 0, "開き直しても隠れたまま");
  await page.click('#chips .chip:has-text("勤務")');
  assert.ok((await page.locator(".bar").count()) >= 2);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("カレンダー: 予定を追加(終日)・時間指定(分単位)。日の詳細に時間が出る。保存で送る値は分単位", async () => {
  const { page, ctx, be, errors } = await calOpen();
  await page.waitForSelector(".bar");
  await page.click("#tab-new");
  await page.fill("#f-title", "歯医者");
  await page.click("#f-save");
  await page.waitForFunction(() => document.getElementById("panel").hidden);
  assert.ok((await page.locator(".bar").allTextContents()).includes("歯医者"));
  await page.click("#tab-new");
  await page.fill("#f-title", "会議");
  await page.uncheck("#f-allday");
  await page.fill("#f-st", "09:07");
  await page.fill("#f-et", "10:43");
  await page.click("#f-save");
  await page.waitForFunction(() => document.getElementById("panel").hidden);
  const inserts = be.st.calls.filter((c) => c.path === "/rest/v1/cal_events" && c.method === "POST").map((c) => c.body);
  assert.equal(inserts.length, 2);
  assert.deepEqual([inserts[1].all_day, inserts[1].start_time, inserts[1].end_time], [false, "09:07", "10:43"]);
  assert.equal(inserts[0].all_day, true);
  await page.click(`.cell[data-date="${today}"]`, { position: { x: 4, y: 4 } });
  await page.waitForSelector("#panel:not([hidden]) .erow");
  const text = await page.textContent("#panel");
  assert.ok(text.includes("9:07〜10:43"), text);
  assert.ok(text.includes("歯医者"));
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("カレンダー: 日を長押し(0.5秒)すると、その日の予定の追加が開く。短いタップは日の一覧。指が動いたら追加は開かない。長押しのあとに日の一覧が重ねて開かない", async () => {
  const { page, ctx, errors } = await calOpen();
  await page.waitForSelector(".bar");
  const day = today.slice(0, 8) + "15";
  const pos = async () => { const b = await page.locator(`.cell[data-date="${day}"]`).boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height - 6 }; };
  await page.locator(`.cell[data-date="${day}"]`).scrollIntoViewIfNeeded();
  // 長押し → 追加(開始日・終了日がその日)
  let p = await pos();
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.waitForTimeout(250);
  assert.equal(await page.locator("#f-title").count(), 0, "0.25秒では、まだ開かない");
  await page.waitForSelector("#f-title", { timeout: 1500 });
  assert.equal(await page.inputValue("#f-start"), day);
  assert.equal(await page.inputValue("#f-end"), day);
  await page.mouse.up();
  await page.waitForTimeout(300);
  assert.equal(await page.locator("#f-title").count(), 1, "指を離したあと、日の一覧に置き換わっていない");
  await page.click("#panel [data-act=close]");
  await page.waitForFunction(() => document.getElementById("panel").hidden);
  await page.waitForTimeout(400); // 閉じるときの history.back の popstate が落ち着くのを待つ
  // 指が動いたら開かない(スクロールのつもり)
  p = await pos();
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x, p.y - 130, { steps: 6 }); // 別の週まで動かす(同じマスの中だと、マウスはクリックになる)
  await page.waitForTimeout(800);
  await page.mouse.up();
  assert.equal(await page.locator("#f-title").count(), 0, "動かした指の長押しで追加が開いた");
  // 短いタップ → これまでどおり日の一覧
  p = await pos();
  await page.mouse.click(p.x, p.y);
  await page.waitForSelector('#panel:not([hidden]) [data-act="new"]');
  assert.equal(await page.locator("#f-title").count(), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("カレンダー: 管理画面で足したアイコンが「いまの(電車)」の後ろに並び、選ぶと公開の URL が apple-touch-icon・manifest・タブに入る。開き直しても残り、管理画面で消されたら今のアイコンに戻る。試作のときに覚えた青・緑・オレンジは今のアイコンのまま", async () => {
  const { page, ctx, be, errors } = await calOpen({}, { appIcons: [{ name: "桜" }, { name: "隠し", visible: false }] });
  await page.waitForSelector(".bar");
  await page.waitForTimeout(300);
  await page.click("#tab-settings");
  await page.waitForSelector("#icon-pick");
  await page.waitForFunction(() => document.querySelectorAll('#icon-pick [name="appicon"]').length === 2);
  assert.deepEqual(await page.locator("#icon-pick .ic span").allTextContents(), ["いまの(電車)", "桜"]);
  assert.equal(await page.locator('#icon-pick [name="appicon"]:checked').getAttribute("value"), "default");
  assert.ok((await page.textContent("#icon-note")).includes("ホーム画面に追加"));
  await page.locator('#icon-pick label:has([value="r1"])').click();
  const href = (rel) => page.evaluate((r) => document.head.querySelector(`link[rel="${r}"]`).href, rel);
  assert.ok((await href("apple-touch-icon")).includes("/storage/v1/object/public/app-icons/1/180.png"), await href("apple-touch-icon"));
  assert.ok((await href("icon")).includes("/storage/v1/object/public/app-icons/1/192.png"));
  const manifest = await page.evaluate(async () => (await fetch(document.head.querySelector('link[rel="manifest"]').href)).json());
  assert.ok(manifest.icons.some((i) => i.src.includes("/public/app-icons/1/512.png") && i.purpose === "maskable"), JSON.stringify(manifest.icons));
  // 開き直しても残る(通信の前に反映される)
  await page.reload();
  await page.waitForSelector(".bar");
  assert.ok((await href("apple-touch-icon")).includes("/public/app-icons/1/180.png"));
  await page.click("#tab-settings");
  await page.waitForFunction(() => document.querySelectorAll('#icon-pick [name="appicon"]').length === 2);
  assert.equal(await page.locator('#icon-pick [name="appicon"]:checked').getAttribute("value"), "r1");
  // 管理画面で消された(読めなくなった)ら、開き直したときに今のアイコンに戻る
  be.st.appIcons.length = 0;
  await page.reload();
  await page.waitForSelector(".bar");
  await page.waitForTimeout(500);
  assert.ok((await href("apple-touch-icon")).endsWith("icons/apple-touch-icon.png"), await href("apple-touch-icon"));
  assert.equal(await page.evaluate(() => localStorage.getItem("shiftflow.cal.icon")), null);
  // 試作のときに覚えた「青・緑・オレンジ」(画像はもう無い)は、今のアイコンのまま(id だけの形も、URL つきの形も)
  for (const old of ["green", JSON.stringify({ id: "green", name: "緑", small: "icons/v/green-192.png", touch: "icons/v/green-180.png", any192: "icons/v/green-192.png", any512: "icons/v/green-512.png", maskable: "icons/v/green-512.png" })]) {
    await page.evaluate((v) => localStorage.setItem("shiftflow.cal.icon", v), old);
    await page.reload();
    await page.waitForSelector(".bar");
    assert.ok((await href("apple-touch-icon")).endsWith("icons/apple-touch-icon.png"), "試作の値で画像が消えている: " + (await href("apple-touch-icon")));
  }
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("カレンダー: 画像が入っていないアイコン(追加が途中で止まって行だけ残ったもの)は、選ぶ一覧に出さない。覚えてある選びは、画像が読めないだけでは戻さない", async () => {
  const { page, ctx, errors } = await calOpen({}, { appIcons: [{ name: "桜" }, { name: "壊れた" }, { name: "梅" }], iconMissing: [2] });
  await page.waitForSelector(".bar");
  await page.waitForTimeout(300);
  await page.click("#tab-settings");
  await page.waitForFunction(() => document.querySelectorAll('#icon-pick [name="appicon"]').length === 3);
  assert.deepEqual(await page.locator("#icon-pick .ic span").allTextContents(), ["いまの(電車)", "桜", "梅"]);
  // 画像が読めないアイコンを覚えていても、選びは消さない(通信の不調かもしれない)
  await page.evaluate(() => localStorage.setItem("shiftflow.cal.icon", JSON.stringify({ id: "r2", name: "壊れた", small: "x/192.png", touch: "x/180.png", any192: "x/192.png", any512: "x/512.png", maskable: "x/512.png" })));
  await page.reload();
  await page.waitForSelector(".bar");
  await page.waitForTimeout(500);
  assert.notEqual(await page.evaluate(() => localStorage.getItem("shiftflow.cal.icon")), null);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("管理画面(設定): ホーム画面のアイコンを足す(画像は512・192・180の正方形PNGで入る)・名前を直す・並べ替える・隠す・消す(画像も消える)。画像の途中で失敗したら追加しない", async () => {
  const png = new URL("../../../web/calendar/icons/icon-512.png", import.meta.url).pathname;
  const { page, ctx, be, errors } = await open("admin.html#settings", { userId: "a1", opts: { profile: ADMIN, appIcons: [{ name: "一つ目" }] }, viewport: { width: 1200, height: 900 }, beforeLoad: async (p) => { p.removeAllListeners("dialog"); p.on("dialog", (d) => d.accept().catch(() => {})); } });
  await page.waitForSelector("#icon-list .notice-admin-row");
  assert.equal(await page.locator("#icon-list .notice-admin-row").count(), 1);
  // 足す
  await page.fill("#icon-name", "桜");
  await page.setInputFiles("#icon-file", png);
  await page.waitForSelector("#icon-crop:not([hidden])");
  await page.click("#icon-save");
  await page.waitForFunction(() => document.querySelectorAll("#icon-list .notice-admin-row").length === 2);
  const post = be.st.calls.find((c) => c.path === "/rest/v1/app_icons" && c.method === "POST").body;
  assert.deepEqual(post, { name: "桜", sort_order: 2 });
  const ups = be.st.iconUploads.map((u) => u.path).sort();
  assert.deepEqual(ups, ["100/180.png", "100/192.png", "100/512.png"]);
  assert.ok(be.st.iconUploads.every((u) => u.size > 100 && u.head.startsWith("\x89PNG") || u.head.includes("PNG")), "PNG で入る");
  assert.match(await page.textContent("#icon-message"), /追加しました/);
  // 名前を直す(画像の選びは出ない)
  await page.click('#icon-list .notice-admin-row:nth-child(2) button:has-text("名前を直す")');
  assert.equal(await page.locator("#icon-file-row").isHidden(), true);
  await page.fill("#icon-name", "桜2");
  await page.click("#icon-save");
  await page.waitForFunction(() => document.querySelector("#icon-list").textContent.includes("桜2"));
  assert.equal(be.st.appIcons.find((x) => x.id === 100).name, "桜2");
  // 並べ替え・隠す
  await page.click('#icon-list .notice-admin-row:nth-child(2) button[title="1つ上へ"]');
  await page.waitForFunction(() => document.querySelector("#icon-list .notice-admin-row strong").textContent === "桜2");
  await page.click('#icon-list .notice-admin-row:nth-child(1) button:has-text("隠す")');
  await page.waitForFunction(() => document.querySelector("#icon-list .status-badge").textContent === "非表示");
  assert.equal(be.st.appIcons.find((x) => x.id === 100).visible, false);
  // 消す(画像も消える)
  await page.click('#icon-list .notice-admin-row:nth-child(1) button:has-text("削除")');
  await page.waitForFunction(() => document.querySelectorAll("#icon-list .notice-admin-row").length === 1);
  assert.deepEqual([...be.st.iconRemoved].sort(), ["100/180.png", "100/192.png", "100/512.png"]);
  // 名前・画像の入力チェック
  await page.fill("#icon-name", "");
  await page.click("#icon-save");
  assert.match(await page.textContent("#icon-message"), /名前を入力/);
  await page.fill("#icon-name", "あ".repeat(21).slice(0, 20));
  await page.click("#icon-save");
  assert.match(await page.textContent("#icon-message"), /画像を選んで/);
  assert.deepEqual(errors, []);
  await ctx.close();
  // 画像が途中で入らなかったら、行も画像も消して、追加しない
  const b = await open("admin.html#settings", { userId: "a1", opts: { profile: ADMIN, appIcons: [], iconUploadFail: true }, viewport: { width: 1200, height: 900 } });
  await b.page.waitForSelector("#icon-save");
  await b.page.fill("#icon-name", "失敗");
  await b.page.setInputFiles("#icon-file", png);
  await b.page.waitForSelector("#icon-crop:not([hidden])");
  await b.page.click("#icon-save");
  await b.page.waitForFunction(() => document.getElementById("icon-message").className.includes("error"));
  assert.match(await b.page.textContent("#icon-message"), /追加していません/);
  assert.equal(b.be.st.appIcons.length, 0, "行が残っている");
  assert.ok(b.be.st.iconRemoved.includes("100/512.png"), "入った画像を消していない");
  await b.ctx.close();
  // 小さすぎる画像(1ドット)は選べない
  const c = await open("admin.html#settings", { userId: "a1", opts: { profile: ADMIN }, viewport: { width: 1200, height: 900 } });
  await c.page.waitForSelector("#icon-file");
  await c.page.setInputFiles("#icon-file", { name: "tiny.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64") });
  await c.page.waitForFunction(() => document.getElementById("icon-message").className.includes("error"));
  assert.match(await c.page.textContent("#icon-message"), /小さすぎます/);
  await c.ctx.close();
});

await check("管理画面(設定): アイコンにする範囲を、画像のドラッグ・大きさのスライダー・矢印キーで決められる(画像の外にははみ出さない)。できあがりと丸く切られたときのプレビューが出て、決めた範囲で3つの大きさの画像が入る", async () => {
  const png = new URL("../../../web/calendar/icons/icon-512.png", import.meta.url).pathname; // 512×512
  const { page, ctx, be, errors } = await open("admin.html#settings", { userId: "a1", opts: { profile: ADMIN, appIcons: [] }, viewport: { width: 1200, height: 1000 } });
  await page.waitForSelector("#icon-file");
  assert.equal(await page.locator("#icon-crop").isHidden(), true, "画像を選ぶ前は出ない");
  await page.setInputFiles("#icon-file", png);
  await page.waitForSelector("#icon-crop:not([hidden])");
  const crop = async () => (await page.getAttribute("#icon-crop-view", "data-crop")).split(",").map(Number);
  assert.deepEqual(await crop(), [0, 0, 512], "はじめは、短い辺がちょうど入る(真ん中)");
  assert.equal(await page.getAttribute("#icon-zoom", "max"), "266", "窓の中が192px未満になるほど大きくはできない(512÷192)");
  const setZoom = (z) => page.evaluate((v) => { const el = document.getElementById("icon-zoom"); el.value = String(v); el.dispatchEvent(new Event("input", { bubbles: true })); }, z);
  // 大きさ 200%: 窓の真ん中は動かない
  await setZoom(200);
  assert.deepEqual(await crop(), [128, 128, 256]);
  // ドラッグ(右へ 50px): 画像が右へ動き、見える範囲は左へ
  await page.locator("#icon-crop-view").scrollIntoViewIfNeeded(); // 画面の外では、マウスの操作が届かない
  const box = await page.locator("#icon-crop-view").boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 50, cy, { steps: 5 });
  await page.mouse.up();
  const [sx1, sy1, side1] = await crop();
  assert.ok(sx1 < 128 - 20 && sx1 > 128 - 80 && sy1 === 128 && side1 === 256, "ドラッグで範囲が動く: " + [sx1, sy1, side1]);
  // 画像の外には出ない(大きく動かしても、端で止まる)
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 2000, cy + 2000, { steps: 4 });
  await page.mouse.up();
  assert.deepEqual(await crop(), [0, 0, 256], "左上の端で止まる");
  // 矢印キー: 見える範囲が右へ動く
  await page.focus("#icon-crop-view");
  await page.keyboard.press("ArrowRight");
  assert.ok((await crop())[0] > 0, "矢印キーで動く");
  // 大きさを 100% に戻すと、全体に戻る
  await setZoom(100);
  assert.deepEqual(await crop(), [0, 0, 512]);
  // プレビューが2つ(できあがり・丸く切られたとき)出ていて、描かれている
  for (const id of ["icon-preview", "icon-preview-round"]) {
    assert.equal(await page.locator("#" + id).isVisible(), true);
    const painted = await page.evaluate((i) => { const d = document.getElementById(i).getContext("2d").getImageData(48, 48, 1, 1).data; return d[3] > 0; }, id);
    assert.ok(painted, id + " が空");
  }
  // 決めた範囲で保存 → 3つの大きさの画像が入る
  await setZoom(200);
  await page.fill("#icon-name", "切り取り");
  await page.click("#icon-save");
  await page.waitForFunction(() => document.getElementById("icon-message").textContent.includes("追加しました"));
  assert.deepEqual(be.st.iconUploads.map((u) => u.path).sort(), ["100/180.png", "100/192.png", "100/512.png"]);
  assert.equal(await page.locator("#icon-crop").isHidden(), true, "追加したら、切り取りは閉じる");
  assert.deepEqual(errors, []);
  await page.screenshot({ path: OUT + "admin-icon-crop.png" });
  await ctx.close();
});

await check("カレンダー: 時間つきなのに開始時刻が無い・終了が開始より前・終了日が前は、保存せずに知らせる。日をまたぐ予定は終了日を次の日にすれば通る", async () => {
  const { page, ctx, be, errors } = await calOpen();
  await page.waitForSelector(".bar");
  await page.click("#tab-new");
  await page.fill("#f-title", "泊まり");
  await page.uncheck("#f-allday");
  await page.fill("#f-st", "22:30");
  await page.fill("#f-et", "08:15");
  await page.click("#f-save");
  await page.waitForSelector("#form-msg:not(:empty)");
  assert.ok((await page.textContent("#form-msg")).includes("終了時刻が開始時刻より前"));
  assert.equal(be.st.calls.filter((c) => c.path === "/rest/v1/cal_events" && c.method === "POST").length, 0);
  const next = await page.evaluate((t) => { const d = new Date(t + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); }, today);
  await page.fill("#f-end", next);
  await page.click("#f-save");
  await page.waitForFunction(() => document.getElementById("panel").hidden);
  const ins = be.st.calls.find((c) => c.path === "/rest/v1/cal_events" && c.method === "POST").body;
  assert.deepEqual([ins.end_date, ins.start_time, ins.end_time], [next, "22:30", "08:15"]);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("カレンダー: 予定を直す(version を付けて送る)・消す。別の端末で変わっていたら、上書きせずに知らせる", async () => {
  const { page, ctx, be, errors } = await calOpen();
  await page.waitForSelector(".bar");
  await page.click("#tab-new");
  await page.fill("#f-title", "歯医者");
  await page.click("#f-save");
  await page.waitForFunction(() => document.getElementById("panel").hidden);
  await page.click('.bar:has-text("歯医者")');
  await page.click('[data-act="edit"]');
  await page.fill("#f-title", "歯医者(予約)");
  await page.click("#f-save");
  await page.waitForFunction(() => document.getElementById("panel").hidden);
  const patch = be.st.calls.find((c) => c.path === "/rest/v1/cal_events" && c.method === "PATCH");
  assert.ok(patch.search.includes("version=eq.1"), patch.search);
  assert.ok((await page.locator(".bar").allTextContents()).includes("歯医者(予約)"));
  // 別の端末で version が進んだ
  be.st.cal.cal_events[0].version = 9;
  await page.click('.bar:has-text("歯医者(予約)")');
  await page.click('[data-act="edit"]');
  await page.fill("#f-title", "上書き");
  await page.click("#f-save");
  await page.waitForSelector("#form-msg:not(:empty)");
  assert.ok((await page.textContent("#form-msg")).includes("別の端末で変更"));
  assert.equal(be.st.cal.cal_events[0].title, "歯医者(予約)");
  await page.click('[data-act="close"]');
  // 削除
    await page.click('.bar:has-text("歯医者(予約)")');
  await page.click('[data-act="del"]');
  await page.waitForFunction(() => document.getElementById("panel").hidden);
  assert.equal(be.st.cal.cal_events.length, 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("カレンダー: 毎週の予定は各週に出て、「この回だけ削除」はその日だけ外す(exdates)。「この回だけ編集」は1回だけの予定に変わる", async () => {
  const { page, ctx, be, errors } = await calOpen();
  await page.waitForSelector(".bar");
  await page.click("#tab-new");
  await page.fill("#f-title", "ゴミ出し");
  await page.selectOption("#f-rep", "weekly");
  await page.click("#f-save");
  await page.waitForFunction(() => document.getElementById("panel").hidden);
  const count = () => page.locator('.bar:has-text("ゴミ出し")').count();
  const before = await count();
  assert.ok(before >= 4, "毎週なので月に4回以上: " + before);
    await page.locator('.bar:has-text("ゴミ出し")').first().click();
  assert.equal(await page.locator('[data-act="edit"]').count(), 2);
  await page.click('[data-act="del"][data-mode="occ"]');
  await page.waitForFunction(() => document.getElementById("panel").hidden);
  assert.equal(await count(), before - 1);
  const ev = be.st.cal.cal_events[0];
  assert.equal(ev.exdates.length, 1);
  assert.equal(ev.repeat_rule, "weekly");
  // この回だけ編集
  await page.locator('.bar:has-text("ゴミ出し")').first().click();
  await page.click('[data-act="edit"][data-mode="occ"]');
  assert.equal(await page.locator("#f-rep").count(), 0, "この回だけのときは繰り返しを選べない");
  await page.fill("#f-title", "粗大ごみ");
  await page.click("#f-save");
  await page.waitForFunction(() => document.getElementById("panel").hidden);
  assert.equal(be.st.cal.cal_events.length, 2);
  assert.equal(be.st.cal.cal_events[1].repeat_rule, "none");
  assert.equal(be.st.cal.cal_events[0].exdates.length, 2);
  assert.ok((await page.locator(".bar").allTextContents()).includes("粗大ごみ"));
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("カレンダー: 勤務の予定をタップすると、勤務入力で直すと案内する(編集・削除は出ない)。日の詳細に祝日名", async () => {
  const { page, ctx, errors } = await calOpen({}, { calHolidays: [{ date: today, name: "テストの日" }] });
  await page.waitForSelector(".bar");
  await page.click('.bar:text-is("25")');
  const text = await page.textContent("#panel");
  assert.ok(text.includes("勤務入力で直します"), text);
  assert.equal(await page.locator('[data-act="edit"]').count(), 0);
  assert.equal(await page.locator('[data-act="del"]').count(), 0);
  await page.click('[data-act="close"]');
  await page.click(`.cell[data-date="${today}"]`, { position: { x: 4, y: 4 } });
  assert.ok((await page.textContent("#panel")).includes("テストの日"));
  assert.equal(await page.locator(`.cell.hol[data-date="${today}"]`).count(), 1);
  await page.click('[data-act="close"]');
  // 祝日の名前は、日付の横に(赤い小さな字)
  assert.equal((await page.textContent(`.cell.hol[data-date="${today}"] .hn`)).trim(), "テストの日");
  // 月の数字(背景)・年月は「2026」と「11月」を上下に
  const ym0 = today.slice(0, 7);
  assert.equal((await page.textContent(`.week:has(.cell[data-date="${ym0}-12"]) .wmk`)).trim(), String(Number(today.slice(5, 7))));
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("カレンダー: タイトル・メモに入れた HTML は文字のまま出る(予定・ラベル)", async () => {
  const { page, ctx, errors } = await calOpen();
  await page.waitForSelector(".bar");
  await page.click("#tab-new");
  await page.fill("#f-title", '<img src=x onerror="window.__x=1">');
  await page.fill("#f-memo", "<b>太字にならない</b>");
  await page.click("#f-save");
  await page.waitForFunction(() => document.getElementById("panel").hidden);
  await page.click('.bar:has-text("<img")');
  assert.ok((await page.textContent("#panel")).includes("<b>太字にならない</b>"));
  assert.equal(await page.locator("#panel b").count(), 0);
  assert.equal(await page.evaluate(() => window.__x), undefined);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("カレンダー: 月がそのまま縦に続く。スクロールで年月の表示が変わり、近づいた月の勤務の予定を読む。◀▶・今日で動く。過去は12か月前まで・先は来年12月まで", async () => {
  const { page, ctx, be, errors } = await calOpen();
  await page.waitForSelector(".bar");
  const hdr = () => page.evaluate(() => `${document.getElementById("ty").textContent}-${document.getElementById("tm").textContent.replace("月", "")}`);
  const shiftCalls = () => be.st.calls.filter((c) => c.path === "/functions/v1/calendar-shifts").length;
  const t0 = today.slice(0, 7);
  assert.equal(await hdr(), `${Number(t0.slice(0, 4))}-${Number(t0.slice(5, 7))}`);
  // 週は途切れず続く(隣の週との差が、全て7日)
  const weeks = await page.$$eval(".week", (els) => els.map((e) => e.dataset.ws));
  assert.ok(weeks.length > 100, "1年前〜来年12月まで続けて並ぶ: " + weeks.length);
  assert.ok(weeks.every((w, i) => i === 0 || (Date.parse(w) - Date.parse(weeks[i - 1])) === 7 * 86400000), "週が途切れない");
  // 上のほうは、前の月が続いている(今日の週は、上から2段目)
  const top = await page.evaluate(() => { const cal = document.getElementById("cal"); return cal.scrollTop; });
  assert.ok(top > 0, "今日の位置から始まる");
  // 指のスクロール(縦に動かす)で、月の表示が変わる
  const before = shiftCalls();
  const scrollBy = (n) => page.evaluate((n) => { const cal = document.getElementById("cal"); cal.scrollTop += n * parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--rh")); }, n);
  const h0 = await hdr();
  await scrollBy(6);
  await page.waitForFunction((h) => { const x = `${document.getElementById("ty").textContent}-${document.getElementById("tm").textContent.replace("月", "")}`; return x !== h; }, h0);
  await scrollBy(14); // 3〜4か月先まで
  await page.waitForTimeout(500);
  assert.ok(shiftCalls() > before, "近づいた月の勤務の予定を読む");
  // ◀ で1か月ずつ戻る
  await page.click("#today");
  await page.waitForFunction((h) => `${document.getElementById("ty").textContent}-${document.getElementById("tm").textContent.replace("月", "")}` === h, `${Number(t0.slice(0, 4))}-${Number(t0.slice(5, 7))}`);
  let y = Number(t0.slice(0, 4)), m = Number(t0.slice(5, 7));
  for (let i = 0; i < 12; i++) {
    m--; if (m < 1) { m = 12; y--; }
    await page.click("#prev");
    await page.waitForFunction((h) => `${document.getElementById("ty").textContent}-${document.getElementById("tm").textContent.replace("月", "")}` === h, `${y}-${m}`);
  }
  assert.equal(await page.isDisabled("#prev"), true, "12か月前より前へは行けない");
  // 先は来年12月まで
  await page.click("#today");
  await page.waitForFunction((h) => `${document.getElementById("ty").textContent}-${document.getElementById("tm").textContent.replace("月", "")}` === h, `${Number(t0.slice(0, 4))}-${Number(t0.slice(5, 7))}`);
  await page.evaluate(() => { const cal = document.getElementById("cal"); cal.scrollTop = cal.scrollHeight; });
  await page.waitForFunction(() => document.getElementById("next").disabled);
  assert.equal(await hdr(), `${Number(t0.slice(0, 4)) + 1}-12`);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("カレンダー: 区所を決めていない人には、設定へのご案内。勤務の予定が読めなくても、自分の予定は出て、案内を出す", async () => {
  const a = await calOpen({}, { needOffice: true, shifts: [] });
  await a.page.waitForSelector("#banner:not([hidden])");
  assert.ok((await a.page.textContent("#banner")).includes("区所"));
  await a.ctx.close();
  const b = await calOpen({}, { shiftsFail: true });
  await b.page.waitForSelector("#banner:not([hidden])");
  assert.ok((await b.page.textContent("#banner")).includes("読めませんでした"));
  assert.equal(await b.page.locator("#chips .chip").count(), 4);
  await b.ctx.close();
});

await check("カレンダー設定: 一番上に説明、一番下に色合いとホーム画面のアイコン。ラベルの追加・色・名前・並び替え・削除(使っているラベルは消せない)", async () => {
  const { page, ctx, be, errors } = await calOpen();
  await page.waitForSelector(".bar");
  await page.click("#tab-settings");
  await page.waitForSelector("#about");
  const order = await page.$$eval("#panel .card", (els) => els.map((e) => e.querySelector("h3").textContent));
  assert.deepEqual(order, ["shiftflowカレンダーについて", "このカレンダーに出すもの", "ラベル", "月のカレンダーを画像にする", "選んだ日に〇をつけて画像にする", "あなたの写真・画像の量", "画面の色合い", "ホーム画面のアイコン"]);
  assert.ok((await page.textContent("#about")).includes("1つのアカウントで1人分"));
  // 追加
  await page.fill("#nl-name", "家族");
  await page.fill("#nl-color", "#aa3366");
  await page.click('[data-act="l-add"]');
  await page.waitForSelector('[data-lf="name"][value="家族"]');
  assert.deepEqual(await page.locator("#chips .chip").allTextContents(), ["勤務", "休日", "非番", "その他", "家族"]);
  // 名前・色を直す
  const row = page.locator('.lrow[data-lid]', { has: page.locator('[data-lf="name"][value="家族"]') });
  await row.locator('[data-lf="name"]').fill("パートナー");
  await row.locator('[data-lf="name"]').blur();
  await page.waitForFunction(() => [...document.querySelectorAll("#chips .chip")].some((c) => c.textContent === "パートナー"));
  // 並び替え(上へ)
  await page.locator('[data-act="l-up"]').last().click();
  await page.waitForFunction(() => document.querySelectorAll("#chips .chip")[3].textContent === "パートナー");
  assert.deepEqual(await page.locator("#chips .chip").allTextContents(), ["勤務", "休日", "非番", "パートナー", "その他"]);
  // 使っているラベルは消せない
  await page.keyboard.press("Escape");
  await page.click("#tab-new");
  await page.selectOption("#f-label", { label: "その他" });
  await page.fill("#f-title", "使用中");
  await page.click("#f-save");
  await page.waitForFunction(() => document.getElementById("panel").hidden);
  await page.click("#tab-settings");
    const otherRow = page.locator('.lrow[data-lid]', { has: page.locator('[data-lf="name"][value="その他"]') });
  await otherRow.locator('[data-act="l-del"]').click();
  await page.waitForSelector("#label-msg:not(:empty)");
  assert.ok((await page.textContent("#label-msg")).includes("使っている予定があるので"));
  // 使っていないラベルは消せる
  const pRow = page.locator('.lrow[data-lid]').filter({ has: page.locator('input[data-lf="name"]') }).nth(3);
  assert.equal(await pRow.locator('[data-lf="name"]').inputValue(), "パートナー");
  await pRow.locator('[data-act="l-del"]').click();
  await page.waitForFunction(() => ![...document.querySelectorAll("#chips .chip")].some((c) => c.textContent === "パートナー"));
  // 色合い
  await page.check('input[name="theme"][value="dark"]', { force: true });
  assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-theme")), "dark");
  assert.equal(await page.evaluate(() => localStorage.getItem("shiftflow-cal-theme")), "dark");
  await page.screenshot({ path: OUT + "calendar-settings-dark.png" });
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("カレンダー: ログインしていなければログイン画面へ。幅320pxでもはみ出さない", async () => {
  const a = await open("calendar/index.html", { opts: {} });
  await a.page.waitForURL(/\/index\.html$/);
  assert.ok(!a.page.url().includes("calendar"));
  await a.ctx.close();
  const { page, ctx } = await calOpen({ viewport: { width: 320, height: 640 } });
  await page.waitForSelector(".bar");
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  assert.ok(sw <= iw, `${sw} > ${iw}`);
  await ctx.close();
});

await check("カレンダー: 勤務入力などの上のナビに「カレンダー」がある", async () => {
  const { page, ctx } = await open("settings.html", { userId: "u1", opts: { profile: USER } });
  await page.waitForSelector("nav.topbar");
  assert.ok((await page.locator("nav.topbar a").allTextContents()).includes("カレンダー"));
  await ctx.close();
});


await check("カレンダー(TODO): 追加(Enter)・チェックで「済み」へ・文字を直す・済みを消す・まとめて消す。HTMLは文字のまま", async () => {
  const { page, ctx, be, errors } = await calOpen();
  await page.waitForSelector(".bar");
  await page.click("#tab-todo");
  await page.fill("#td-new", "牛乳を買う");
  await page.press("#td-new", "Enter");
  await page.waitForFunction(() => document.querySelectorAll(".trow[data-tid]").length === 1); // 1件目が入って画面が作り直されてから、次を書く
  await page.fill("#td-new", "<b>パン</b>");
  await page.click('[data-act="todo-add"]');
  await page.waitForFunction(() => document.querySelectorAll(".trow[data-tid]").length === 2);
  assert.deepEqual(be.st.cal.cal_todos.map((t) => [t.text, t.sort]), [["牛乳を買う", 1], ["<b>パン</b>", 2]]);
  assert.equal(await page.locator("#panel b").count(), 0);
  // 直す
  await page.fill('[data-tin]:nth-of-type(1)', "牛乳を2本買う").catch(() => {});
  await page.locator(".trow[data-tid] .tin").first().fill("牛乳を2本買う");
  await page.locator(".trow[data-tid] .tin").first().blur();
  await page.waitForFunction(() => true);
  await page.waitForTimeout(200);
  assert.equal(be.st.cal.cal_todos[0].text, "牛乳を2本買う");
  // 済み
  await page.locator('.trow[data-tid] .tck').first().check();
  await page.waitForSelector(".trow.done");
  assert.equal(be.st.cal.cal_todos[0].done, true);
  assert.ok((await page.textContent(".tdh")).includes("済み 1件"));
  await page.click('[data-act="todo-del"]');
  await page.waitForFunction(() => !document.querySelector(".trow.done"));
  assert.equal(be.st.cal.cal_todos.length, 1);
  // まとめて消す
  await page.locator('.trow[data-tid] .tck').first().check();
  await page.click('[data-act="todo-clear"]');
  await page.waitForFunction(() => !document.querySelector(".trow[data-tid]"));
  assert.equal(be.st.cal.cal_todos.length, 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("カレンダー(重要メモ): 追加・直す・消す。題名は必須。HTMLは文字のまま", async () => {
  const { page, ctx, be, errors } = await calOpen();
  await page.waitForSelector(".bar");
  await page.click("#btn-imp");
  await page.click('[data-act="imp-new"]');
  await page.fill("#im-b", "電話 000");
  await page.click('[data-act="imp-save"]');
  assert.ok((await page.textContent("#x-msg")).includes("題名"));
  await page.fill("#im-t", "<i>病院</i>");
  await page.click('[data-act="imp-save"]');
  await page.waitForSelector(".icard");
  assert.equal(await page.locator("#panel i").count(), 0);
  assert.ok((await page.textContent(".icard")).includes("<i>病院</i>"));
  await page.click(".icard");
  await page.fill("#im-b", "電話 111\n2行目");
  await page.click('[data-act="imp-save"]');
  await page.waitForSelector(".icard");
  assert.equal(be.st.cal.cal_importants[0].body, "電話 111\n2行目");
  await page.click(".icard");
  await page.click('[data-act="imp-del"]');
  await page.waitForFunction(() => !document.querySelector(".icard"));
  assert.equal(be.st.cal.cal_importants.length, 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("カレンダー(画像の置き場): 小さくして(JPEG・約400KB以下)入れる。名前・消す。10枚で追加できない", async () => {
  const { page, ctx, be, errors } = await calOpen();
  await page.waitForSelector(".bar");
  await page.click("#btn-gal");
  await page.setInputFiles("#gal-file", [DIR + "photo.jpg", DIR + "big.png"]);
  await page.waitForFunction(() => document.querySelectorAll(".gitem").length === 2, null, { timeout: 20000 });
  assert.equal(be.st.uploads.length, 2);
  for (const u of be.st.uploads) {
    assert.ok(u.head.includes("image/jpeg"), "JPEG にして送る: " + u.head.slice(0, 120));
    assert.ok(u.size < 460 * 1024, `約400KB以下: ${u.size}`);
    assert.ok(u.path.startsWith("u1/g-") || /^[^/]+\/g-/.test(u.path), u.path);
  }
  assert.equal(be.st.cal.cal_gallery.length, 2);
  assert.ok((await page.textContent(".ph h2")).includes("2/10"));
  // 画像が出る(期限つきの URL)
  await page.waitForFunction(() => [...document.querySelectorAll(".gitem img")].every((i) => i.getAttribute("src") && i.complete && i.naturalWidth > 0));
  // 名前
  await page.locator("[data-gtitle]").first().fill("給食の献立");
  await page.locator("[data-gtitle]").first().blur();
  await page.waitForTimeout(200);
  assert.ok(be.st.cal.cal_gallery.some((g) => g.title === "給食の献立"));
  // 大きく見る
  await page.locator(".gitem img").first().click();
  assert.equal(await page.isVisible("#viewer"), true);
  await page.click("#viewer");
  // 消す(Storage のファイルも消す)
  await page.locator('[data-act="gal-del"]').first().click();
  await page.waitForFunction(() => document.querySelectorAll(".gitem").length === 1);
  assert.equal(be.st.removed.length, 1);
  assert.equal(be.st.cal.cal_gallery.length, 1);
  // 10枚のとき
  for (let i = 0; i < 9; i++) be.st.cal.cal_gallery.push({ id: "G" + i, user_id: "u1", path: `u1/g-${i}.jpg`, title: "", size_bytes: 1, created_at: "2026-11-01T00:00:00Z" });
  await page.reload();
  await page.waitForSelector("#btn-gal");
  await page.waitForTimeout(300);
  await page.click("#btn-gal");
  await page.waitForSelector(".gitem");
  assert.equal(await page.isDisabled("#gal-file"), true);
  assert.ok((await page.textContent(".ph h2")).includes("10/10"));
  assert.deepEqual(errors, []);
  await page.screenshot({ path: OUT + "calendar-gallery.png" });
  await ctx.close();
});

await check("カレンダー(スタンプ): 絵文字・文字のスタンプを作る → 選んで日付をタップで置く → 選んで大きさ・回転・メモ → 消す。HTMLは文字のまま", async () => {
  const { page, ctx, be, errors } = await calOpen();
  await page.waitForSelector(".bar");
  await page.click("#tab-stamp");
  await page.waitForSelector("#tray:not([hidden])");
  // 作る(絵文字)
  await page.click('#tray [data-act="df-new"]');
  await page.fill("#d-emoji", "🎂");
  await page.click('[data-act="df-save"]');
  await page.waitForSelector('.lrow[data-did]');
  // 作る(文字・HTML)
  await page.click('#panel [data-act="df-new"]');
  await page.check('input[name="dkind"][value="text"]', { force: true });
  await page.fill("#d-text", "<b>休</b>");
  await page.selectOption("#d-shape", "bubble");
  await page.click('[data-act="df-save"]');
  await page.waitForFunction(() => document.querySelectorAll(".lrow[data-did]").length === 2);
  assert.equal(be.st.cal.cal_stamp_defs.length, 2);
  assert.equal(be.st.cal.cal_stamp_defs[0].sort, 1);
  assert.equal(await page.locator("#panel b").count(), 0);
  await page.click('[data-act="close"]');
  await page.waitForSelector("#tray .tk");
  assert.equal(await page.locator("#tray .tk").count(), 2);
  // 選んで置く(今日のマス)
  await page.click('#tray .tk >> nth=0');
  await page.click(`.cell[data-date="${today}"]`, { position: { x: 4, y: 4 } });
  await page.waitForSelector(".stamp");
  assert.equal(be.st.cal.cal_stamps.length, 1);
  assert.deepEqual([be.st.cal.cal_stamps[0].date, be.st.cal.cal_stamps[0].size], [today, be.st.cal.cal_stamp_defs[0].default_size]);
  assert.ok(be.st.cal.cal_stamps[0].x >= 0.12 && be.st.cal.cal_stamps[0].x <= 0.88, "タップした場所(マスの左上)に近い位置: " + be.st.cal.cal_stamps[0].x);
  assert.equal((await page.locator(".stamp").first().textContent()).trim(), "🎂");
  // 何も選ばずにマスをタップ(置いたスタンプを避けた場所) → スタンプの画面が閉じる(日の詳細は開かない)
  await page.click(`.cell[data-date="${today}"]`, { position: { x: 44, y: 78 } });
  assert.equal(await page.isVisible("#tray"), false);
  assert.equal(await page.isVisible("#panel"), false);
  // タップで選ぶ → 大きさ・回転(保存)・メモ
  await page.locator(".stamp").first().click();
  await page.waitForSelector("#st-size");
  await page.locator("#st-size").evaluate((el) => { el.value = "0.8"; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); });
  await page.locator("#st-rot").evaluate((el) => { el.value = "30"; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); });
  await page.waitForTimeout(200);
  assert.deepEqual([be.st.cal.cal_stamps[0].size, be.st.cal.cal_stamps[0].rotation], [0.8, 30]);
  await page.click('[data-act="sn-new"]');
  await page.fill("#sn-t", "ケーキ予約");
  await page.fill("#sn-d", "<u>16時</u>");
  await page.click('[data-act="sn-save"]');
  await page.waitForSelector(".chipnote");
  assert.deepEqual(be.st.cal.cal_stamps[0].notes, [{ t: "ケーキ予約", d: "<u>16時</u>" }]);
  assert.equal(await page.locator("#panel u").count(), 0);
  // メモは日の詳細には出ない
  await page.click('[data-act="close"]');
  await page.click(`.cell[data-date="${today}"]`, { position: { x: 44, y: 78 } });
  assert.ok(!(await page.textContent("#panel")).includes("ケーキ予約"));
  await page.click('[data-act="close"]');
  // 消す
  await page.locator(".stamp").first().click();
  await page.click('[data-act="st-del"]');
  await page.waitForFunction(() => !document.querySelector(".stamp"));
  assert.equal(be.st.cal.cal_stamps.length, 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("カレンダー(スタンプ): ドラッグで別の日へ動かせる。画像のスタンプは256pxのPNGで入れる。種類を消すと置いたものも消える", async () => {
  const { page, ctx, be, errors } = await calOpen();
  await page.waitForSelector(".bar");
  await page.click("#tab-stamp");
  // 画像のスタンプ
  await page.click('#tray [data-act="df-new"]');
  await page.check('input[name="dkind"][value="image"]', { force: true });
  await page.setInputFiles("#d-file", DIR + "photo.jpg");
  await page.waitForFunction(() => document.querySelector("#d-prev img"));
  await page.click('[data-act="df-save"]');
  await page.waitForSelector('.lrow[data-did]');
  assert.equal(be.st.uploads.length, 1);
  assert.ok(be.st.uploads[0].head.includes("image/png"), be.st.uploads[0].head.slice(0, 100));
  assert.ok(/s-.*\.png$/.test(be.st.uploads[0].path));
  assert.equal(be.st.cal.cal_stamp_defs[0].kind, "image");
  await page.click('[data-act="close"]');
  // 置く
  await page.click("#tray .tk");
  await page.click(`.cell[data-date="${today}"]`, { position: { x: 4, y: 4 } });
  await page.waitForSelector(".stamp");
  await page.click('#tray [data-act="st-off"]');
  // 次の日へドラッグ
  const next = await page.evaluate((t) => { const d = new Date(t + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); }, today);
  const stampBox = await page.locator(".stamp").first().boundingBox();
  const target = await page.locator(`.cell[data-date="${next}"]`).boundingBox();
  await page.mouse.move(stampBox.x + stampBox.width / 2, stampBox.y + stampBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.waitForFunction(([d]) => true, [next]);
  await page.waitForTimeout(300);
  assert.equal(be.st.cal.cal_stamps[0].date, next);
  assert.ok(be.st.cal.cal_stamps[0].x > 0.3 && be.st.cal.cal_stamps[0].x < 0.7, "マスの中の位置: " + be.st.cal.cal_stamps[0].x);
  assert.equal(await page.locator("#panel").isVisible(), false, "ドラッグではスタンプの編集を開かない");
  // 種類を消す → 置いたスタンプも消える
  await page.click("#tab-stamp");
  await page.click('#tray [data-act="df-list"]');
  await page.click('[data-act="df-del"]');
  await page.waitForFunction(() => !document.querySelector(".lrow[data-did]"));
  assert.equal(be.st.cal.cal_stamp_defs.length, 0);
  assert.equal(be.st.cal.cal_stamps.length, 0);
  assert.equal(be.st.removed.length, 1, "画像のスタンプの画像も消す");
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("カレンダー: 上のボタン・下のタブが幅320pxでもはみ出さない(重要メモ・画像・スタンプ・TODO)", async () => {
  const { page, ctx } = await calOpen({ viewport: { width: 320, height: 640 } });
  await page.waitForSelector(".bar");
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  assert.ok(sw <= iw, `${sw} > ${iw}`);
  for (const id of ["#btn-imp", "#btn-gal", "#tab-stamp", "#tab-todo", "#today", "#next"]) {
    const b = await page.locator(id).boundingBox();
    assert.ok(b && b.x >= 0 && b.x + b.width <= 320, `${id} がはみ出す: ${JSON.stringify(b)}`);
  }
  await ctx.close();
});


const shiftIso = (d, n) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

await check("カレンダー(予定の写真): 3枚まで・小さくして入れる・予定の詳細に出して、消える日を知らせる・外す・予定を消すとファイルも消す", async () => {
  const { page, ctx, be, errors } = await calOpen();
  await page.waitForSelector(".bar");
  await page.click("#tab-new");
  await page.fill("#f-title", "運動会");
  await page.setInputFiles("#f-photo", [DIR + "photo.jpg", DIR + "big.png", DIR + "photo.jpg", DIR + "big.png"]);
  await page.waitForFunction(() => document.querySelectorAll(".pth").length === 3);
  assert.ok((await page.textContent("#form-msg")).includes("3枚まで"));
  assert.equal(await page.isDisabled("#f-photo"), true);
  await page.click("#f-save");
  await page.waitForFunction(() => document.getElementById("panel").hidden);
  assert.equal(be.st.uploads.length, 3);
  for (const u of be.st.uploads) {
    assert.ok(u.head.includes("image/jpeg"));
    assert.ok(u.size < 260 * 1024, `約200KB以下: ${u.size}`);
    assert.ok(/\/e-.*\.jpg$/.test(u.path), u.path);
  }
  assert.equal(be.st.cal.cal_photos.length, 3);
  const ev = be.st.cal.cal_events[0];
  assert.ok(be.st.cal.cal_photos.every((p) => p.event_id === ev.id));
  // 詳細: 写真が出て、消える日を知らせる
  await page.click('.bar:has-text("運動会")');
  await page.waitForFunction(() => document.querySelectorAll(".pimg").length === 3);
  const text = await page.textContent("#panel");
  assert.ok(text.includes("に消えます(予定が終わって1か月後)"), text);
  await page.waitForFunction(() => [...document.querySelectorAll(".pimg")].every((i) => i.complete && i.naturalWidth > 0));
  await page.locator(".pimg").first().click();
  assert.equal(await page.isVisible("#viewer"), true);
  await page.click("#viewer");
  // 1枚外して、別の1枚を付ける
  await page.click('[data-act="edit"]');
  await page.locator('[data-act="ph-rm"]').first().click();
  assert.equal(await page.locator(".pth").count(), 2);
  await page.setInputFiles("#f-photo", [DIR + "photo.jpg"]);
  await page.waitForFunction(() => document.querySelectorAll(".pth").length === 3);
  await page.click("#f-save");
  await page.waitForFunction(() => document.getElementById("panel").hidden);
  assert.equal(be.st.removed.length, 1);
  assert.equal(be.st.uploads.length, 4);
  assert.equal(be.st.cal.cal_photos.length, 3);
  // 予定を消すと、写真のファイルも消す(行より先に)
  page.on("dialog", (d) => d.accept().catch(() => {}));
  await page.click('.bar:has-text("運動会")');
  await page.click('[data-act="del"]');
  await page.waitForFunction(() => document.getElementById("panel").hidden);
  assert.equal(be.st.cal.cal_events.length, 0);
  assert.equal(be.st.removed.length, 1 + 3);
  assert.equal(be.st.cal.cal_photos.length, 0);
  assert.deepEqual(errors.filter((e) => !e.startsWith("dialog")), []);
  await ctx.close();
});

await check("カレンダー(予定の写真): 期限(予定の終了日から1か月)を過ぎた写真は、開いたときに、ファイルを消してから行を消す。期限の前の写真と、繰り返しの予定の写真は残す", async () => {
  const { page, ctx, be, errors } = await calOpen({}, {});
  await page.waitForSelector(".bar");
  const L = be.st.cal.cal_labels.find((l) => l.kind === "custom").id;
  const mk = (id, end, repeat) => ({ id, user_id: "u1", title: id, start_date: end, end_date: end, all_day: true, start_time: "", end_time: "", label_id: L, memo: "", repeat_rule: repeat, repeat_until: null, exdates: [], years_label: "", version: 1 });
  be.st.cal.cal_events.push(mk("E-old", shiftIso(today, -60), "none"), mk("E-new", shiftIso(today, -10), "none"), mk("E-rep", shiftIso(today, -400), "yearly"));
  const ph = (id, ev, exp) => ({ id, user_id: "u1", event_id: ev, path: `u1/${id}.jpg`, size_bytes: 1, expires_on: exp, created_at: "2026-10-01T00:00:00Z" });
  be.st.cal.cal_photos.push(ph("P-old", "E-old", shiftIso(today, -30)), ph("P-new", "E-new", shiftIso(today, 20)), ph("P-rep", "E-rep", null));
  await page.reload();
  await page.waitForSelector(".bar");
  await page.waitForFunction(() => true);
  await page.waitForTimeout(500);
  assert.deepEqual(be.st.removed, ["u1/P-old.jpg"], "期限を過ぎた写真のファイルだけ消す");
  assert.deepEqual(be.st.cal.cal_photos.map((p) => p.id), ["P-new", "P-rep"], "行も、ファイルを消したあとに消す");
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("カレンダー(予定の写真): ファイルを消せなかったときは、行を残して次にやり直す。写真だけ保存に失敗しても、予定は残して知らせる", async () => {
  const { page, ctx, be, errors } = await calOpen({}, {});
  await page.waitForSelector(".bar");
  const L = be.st.cal.cal_labels.find((l) => l.kind === "custom").id;
  be.st.cal.cal_events.push({ id: "E-old", user_id: "u1", title: "E-old", start_date: shiftIso(today, -60), end_date: shiftIso(today, -60), all_day: true, start_time: "", end_time: "", label_id: L, memo: "", repeat_rule: "none", repeat_until: null, exdates: [], years_label: "", version: 1 });
  be.st.cal.cal_photos.push({ id: "P-old", user_id: "u1", event_id: "E-old", path: "u1/P-old.jpg", size_bytes: 1, expires_on: shiftIso(today, -30), created_at: "2026-10-01T00:00:00Z" });
  // ファイルを消せない(Storage が失敗する)
  await page.route("**/storage/v1/object/calendar", (r) => r.request().method() === "DELETE" ? r.fulfill({ status: 500, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ message: "x" }) }) : r.fallback());
  await page.reload();
  await page.waitForSelector(".bar");
  await page.waitForTimeout(500);
  assert.equal(be.st.cal.cal_photos.length, 1, "ファイルを消せなかったので、行は残す");
  // 写真だけ失敗: Storage に入れられない
  await page.route("**/storage/v1/object/calendar/**", (r) => r.request().method() === "POST" ? r.fulfill({ status: 500, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ message: "upload failed" }) }) : r.fallback());
  await page.click("#tab-new");
  await page.fill("#f-title", "写真つき");
  await page.setInputFiles("#f-photo", [DIR + "photo.jpg"]);
  await page.waitForFunction(() => document.querySelectorAll(".pth").length === 1);
  await page.click("#f-save");
  await page.waitForFunction(() => document.getElementById("panel").hidden);
  assert.ok(be.st.cal.cal_events.some((e) => e.title === "写真つき"), "予定は残る");
  await page.waitForSelector("#banner:not([hidden])");
  assert.ok((await page.textContent("#banner")).includes("写真1件は保存できませんでした"));
  assert.equal(be.st.cal.cal_photos.filter((p) => p.event_id !== "E-old").length, 0);
  await ctx.close();
});


await check("カレンダー: ホーム画面に追加できる(専用の manifest・アイコン・名前)。勤務登録の manifest とは別の範囲", async () => {
  const { page, ctx } = await calOpen();
  await page.waitForSelector(".bar");
  const href = await page.getAttribute('link[rel="manifest"]', "href");
  assert.equal(href, "manifest.webmanifest");
  const res = await page.request.get(new URL(href, page.url()).href);
  const m = await res.json();
  assert.equal(m.name, "shiftflowカレンダー");
  assert.equal(m.display, "standalone");
  assert.equal(m.scope, "./");
  assert.equal(m.start_url, "./index.html");
  const main = await (await page.request.get(BASE + "/manifest.webmanifest")).json();
  assert.notEqual(m.name, main.name);
  assert.notEqual(m.id, main.id);
  // アイコンが本当にあり、大きさが宣言どおり(any 2つ・maskable 1つ)
  assert.deepEqual(m.icons.map((i) => i.purpose), ["any", "any", "maskable"]);
  for (const icon of m.icons) {
    const r = await page.request.get(new URL(icon.src, new URL(href, page.url())).href);
    assert.equal(r.status(), 200, icon.src);
    const b = await r.body();
    assert.equal(b.subarray(1, 4).toString(), "PNG");
    const [w, h] = [b.readUInt32BE(16), b.readUInt32BE(20)];
    assert.equal(`${w}x${h}`, icon.sizes, icon.src);
  }
  const apple = await page.getAttribute('link[rel="apple-touch-icon"]', "href");
  const ar = await page.request.get(new URL(apple, page.url()).href);
  assert.equal(ar.status(), 200);
  assert.equal((await ar.body()).readUInt32BE(16), 180);
  assert.equal(await page.getAttribute('meta[name="apple-mobile-web-app-title"]', "content"), "shiftflowカレンダー");
  await ctx.close();
});


await check("管理画面: 概要に無料枠の使用量(データベース・Storage の MB と割合・写真と画像の内訳・多い人)が出る。80%を超えたら注意を出す。読めなくても概要は出る", async () => {
  const a = await open("admin.html", { userId: "a1", opts: { profile: ADMIN } });
  await a.page.waitForSelector("#usage-bars .bar-row");
  const rows = await a.page.locator("#usage-bars .bar-row").allTextContents();
  assert.ok(rows[0].includes("データベース") && rows[0].includes("60MB / 500MB(12%)"), rows[0]);
  assert.ok(rows[1].includes("12MB / 1024MB(1%)"), rows[1]);
  const detail = await a.page.textContent("#usage-detail");
  assert.ok(detail.includes("予定の写真 40枚(8MB)") && detail.includes("画像の置き場 12枚(4MB)"), detail);
  assert.ok((await a.page.textContent("#usage-top")).includes("7000001 山田 太郎(3MB)"));
  assert.ok(!(await a.page.textContent("#alerts")).includes("無料枠"));
  assert.equal(await a.page.locator("#usage-bars .bar-fill.warn, #usage-bars .bar-fill.bad").count(), 0);
  await a.page.screenshot({ path: OUT + "admin-usage.png", fullPage: true });
  await a.ctx.close();
  // 80%・95%を超える
  const b = await open("admin.html", { userId: "a1", opts: { profile: ADMIN, usage: { db_bytes: 450 * 1048576, db_limit_bytes: 524288000, storage_bytes: 1040 * 1048576, storage_files: 9, storage_limit_bytes: 1073741824, photos: 1, photo_bytes: 1, gallery: 1, gallery_bytes: 1, top_users: [] } } });
  await b.page.waitForSelector("#usage-bars .bar-row");
  assert.equal(await b.page.locator("#usage-bars .bar-fill.warn").count(), 1);
  assert.equal(await b.page.locator("#usage-bars .bar-fill.bad").count(), 1);
  const alerts = await b.page.textContent("#alerts");
  assert.ok(alerts.includes("無料枠の使用量が80%を超えています") && alerts.includes("データベース") && alerts.includes("Storage"), alerts);
  await b.ctx.close();
  // 使用量が読めない: 枠だけ隠して、概要は出す
  const c = await open("admin.html", { userId: "a1", opts: { profile: ADMIN, usageFail: true } });
  await c.page.waitForSelector("#kpi-users");
  await c.page.waitForFunction(() => document.getElementById("kpi-users").textContent !== "—");
  assert.equal(await c.page.isVisible("#usage-panel"), false);
  await c.ctx.close();
});

await check("カレンダー設定: 自分の写真・画像の量が出る(MB・枚数)", async () => {
  const { page, ctx, be } = await calOpen();
  await page.waitForSelector(".bar");
  be.st.cal.cal_gallery = [{ id: "G1", user_id: "u1", path: "u1/g.jpg", title: "", size_bytes: 3 * 1048576, created_at: "2026-11-01T00:00:00Z" }];
  be.st.cal.cal_events.push({ id: "E1", user_id: "u1", title: "x", start_date: today, end_date: today, all_day: true, start_time: "", end_time: "", label_id: be.st.cal.cal_labels[0].id, memo: "", repeat_rule: "none", repeat_until: null, exdates: [], years_label: "", version: 1 });
  be.st.cal.cal_photos = [{ id: "P1", user_id: "u1", event_id: "E1", path: "u1/p.jpg", size_bytes: 524288, expires_on: null, created_at: "2026-11-01T00:00:00Z" }];
  await page.reload();
  await page.waitForSelector(".bar");
  await page.click("#tab-settings");
  const text = await page.textContent("#my-usage");
  assert.ok(text.includes("約 3.5MB(画像の置き場 1/10枚・予定の写真 1枚)"), text);
  const order = await page.$$eval("#panel .card", (els) => els.map((e) => e.querySelector("h3").textContent));
  assert.deepEqual(order, ["shiftflowカレンダーについて", "このカレンダーに出すもの", "ラベル", "月のカレンダーを画像にする", "選んだ日に〇をつけて画像にする", "あなたの写真・画像の量", "画面の色合い", "ホーム画面のアイコン"]);
  await ctx.close();
});


// ---------- カレンダーのデバッグの直し(2026-11-03) ----------
await check("デバッグ M1: 終わって1か月以上たった予定には、写真を付けられない(選べない・案内が出る)。期限の日までは付けられる。繰り返しの予定は付けられる", async () => {
  const { page, ctx, be, errors } = await calOpen();
  await page.waitForSelector(".bar");
  await page.click("#tab-new");
  await page.fill("#f-title", "昔の予定");
  const past = shiftIso(today, -50);
  await page.fill("#f-start", past);
  await page.fill("#f-end", past);
  assert.equal(await page.isDisabled("#f-photo"), true);
  assert.ok((await page.textContent("#panel")).includes("終わって1か月以上たった予定には、写真を付けられません"));
  // 繰り返し(毎年)なら付けられる
  await page.selectOption("#f-rep", "yearly");
  assert.equal(await page.isDisabled("#f-photo"), false);
  await page.setInputFiles("#f-photo", [DIR + "photo.jpg"]);
  await page.waitForFunction(() => document.querySelectorAll(".pth").length === 1);
  // 繰り返しをやめると、付けた写真があるまま保存はできない(案内が出る)
  await page.selectOption("#f-rep", "none");
  await page.click("#f-save");
  await page.waitForSelector("#form-msg:not(:empty)");
  assert.ok((await page.textContent("#form-msg")).includes("写真を付けられません"));
  assert.equal(be.st.cal.cal_events.length, 0);
  // 1か月前の今日に終わる予定(期限が今日)は、まだ付けられる
  const border = (await page.evaluate((t) => { const [y, m, d] = t.split("-").map(Number); const x = new Date(Date.UTC(y, m - 2, Math.min(d, new Date(Date.UTC(y, m - 1, 0)).getUTCDate()))); return x.toISOString().slice(0, 10); }, today));
  await page.fill("#f-start", border);
  await page.fill("#f-end", border);
  assert.equal(await page.isDisabled("#f-photo"), false, "期限が今日の予定には、まだ付けられる");
  assert.ok(!(await page.textContent("#photo-block")).includes("付けられません"));
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("デバッグ M2: 日本語入力の変換を確定する Enter(isComposing・keyCode 229)では、TODO を追加しない。ふつうの Enter では追加する", async () => {
  const { page, ctx, be, errors } = await calOpen();
  await page.waitForSelector(".bar");
  await page.click("#tab-todo");
  await page.fill("#td-new", "かいもの");
  const fire = (init) => page.evaluate((i) => document.getElementById("td-new").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...i })), init);
  await fire({ isComposing: true });
  await fire({ keyCode: 229 }); // Safari: 確定のあとの keydown
  await page.waitForTimeout(300);
  assert.equal(be.st.cal.cal_todos.length, 0);
  assert.equal(await page.inputValue("#td-new"), "かいもの");
  await page.press("#td-new", "Enter");
  await page.waitForFunction(() => document.querySelectorAll(".trow[data-tid]").length === 1);
  assert.equal(be.st.cal.cal_todos[0].text, "かいもの");
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("デバッグ M3: 月を移ったときに勤務の予定が読めなかったら、案内が出て残る。月を移ると消える", async () => {
  const { page, ctx, errors } = await calOpen();
  await page.waitForSelector(".bar");
  await page.route("**/functions/v1/calendar-shifts", (r) => r.fulfill({ status: 500, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ error: "勤務の予定を読めませんでした(テスト)。" }) }));
  // まだ読んでいない遠い月(5か月先)までスクロール
  await page.evaluate(() => { const cal = document.getElementById("cal"); cal.scrollTop += 22 * parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--rh")); });
  await page.waitForSelector("#banner:not([hidden])");
  await page.waitForTimeout(600);
  assert.ok((await page.textContent("#banner")).includes("読めませんでした"), "描き直しでも消えない");
  await page.setViewportSize({ width: 400, height: 800 }); // 描き直し(resize)でも消えない
  await page.waitForTimeout(300);
  assert.equal(await page.isVisible("#banner"), true);
  await page.unroute("**/functions/v1/calendar-shifts");
  await page.click("#prev");
  await page.waitForTimeout(700);
  assert.equal(await page.isVisible("#banner"), false, "月が変わると、前の失敗の案内は消える");
  assert.deepEqual(errors.filter((e) => !e.includes("500")), []);
  await ctx.close();
});

await check("デバッグ M4: スタンプを選んでいるあいだは、置いたスタンプの上・予定の帯の上をタップしても、そのマスに置ける。置く場所はタップした場所", async () => {
  const { page, ctx, be, errors } = await calOpen();
  await page.waitForSelector(".bar");
  be.st.cal.cal_stamp_defs = [{ id: "D1", user_id: "u1", kind: "emoji", emoji: "🎂", image_path: "", text: "", text_color: "#ffffff", bg_color: "#5b4bd6", shape: "round", default_size: 0.5, sort: 1, created_at: "2026-11-01T00:00:00Z" }];
  await page.reload();
  await page.waitForSelector(".bar");
  await page.click("#tab-stamp");
  await page.click("#tray .tk");
  const cell = page.locator(`.cell[data-date="${today}"]`);
  const box = await cell.boundingBox();
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.7);
  await page.waitForFunction(() => document.querySelectorAll(".stamp").length === 1);
  const first = be.st.cal.cal_stamps[0];
  assert.ok(Math.abs(first.x - 0.3) < 0.05 && Math.abs(first.y - 0.7) < 0.05, `タップした場所: ${first.x},${first.y}`);
  // もう1つ: 1つ目のスタンプの真上をタップ
  await page.click("#tray .tk");
  const sb = await page.locator(".stamp").first().boundingBox();
  await page.mouse.click(sb.x + sb.width / 2, sb.y + sb.height / 2);
  await page.waitForFunction(() => document.querySelectorAll(".stamp").length === 2);
  assert.equal(await page.isVisible("#panel"), false, "編集を開かない");
  // 予定の帯の上
  await page.click("#tray .tk");
  const bar = await page.locator(".bar").first().boundingBox();
  await page.mouse.click(bar.x + bar.width / 2, bar.y + bar.height / 2);
  await page.waitForFunction(() => document.querySelectorAll(".stamp").length === 3);
  assert.equal(await page.isVisible("#panel"), false, "予定の詳細を開かない");
  assert.equal(be.st.cal.cal_stamps.length, 3);
  // 何も選んでいないときは、スタンプのタップで編集が開く(置かない・画面は閉じない)
  await page.locator(".stamp").last().click();
  await page.waitForSelector("#st-size");
  assert.equal(be.st.cal.cal_stamps.length, 3);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("デバッグ M5: 画像の期限つき URL は、期限が近づいたら作り直す(1時間以上開いたままでも、画像が出る)", async () => {
  const { page, ctx, be, errors } = await calOpen({}, {});
  await page.addInitScript(() => { const n = Date.now.bind(Date); window.__off = 0; Date.now = () => n() + window.__off; });
  await page.reload();
  await page.waitForSelector(".bar");
  be.st.cal.cal_gallery = [{ id: "G1", user_id: "u1", path: "u1/g.jpg", title: "表", size_bytes: 10, created_at: "2026-11-01T00:00:00Z" }];
  await page.reload();
  await page.waitForSelector(".bar");
  const signs = () => be.st.calls.filter((c) => c.path.startsWith("/storage/v1/object/sign/calendar") && c.method === "POST").length;
  await page.click("#btn-gal");
  await page.waitForFunction(() => document.querySelector(".gitem img")?.getAttribute("src"));
  const first = signs();
  await page.click('[data-act="close"]');
  await page.click("#btn-gal");
  await page.waitForSelector(".gitem img");
  await page.waitForTimeout(200);
  assert.equal(signs(), first, "期限の前なら、作り直さない");
  await page.click('[data-act="close"]');
  await page.evaluate(() => { window.__off = 56 * 60 * 1000; }); // 56分後(期限の5分前を過ぎる)
  await page.click("#btn-gal");
  await page.waitForFunction(() => document.querySelector(".gitem img")?.getAttribute("src"));
  await page.waitForTimeout(200);
  assert.equal(signs(), first + 1, "期限が近いので作り直す");
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("デバッグ L5: 12か月より前に終わる予定は作れない(案内)。誕生日などの繰り返しは、昔の日付から始められる", async () => {
  const { page, ctx, be, errors } = await calOpen();
  await page.waitForSelector(".bar");
  await page.click("#tab-new");
  await page.fill("#f-title", "古い予定");
  await page.fill("#f-start", "2020-01-01");
  await page.fill("#f-end", "2020-01-01");
  await page.click("#f-save");
  await page.waitForSelector("#form-msg:not(:empty)");
  assert.ok((await page.textContent("#form-msg")).includes("より前の予定は作れません"));
  assert.equal(be.st.cal.cal_events.length, 0);
  await page.selectOption("#f-rep", "yearly");
  await page.click("#f-save");
  await page.waitForFunction(() => document.getElementById("panel").hidden);
  assert.equal(be.st.cal.cal_events.length, 1);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("デバッグ L6・L2: スタンプの画面では「スタンプ」だけが太字。ファイルを選ぶボタンは、入力がボタンの上に重なる", async () => {
  const { page, ctx, errors } = await calOpen();
  await page.waitForSelector(".bar");
  assert.equal(await page.locator("#tab-today.on").count(), 1);
  await page.click("#tab-stamp");
  assert.equal(await page.locator("#tab-today.on").count(), 0);
  assert.equal(await page.locator("#tab-stamp.on").count(), 1);
  await page.click('#tray [data-act="st-off"]');
  assert.equal(await page.locator("#tab-today.on").count(), 1);
  await page.click("#btn-gal");
  const [lb, ib] = await Promise.all([page.locator(".filebtn").boundingBox(), page.locator("#gal-file").boundingBox()]);
  assert.ok(Math.abs(lb.x - ib.x) <= 3 && Math.abs(lb.y - ib.y) <= 3 && Math.abs(lb.width - ib.width) <= 3, `入力がボタンに重なる: ${JSON.stringify([lb, ib])}`);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("デバッグ L9: 画像を読む方法が使えない端末(createImageBitmap が失敗する)でも、<img> で読んで縮小・保存できる", async () => {
  const { page, ctx, be, errors } = await calOpen({}, {});
  await page.addInitScript(() => { window.createImageBitmap = () => Promise.reject(new Error("unsupported")); });
  await page.reload();
  await page.waitForSelector(".bar");
  await page.click("#btn-gal");
  await page.setInputFiles("#gal-file", [DIR + "photo.jpg"]);
  await page.waitForFunction(() => document.querySelectorAll(".gitem").length === 1, null, { timeout: 15000 });
  assert.equal(be.st.uploads.length, 1);
  assert.ok(be.st.uploads[0].head.includes("image/jpeg"));
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("デバッグ L10: 戻るボタンで、パネル・大きな画像を閉じる(アプリを閉じない)。✕で閉じたあとの戻るは、後から開いたパネルを閉じない", async () => {
  const { page, ctx, be, errors } = await calOpen();
  await page.waitForSelector(".bar");
  const url = page.url();
  // 戻るボタンでパネルが閉じる
  await page.click("#tab-settings");
  await page.waitForSelector("#about");
  await page.goBack();
  await page.waitForFunction(() => document.getElementById("panel").hidden);
  assert.equal(page.url(), url, "ページは移らない");
  // ✕ で閉じたあとに別のパネルを開き、戻るで閉じる
  await page.click("#tab-todo");
  await page.click('[data-act="close"]');
  await page.waitForFunction(() => document.getElementById("panel").hidden);
  await page.click("#tab-settings");
  await page.waitForTimeout(300);
  assert.equal(await page.isVisible("#panel"), true, "✕ の戻る(読み飛ばし)が、あとのパネルを閉じない");
  await page.goBack();
  await page.waitForFunction(() => document.getElementById("panel").hidden);
  // 画像の置き場 → 大きな画像 → 戻る(画像だけ閉じる)→ 戻る(パネルが閉じる)
  be.st.cal.cal_gallery = [{ id: "G1", user_id: "u1", path: "u1/g.jpg", title: "表", size_bytes: 10, created_at: "2026-11-01T00:00:00Z" }];
  await page.reload();
  await page.waitForSelector(".bar");
  await page.click("#btn-gal");
  await page.waitForSelector(".gitem img");
  await page.waitForFunction(() => document.querySelector(".gitem img")?.getAttribute("src"));
  await page.locator(".gitem img").first().click();
  assert.equal(await page.isVisible("#viewer"), true);
  await page.goBack();
  await page.waitForFunction(() => document.getElementById("viewer").hidden);
  assert.equal(await page.isVisible("#panel"), true, "画像だけが閉じる");
  await page.goBack();
  await page.waitForFunction(() => document.getElementById("panel").hidden);
  // Esc: 画像 → パネルの順
  await page.click("#btn-gal");
  await page.waitForSelector(".gitem img");
  await page.waitForFunction(() => document.querySelector(".gitem img")?.getAttribute("src"));
  await page.locator(".gitem img").first().click();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.getElementById("viewer").hidden);
  assert.equal(await page.isVisible("#panel"), true);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.getElementById("panel").hidden);
  assert.deepEqual(errors, []);
  await ctx.close();
});


await check("デバッグ D1: 失敗の案内は、閉じるボタンで消せる。次に読み直しが成功したら、自動で消える", async () => {
  const { page, ctx, errors } = await calOpen();
  await page.waitForSelector(".bar");
  const wake = async () => {
    await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
    await page.waitForTimeout(2200);
    await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
  };
  await page.route("**/functions/v1/calendar-shifts", (r) => r.fulfill({ status: 500, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ error: "一時的な失敗(テスト)" }) }));
  await wake();
  await page.waitForSelector("#banner:not([hidden])");
  assert.ok((await page.textContent("#banner")).includes("一時的な失敗"));
  // 閉じるボタン
  await page.click('#banner [data-act="dismiss-notice"]');
  assert.equal(await page.isVisible("#banner"), false);
  // 失敗 → 成功: 自動で消える
  await wake();
  await page.waitForSelector("#banner:not([hidden])");
  await page.unroute("**/functions/v1/calendar-shifts");
  await wake();
  await page.waitForFunction(() => document.getElementById("banner").hidden, null, { timeout: 5000 });
  assert.deepEqual(errors.filter((e) => !e.includes("500")), []);
  await ctx.close();
});

await check("デバッグ D4: スタンプのトレーに、動かし方の案内が出る(選ぶ前・選んだあと)", async () => {
  const { page, ctx, be } = await calOpen();
  await page.waitForSelector(".bar");
  be.st.cal.cal_stamp_defs = [{ id: "D1", user_id: "u1", kind: "emoji", emoji: "🎂", image_path: "", text: "", text_color: "#ffffff", bg_color: "#5b4bd6", shape: "round", default_size: 0.5, sort: 1, created_at: "2026-11-01T00:00:00Z" }];
  await page.reload();
  await page.waitForSelector(".bar");
  await page.click("#tab-stamp");
  assert.ok((await page.textContent("#tray")).includes("ドラッグで移動"));
  await page.click("#tray .tk");
  assert.ok((await page.textContent("#tray")).includes("選びを外す"));
  await ctx.close();
});

await check("デバッグ D9: 使い方ページに、shiftflowカレンダーの説明がある(目次からも行ける)", async () => {
  const { page, ctx } = await open("help.html", { opts: {} });
  await page.waitForSelector("#calendar-app");
  assert.ok((await page.textContent("#calendar-app")).includes("過去1年"));
  assert.equal(await page.locator('.toc a[href="#calendar-app"]').count(), 1);
  await ctx.close();
});



await check("カレンダー: 勤務・休日・非番を別々のラベルで隠せる。勤務を隠しても、非番(「〜」とその時間)・休日は消えない。今の利用者には、非番のラベルだけが足される", async () => {
  const ev = (d, title, group, calendar = "work", extra = {}) => ({ date: d, endDate: d, allDay: true, startTime: "", endTime: "", calendar, kind: "day", title, description: "", group, ...extra });
  const shifts = [ev(today, "25", "duty"), ev(shiftIso(today, 1), "〜", "duty", "work", { kind: "offduty" }), ev(shiftIso(today, 1), "9:54", "offduty", "work", { allDay: false, startTime: "09:54", endTime: "10:54", kind: "time" }), ev(shiftIso(today, 2), "公休", "off", "holiday")];
  const { page, ctx, be, errors } = await calOpen({}, { shifts });
  await page.waitForSelector(".bar");
  const bars = () => page.locator(".bar").allTextContents();
  // 「〜」と時間は2段(2本)。時間は「9:54」だけ(同じ時間を2回出さない)
  assert.deepEqual((await bars()).sort(), ["25", "〜", "9:54", "公休"].sort());
  await page.click('#chips .chip:has-text("勤務")');
  assert.deepEqual((await bars()).sort(), ["9:54", "公休"].sort(), "勤務(25・〜)だけが消える。非番の時間は残る");
  await page.click('#chips .chip:has-text("勤務")');
  await page.click('#chips .chip:has-text("非番")');
  assert.deepEqual((await bars()).sort(), ["25", "〜", "公休"].sort(), "非番の時間だけが消える");
  // 非番の色は、非番のラベルの色
  await page.click('#chips .chip:has-text("非番")');
  const color = await page.locator('.bar:text-is("9:54")').evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.equal(color, "rgb(212, 96, 122)");
  // 「〜」は勤務の色(Google で「〜」が勤務のカレンダーに入るのと同じ)
  assert.equal(await page.locator('.bar:text-is("〜")').evaluate((el) => getComputedStyle(el).backgroundColor), "rgb(59, 111, 212)");
  // 今の利用者(勤務・休日・その他だけ持っている)に、非番だけが足される
  be.st.cal.cal_labels = be.st.cal.cal_labels.filter((l) => l.kind !== "offduty");
  await page.reload();
  await page.waitForSelector("#chips .chip");
  await page.waitForFunction(() => document.querySelectorAll("#chips .chip").length === 4);
  assert.deepEqual(await page.locator("#chips .chip").allTextContents(), ["勤務", "休日", "非番", "その他"]);
  assert.equal(be.st.cal.cal_labels.filter((l) => l.kind === "offduty").length, 1);
  assert.deepEqual(errors, []);
  await ctx.close();
});


await check("カレンダー: 非番の時間用カレンダーを使っていない人には、「非番」のボタンを出さない(非番の予定は、勤務のボタンで隠れる=今までどおり)。設定のラベルにも出ない", async () => {
  const ev = (d, title, group, calendar = "work") => ({ date: d, endDate: d, allDay: true, startTime: "", endTime: "", calendar, kind: "day", title, description: "", group });
  const shifts = [ev(today, "25", "duty"), ev(shiftIso(today, 1), "〜", "duty", "work", { kind: "offduty" }), ev(shiftIso(today, 1), "9:54", "offduty", "work", { allDay: false, startTime: "09:54", endTime: "10:54", kind: "time" }), ev(shiftIso(today, 2), "公休", "off", "holiday")];
  const { page, ctx, errors } = await calOpen({}, { shifts, settings: { holiday_calendar_id: "h@group.calendar.google.com", offduty_calendar_id: "" } });
  await page.waitForSelector(".bar");
  assert.deepEqual(await page.locator("#chips .chip").allTextContents(), ["勤務", "休日", "その他"]);
  await page.click('#chips .chip:has-text("勤務")');
  assert.deepEqual((await page.locator(".bar").allTextContents()), ["公休"], "非番の時間も勤務に含めて出るので、一緒に隠れる");
  await page.click('#chips .chip:has-text("勤務")');
  await page.click("#tab-settings");
  const names = await page.$$eval('#panel .lrow [data-lf="name"]', (els) => els.map((e) => e.value));
  assert.deepEqual(names, ["勤務", "休日", "その他"]);
  assert.deepEqual(errors, []);
  await ctx.close();
});


await check("カレンダー設定「このカレンダーに出すもの」: Googleに登録していて休日用カレンダーが無い人は、休日が外れた状態から。チェックを入れると、休日のボタンと予定が出る(保存される)", async () => {
  const ev = (d, title, group, calendar = "work") => ({ date: d, endDate: d, allDay: true, startTime: "", endTime: "", calendar, kind: "day", title, description: "", group });
  const shifts = [ev(today, "25", "duty"), ev(shiftIso(today, 2), "公休", "off", "holiday")];
  const { page, ctx, be, errors } = await calOpen({}, { shifts, settings: { holiday_calendar_id: "", offduty_calendar_id: "" } });
  await page.waitForSelector(".bar");
  assert.deepEqual(await page.locator("#chips .chip").allTextContents(), ["勤務", "その他"], "休日のボタンを出さない");
  assert.deepEqual(await page.locator(".bar").allTextContents(), ["25"], "休日の予定も出さない");
  await page.click("#tab-settings");
  assert.equal(await page.isChecked("#cv-duty"), true);
  assert.equal(await page.isChecked("#cv-off"), false);
  assert.equal(await page.isChecked("#cv-offduty"), false);
  await page.check("#cv-off");
  await page.waitForFunction(() => document.querySelectorAll("#chips .chip").length === 3);
  assert.deepEqual(await page.locator("#chips .chip").allTextContents(), ["勤務", "休日", "その他"]);
  const post = be.st.calls.find((c) => c.path === "/rest/v1/user_settings" && c.method === "PATCH" && c.body && "cal_show_off" in c.body);
  assert.equal(post.body.cal_show_off, true);
  await page.click('[data-act="close"]');
  assert.deepEqual((await page.locator(".bar").allTextContents()).sort(), ["25", "公休"].sort());
  // 開き直しても、自分で決めた値のまま
  await page.reload();
  await page.waitForSelector(".bar");
  assert.deepEqual((await page.locator(".bar").allTextContents()).sort(), ["25", "公休"].sort());
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("カレンダー設定: アプリだけで使う人(Googleに登録しない)は、休日は出る。「非番を別のボタンにする」にチェックを入れると、非番のボタン・別の色が作られる。勤務を外すと勤務は出ない", async () => {
  const ev = (d, title, group, calendar = "work") => ({ date: d, endDate: d, allDay: true, startTime: "", endTime: "", calendar, kind: "day", title, description: "", group });
  const shifts = [ev(today, "25", "duty"), ev(shiftIso(today, 1), "〜", "duty", "work", { kind: "offduty" }), ev(shiftIso(today, 1), "9:54", "offduty", "work", { allDay: false, startTime: "09:54", endTime: "10:54", kind: "time" }), ev(shiftIso(today, 2), "公休", "off", "holiday")];
  const { page, ctx, be, errors } = await calOpen({}, { shifts, settings: { google_sync: false, holiday_calendar_id: "", offduty_calendar_id: "" } });
  await page.waitForSelector(".bar");
  assert.deepEqual(await page.locator("#chips .chip").allTextContents(), ["勤務", "休日", "その他"]);
  await page.click("#tab-settings");
  assert.equal(await page.isChecked("#cv-off"), true);
  assert.equal(await page.isChecked("#cv-offduty"), false);
  await page.check("#cv-offduty");
  await page.waitForFunction(() => document.querySelectorAll("#chips .chip").length === 4);
  assert.deepEqual(await page.locator("#chips .chip").allTextContents(), ["勤務", "休日", "非番", "その他"]);
  assert.equal(be.st.calls.filter((c) => c.path === "/rest/v1/user_settings" && c.method === "PATCH" && c.body && "cal_offduty_label" in c.body).pop().body.cal_offduty_label, true);
  // 設定のラベル一覧にも、非番が出る
  assert.deepEqual(await page.$$eval('#panel .lrow [data-lf="name"]', (els) => els.map((e) => e.value)), ["勤務", "休日", "非番", "その他"]);
  await page.click('[data-act="close"]');
  const color = await page.locator('.bar:text-is("9:54")').evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.equal(color, "rgb(212, 96, 122)");
  // 非番を外すと、勤務に含めて出る(勤務のボタンで隠れる)
  await page.click("#tab-settings");
  await page.uncheck("#cv-offduty");
  await page.waitForFunction(() => document.querySelectorAll("#chips .chip").length === 3);
  await page.click('[data-act="close"]');
  assert.ok((await page.locator(".bar").allTextContents()).includes("9:54"));
  await page.click('#chips .chip:has-text("勤務")');
  assert.deepEqual(await page.locator(".bar").allTextContents(), ["公休"], "非番の時間は勤務に含まれるので、一緒に隠れる");
  await page.click('#chips .chip:has-text("勤務")');
  // 勤務を外す
  await page.click("#tab-settings");
  await page.uncheck("#cv-duty");
  await page.waitForFunction(() => document.querySelectorAll("#chips .chip").length === 2);
  await page.click('[data-act="close"]');
  assert.deepEqual(await page.locator(".bar").allTextContents(), ["公休"], "勤務(と、勤務に含めた非番)は出ない");
  assert.deepEqual(errors, []);
  await ctx.close();
});


await check("カレンダー表記: 「名前に退勤時間を付ける」なら「〜(10:00)」の1本。「2段で出す」なら「〜」と「10:00」の2本(時間は1回だけ)。設定で決めたことが、そのまま出る", async () => {
  const ev = (d, title, extra = {}) => ({ date: d, endDate: d, allDay: true, startTime: "", endTime: "", calendar: "work", kind: "day", title, description: "", group: "duty", ...extra });
  // 名前に時間(サーバーが「〜(10:00)」にして返す)
  const a = await calOpen({}, { shifts: [ev(today, "〜(10:00)", { kind: "offduty" })] });
  await a.page.waitForSelector(".bar");
  assert.deepEqual(await a.page.locator(".bar").allTextContents(), ["〜(10:00)"]);
  await a.ctx.close();
  // 2段
  const b = await calOpen({}, { shifts: [ev(today, "〜", { kind: "offduty" }), ev(today, "10:00", { group: "offduty", kind: "time", allDay: false, startTime: "10:00", endTime: "11:00" })] });
  await b.page.waitForSelector(".bar");
  const texts = await b.page.locator(".bar").allTextContents();
  assert.deepEqual(texts, ["〜", "10:00"], "2段(2本)・時間は1回だけ");
  const boxes = await b.page.locator(".bar").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
  assert.ok(boxes[1] > boxes[0], "時間の帯は「〜」の下");
  await b.ctx.close();
});

await check("設定: Google連携を外しても、カレンダーの表記(時間つき・2段・名前に時間)は出ていて、保存できる。Googleの設定(ID・共有)だけが隠れる", async () => {
  const { page, ctx, be, errors } = await open("settings.html", { userId: "u1", opts: { profile: USER, settings: { google_sync: false, work_calendar_id: "", verified_at: null } } });
  await page.waitForSelector("#office option[value='1']", { state: "attached" });
  for (const id of ["#timed-events", "#split-day", "#split-offduty", "#title-day", "#title-offduty"]) assert.equal(await page.isVisible(id), true, id);
  assert.equal(await page.isVisible("#work-id"), false);
  assert.equal(await page.isVisible("#google-top"), false);
  await page.check("#split-offduty");
  await page.click("#save");
  await page.waitForSelector("#result.ok");
  const saved = be.st.calls.find((c) => c.path === "/rest/v1/user_settings" && c.method === "PATCH").body;
  assert.equal(saved.split_offduty_events, true);
  assert.equal(saved.google_sync, false);
  assert.ok(!be.st.calls.some((c) => c.path === "/functions/v1/verify-calendar"));
  // 説明は折りたためる
  assert.ok((await page.locator("#notation-card details.more").count()) >= 3);
  assert.deepEqual(errors, []);
  await ctx.close();
});


await check("カレンダー(スタンプを作る): 文字スタンプのプレビューは、色・形つきの札で、箱の真ん中。「画像を選ぶ」の文字はボタンの真ん中", async () => {
  const { page, ctx, errors } = await calOpen();
  await page.waitForSelector(".bar");
  await page.click("#tab-stamp");
  await page.click('#tray [data-act="df-new"]');
  await page.check('input[name="dkind"][value="text"]', { force: true });
  await page.fill("#d-text", "休日");
  const tx = page.locator("#d-prev .tx");
  await tx.waitFor();
  const [bg, radius, white] = await tx.evaluate((el) => { const c = getComputedStyle(el); return [c.backgroundColor, c.borderRadius, c.whiteSpace]; });
  assert.notEqual(bg, "rgba(0, 0, 0, 0)", "背景色が付く");
  assert.equal(white, "nowrap", "縦に折り返さない");
  assert.ok(parseFloat(radius) > 20, "丸");
  const [pb, tb] = await Promise.all([page.locator("#d-prev").boundingBox(), tx.boundingBox()]);
  assert.ok(Math.abs((pb.x + pb.width / 2) - (tb.x + tb.width / 2)) < 2 && Math.abs((pb.y + pb.height / 2) - (tb.y + tb.height / 2)) < 2, "箱の真ん中: " + JSON.stringify([pb, tb]));
  assert.ok(tb.height < 40, "1行: " + tb.height);
  // 長い文字(8文字)でも、箱が広がって収まる
  await page.fill("#d-text", "ABCDEFGH");
  const [pb2, tb2] = await Promise.all([page.locator("#d-prev").boundingBox(), tx.boundingBox()]);
  assert.ok(tb2.x >= pb2.x - 1 && tb2.x + tb2.width <= pb2.x + pb2.width + 1, "箱の中に収まる");
  // 画像を選ぶボタンの文字は、ボタンの真ん中
  await page.check('input[name="dkind"][value="image"]', { force: true });
  const btn = page.locator(".filebtn");
  const disp = await btn.evaluate((el) => { const c = getComputedStyle(el); return [c.display, c.alignItems, c.justifyContent]; });
  assert.deepEqual(disp, ["inline-flex", "center", "center"]);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("カレンダー(スタンプを作る): 大きさのスライダーで、プレビューが実際の大きさ(カレンダーの幅 × 大きさ)に変わる", async () => {
  const { page, ctx, errors } = await calOpen();
  await page.waitForSelector(".bar");
  const calW = await page.evaluate(() => document.querySelector(".stc").clientWidth);
  await page.click("#tab-stamp");
  await page.click('#tray [data-act="df-new"]');
  await page.waitForSelector("#d-prev");
  const widthAt = async (v) => {
    await page.locator("#d-size").evaluate((el, val) => { el.value = String(val); el.dispatchEvent(new Event("input", { bubbles: true })); }, v);
    return (await page.locator("#d-prev").boundingBox()).width;
  };
  const w1 = await widthAt(0.3), w2 = await widthAt(0.6);
  assert.ok(Math.abs(w1 - 0.3 * calW) < 2, `0.3 → ${w1} (カレンダー幅 ${calW})`);
  assert.ok(Math.abs(w2 - 0.6 * calW) < 2, `0.6 → ${w2}`);
  assert.ok(w2 > w1 * 1.9, "大きさを2倍にすると、プレビューも2倍");
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("カレンダー(スタンプ): 画像のスタンプは、描き直し(タップ・編集を閉じる)で一瞬空になって点滅しない", async () => {
  const { page, ctx, be, errors } = await calOpen();
  await page.waitForSelector(".bar");
  be.st.cal.cal_stamp_defs = [{ id: "D2", user_id: "u1", kind: "image", emoji: "", image_path: "u1/s.png", text: "", text_color: "#ffffff", bg_color: "#5b4bd6", shape: "round", default_size: 0.4, sort: 1, created_at: "2026-10-02T00:00:00Z" }];
  await page.reload();
  await page.waitForSelector(".bar");
  await page.click("#tab-stamp");
  await page.click("#tray .tk");
  const box = await page.locator(`.cell[data-date="${today}"]`).boundingBox();
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.7);
  await page.waitForFunction(() => document.querySelector("#weeks .stamp img")?.getAttribute("src"));
  // ここから先の描き直しで、src の無い画像が1度でも現れたら NG
  await page.evaluate(() => {
    window.__blank = 0;
    new MutationObserver(() => { if ([...document.querySelectorAll("#weeks .stamp img")].some((i) => !i.getAttribute("src"))) window.__blank++; }).observe(document.getElementById("weeks"), { childList: true, subtree: true });
  });
  const sb = await page.locator(".stamp").first().boundingBox();
  await page.mouse.click(sb.x + sb.width / 2, sb.y + sb.height / 2);
  await page.waitForSelector("#st-size");
  await page.click('[data-act="close"]');
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.__blank), 0, "画像が空になった回数");
  assert.equal(await page.locator("#weeks .stamp").count(), 1);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("カレンダー(スタンプ): スタンプをタップして編集を開いた直後に、同じタップの click が背景に当たっても、編集は閉じない。背景を押せば閉じる", async () => {
  const { page, ctx, be, errors } = await calOpen();
  await page.waitForSelector(".bar");
  be.st.cal.cal_stamp_defs = [{ id: "D1", user_id: "u1", kind: "emoji", emoji: "🎂", image_path: "", text: "", text_color: "#ffffff", bg_color: "#5b4bd6", shape: "round", default_size: 0.5, sort: 1, created_at: "2026-10-01T00:00:00Z" }];
  be.st.cal.cal_stamps = [{ id: "S1", user_id: "u1", stamp_def_id: "D1", date: today, x: 0.5, y: 0.6, size: 0.5, rotation: 0, notes: [], created_at: "2026-10-02T00:00:00Z" }];
  await page.reload();
  await page.waitForSelector(".stamp");
  await page.locator(".stamp").first().click();
  await page.waitForSelector("#st-size");
  // 同じタップから遅れて出る click(背景に当たる)を真似る: 押し始めが無い click
  await page.evaluate(() => document.getElementById("scrim").click());
  await page.waitForTimeout(300);
  assert.equal(await page.isVisible("#st-size"), true, "編集が開いたまま");
  // 背景を実際に押す(押し始めからの click)と閉じる
  await page.mouse.click(10, 200);
  await page.waitForFunction(() => document.getElementById("panel").hidden);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("デバッグ 25回目(1): 読み直しに失敗しても、勤務の帯は消えない(描き直しても残る)。通信が戻れば読み直せる", async () => {
  const { page, ctx, errors } = await calOpen();
  await page.waitForSelector(".bar");
  const before = await page.locator(".bar").count();
  assert.ok(before > 0);
  await page.route("**/functions/v1/calendar-shifts", (r) => r.abort());
  await page.evaluate(() => { const vs = (v) => Object.defineProperty(document, "visibilityState", { configurable: true, get: () => v }); window.__vs = vs; vs("hidden"); document.dispatchEvent(new Event("visibilitychange")); });
  await page.waitForTimeout(2200);
  await page.evaluate(() => { window.__vs("visible"); document.dispatchEvent(new Event("visibilitychange")); });
  await page.waitForSelector("#banner:not([hidden])");
  await page.click("#chips .chip >> nth=3"); // 描き直しが走る
  await page.waitForTimeout(300);
  assert.equal(await page.locator(".bar").count(), before, "失敗しても、今の帯は残る");
  await ctx.close();
});

await check("デバッグ 25回目(3): 予定を保存できたあとに読み直しが失敗しても、保存画面は固まらず、保存できたと知らせる", async () => {
  const { page, ctx, be } = await calOpen();
  await page.waitForSelector(".bar");
  await page.click("#tab-new");
  await page.fill("#f-title", "歯医者");
  await page.route("**/rest/v1/cal_labels*", (r) => r.abort()); // 保存のあとの読み直しだけ失敗させる
  await page.click("#f-save");
  await page.waitForFunction(() => document.getElementById("panel").hidden);
  assert.equal(be.st.cal.cal_events.length, 1, "予定は保存されている");
  const banner = await page.locator("#banner").innerText();
  assert.ok(banner.includes("予定は保存しました"), banner);
  await ctx.close();
});

await check("デバッグ 25回目(5): TODOの追加・重要メモの保存は、同時に2回起きても1件だけ", async () => {
  const { page, ctx, be } = await calOpen();
  await page.waitForSelector(".bar");
  await page.click("#tab-todo");
  await page.fill("#td-new", "牛乳");
  await page.evaluate(() => { const i = document.getElementById("td-new"); for (let k = 0; k < 2; k++) i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
  await page.waitForTimeout(500);
  assert.equal(be.st.cal.cal_todos.length, 1, "TODOが2件になっていない");
  await ctx.close();
});

await check("デバッグ 25回目(4): 起動で勤務の予定を読む通信は3回まで(続く月はまとめて読む)。前後の月も出る", async () => {
  const { page, ctx, be, errors } = await calOpen();
  await page.waitForSelector(".bar");
  await page.waitForTimeout(800);
  const calls = be.st.calls.filter((c) => c.path === "/functions/v1/calendar-shifts");
  assert.ok(calls.length >= 1 && calls.length <= 3, "通信の数: " + calls.length);
  // どの通信も、サーバーが読める範囲(月の画面で5か月まで)に収まる
  for (const c of calls) assert.ok((new Date(c.body.to) - new Date(c.body.from)) / 86400000 <= 160, `範囲が広すぎる ${c.body.from}〜${c.body.to}`);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("カレンダー設定: 「月のカレンダーを画像にする」「〇をつけて画像にする」が、ラベルの下に並ぶ。月の画像が作れる(横1080px)", async () => {
  const { page, ctx, errors } = await calOpen();
  await page.waitForSelector(".bar");
  await page.click("#tab-settings");
  await page.waitForSelector("#mimg");
  // 並び: ラベル → 月の画像 → 〇の画像 → 写真・画像の量
  const order = await page.locator("#panel .card h3").allTextContents();
  const i = (t) => order.findIndex((x) => x.includes(t));
  assert.ok(i("ラベル") >= 0 && i("月のカレンダーを画像にする") === i("ラベル") + 1 && i("〇をつけて画像にする") === i("ラベル") + 2 && i("写真・画像の量") === i("ラベル") + 3, order.join(" / "));
  await page.click('[data-act="img-make"]');
  await page.waitForSelector("#mimg img.mimg");
  const dim = await page.locator("#mimg img.mimg").evaluate((im) => new Promise((r) => { if (im.complete) r([im.naturalWidth, im.naturalHeight]); else im.onload = () => r([im.naturalWidth, im.naturalHeight]); }));
  assert.equal(dim[0], 1080);
  assert.ok(dim[1] > 600, "高さ: " + dim[1]);
  // 詳しい説明(折りたたみ)が、2つのカードにある
  assert.equal(await page.locator("#mimg details.more, #mkimg details.more").count(), 2);
  assert.equal(await page.locator("#mimg details.more[open]").count(), 0, "最初は閉じている");
  await page.click("#mimg details.more summary");
  assert.ok((await page.textContent("#mimg details.more")).includes("横1080px"));
  assert.equal(await page.locator('#mimg [data-act="img-share"]').count(), 1);
  assert.equal(await page.locator('#mimg [data-act="img-save"]').count(), 1);
  // 保存する: ファイルがダウンロードされる
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click('#mimg [data-act="img-save"]')]);
  assert.match(dl.suggestedFilename(), /^calendar-\d{4}-\d{2}\.png$/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("カレンダー設定: 〇をつける日を選ぶ(予定を見ながらタップ・もう一度で外す)→ 画像を作ると設定に戻って出る。選びを全部外せる", async () => {
  const { page, ctx, errors } = await calOpen();
  await page.waitForSelector(".bar");
  await page.click("#tab-settings");
  await page.click('[data-act="mark-start"]');
  await page.waitForSelector("#markbar:not([hidden])");
  assert.equal(await page.isVisible("#panel"), false, "設定は閉じる(カレンダーが見える)");
  assert.ok((await page.textContent("#markbar")).includes("〇をつける日をタップ"));
  assert.equal(await page.locator('#markbar [data-act="mark-make"]').isDisabled(), true);
  const tap = async (d) => { const b = await page.locator(`.cell[data-date="${d}"]`).boundingBox(); await page.mouse.click(b.x + b.width * 0.8, b.y + b.height * 0.8); };
  await tap(today);
  await page.waitForSelector(".cell.mk");
  const nextDay = await page.evaluate((t) => { const d = new Date(t + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); }, today);
  await tap(nextDay);
  await page.waitForFunction(() => document.querySelectorAll(".cell.mk").length === 2);
  assert.ok((await page.textContent("#markbar")).includes("2日を選んでいます"));
  await tap(nextDay); // もう一度で外す
  await page.waitForFunction(() => document.querySelectorAll(".cell.mk").length === 1);
  assert.equal(await page.isVisible("#panel"), false, "日のタップで、予定の画面は開かない");
  await page.click('#markbar [data-act="mark-make"]');
  await page.waitForSelector("#mkimg img.mimg");
  assert.equal(await page.isVisible("#panel"), true, "設定に戻る");
  assert.equal(await page.locator("#markbar").isHidden(), true);
  const w = await page.locator("#mkimg img.mimg").first().evaluate((im) => new Promise((r) => { if (im.complete) r(im.naturalWidth); else im.onload = () => r(im.naturalWidth); }));
  assert.equal(w, 1080);
  await page.click('#mkimg [data-act="mark-clear"]');
  await page.waitForFunction(() => !document.querySelector("#mkimg img.mimg"));
  assert.equal(await page.locator(".cell.mk").count(), 0);
  // 日を選んでいる途中で他のタブを開くと、選ぶのをやめる(選んだ日は残る)
  await page.click('[data-act="mark-start"]').catch(async () => { await page.click("#tab-settings"); await page.click('[data-act="mark-start"]'); });
  await page.waitForSelector("#markbar:not([hidden])");
  await page.click("#tab-todo");
  await page.waitForSelector("#markbar", { state: "hidden" });
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("使い方ページ: 最初は「1. アプリのカレンダーを使う設定」と「2. 勤務を入力する」だけが開く。全体の流れ・新規登録の節は無い。目次を押すと、その節が開く", async () => {
  const { page, ctx, errors } = await open("help.html", { opts: {} });
  await page.waitForSelector("#app-setup");
  const opened = await page.evaluate(() => [...document.querySelectorAll("details.fold")].filter((d) => d.open).map((d) => d.id));
  assert.deepEqual(opened.sort(), ["app-setup", "use"].sort());
  assert.equal(await page.locator("#intro, #signup").count(), 0);
  assert.ok((await page.textContent("#app-setup")).includes("区所を選ぶ"));
  // 目次: Googleカレンダー → スマホ
  await page.click('.toc a[href="#google"]');
  await page.waitForFunction(() => document.getElementById("google").open);
  await page.click('.toc a[href="#google-pc"]');
  await page.waitForFunction(() => document.getElementById("google-pc").open && document.getElementById("google").open);
  assert.equal(await page.locator("#google-pc").isVisible(), true);
  // スマホ・パソコンの2つに分かれている
  assert.equal(await page.locator("#google > .foldbody > details.fold.sub").count() >= 2, true);
  assert.ok((await page.textContent("#google-phone")).includes("簡単設定"));
  assert.ok((await page.textContent("#google-pc")).includes("calendar.google.com"));
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("使い方ページ: 設定ページからの古いリンク(#share・#test)と、消した節のリンク(#signup・#settings)が、正しい節を開く。全部開く/閉じる。幅320pxではみ出さない", async () => {
  for (const [hash, want] of [["share", ["google", "google-phone"]], ["test", ["google", "google-info"]], ["signup", ["app-setup"]], ["settings", ["google", "google-phone"]], ["id", ["google", "google-pc"]], ["photo", ["use", "photo"]]]) {
    const { page, ctx, errors } = await open("help.html#" + hash, { opts: {}, viewport: { width: 320, height: 700 } });
    await page.waitForSelector("#app-setup");
    await page.waitForFunction((w) => w.every((id) => document.getElementById(id).open), want);
    assert.deepEqual(errors, [], hash);
    await ctx.close();
  }
  const { page, ctx } = await open("help.html", { opts: {}, viewport: { width: 320, height: 700 } });
  await page.waitForSelector("#app-setup");
  await page.click("#fold-all");
  assert.equal(await page.evaluate(() => [...document.querySelectorAll("details.fold")].every((d) => d.open)), true);
  assert.equal(await page.textContent("#fold-all"), "全部閉じる");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "全部開いて、横にはみ出す");
  await page.click("#fold-all");
  assert.equal(await page.evaluate(() => [...document.querySelectorAll("details.fold")].some((d) => d.open)), false);
  await ctx.close();
});

await check("管理画面: 「カレンダー」の列は、Google連携 済・Google連携 未・アプリ内・—(まだ。設定の行が無い人も)。概要は Google連携 / アプリ内カレンダー / 30日以内(登録+保存の合算)に分け、新規登録のカードは無い。列の見出しは「最終登録・保存」。並べ替えは Google連携 済 → 未 → アプリ内 → —。社員番号・氏名・日時は折り返さない", async () => {
  const u = (no, name, extra) => ({ user_id: "id" + no, employee_no: no, family_name: name, given_name: "太郎", plan: "free", created_at: "2026-10-01T00:00:00Z", last_sign_in_at: null, office: "A区所", verified: false, google_sync: true, last_registered_at: null, record_days: 0, ...extra });
  const stats = { users: 5, verified: 1, google_users: 2, save_only: 1, users_list: [u("1000001", "未接続", {}), u("1000002", "保存だけ", { google_sync: false }), u("1000003", "接続済", { verified: true }), u("1000004", "区所なし", { google_sync: false, office: null }), u("1000005", "設定なし", { google_sync: null, office: null })] };
  const { page, ctx, errors } = await open("admin.html#users", { userId: "a1", opts: { profile: ADMIN, stats }, viewport: { width: 1200, height: 900 } });
  await page.waitForSelector("#users tr");
  const rows = async () => (await page.locator("#users tr").evaluateAll((trs) => trs.map((tr) => [tr.children[1].textContent, tr.children[3].textContent])));
  const byName = Object.fromEntries(await rows());
  assert.equal(byName["未接続 太郎"], "Google連携 未");
  assert.equal(byName["保存だけ 太郎"], "アプリ内");
  assert.equal(byName["設定なし 太郎"], "—", "設定の行が無い人(google_sync が null)は、Google連携 未ではなく —");
  assert.equal(byName["接続済 太郎"], "Google連携 済");
  assert.equal(byName["区所なし 太郎"], "—", "区所を選んでいない人は、アプリ内ではなく —");
  // 全列が左右中央揃え。見出しの文字と中身の文字の中心が、同じ列の中でそろっている(並べ替えの見出しだけ右にずれていた)
  const aligns = await page.evaluate(() => [...document.querySelectorAll("#users-head th, #users tr:first-child td")].map((c) => getComputedStyle(c).textAlign));
  assert.ok(aligns.every((a) => a === "center"), "利用者一覧が中央揃えでない: " + aligns);
  const centers = await page.evaluate(() => {
    const mid = (el) => { const r = document.createRange(); r.selectNodeContents(el); const b = r.getBoundingClientRect(); return b.left + b.width / 2; };
    const heads = [...document.querySelectorAll("#users-head th")];
    const cells = [...document.querySelectorAll("#users tr:first-child td")];
    return heads.map((h, i) => (h.querySelector(".sort-btn") ? Math.abs(mid(h.querySelector(".sort-btn")) - mid(cells[i])) : 0));
  });
  assert.ok(centers.every((d) => d < 6), "見出しと中身の中心がずれている: " + centers);
  // 狭い画面でも、社員番号・氏名・日時は折り返さない(表は横にスクロールする)
  const wraps = await page.evaluate(() => [...document.querySelectorAll("#users tr:first-child td:not(:last-child)")].map((c) => getComputedStyle(c).whiteSpace));
  assert.ok(wraps.every((w) => w === "nowrap"), "折り返す列がある: " + wraps);
  // ▼ を付けても、見出しの文字の位置が動かない
  // (狭い画面では、押すと表が横にスクロールするので、見出しのセルの左端からの距離で測る)
  const textX = () => page.evaluate(() => { const b = document.querySelector('[data-sort="record_days"]'); const r = document.createRange(); r.selectNodeContents(b); return r.getBoundingClientRect().left - b.closest("th").getBoundingClientRect().left; });
  const xBefore = await textX();
  await page.click('[data-sort="record_days"]');
  const xAfter = await textX();
  assert.ok(Math.abs(xBefore - xAfter) < 1, "▼ で見出しが動く: " + xBefore + " → " + xAfter);
  assert.equal(await page.textContent("#kpi-google"), "2");
  assert.equal(await page.textContent("#kpi-google-sub"), "接続テスト済み 1人(50%)");
  assert.equal(await page.textContent("#kpi-app"), "1");
  assert.equal(await page.locator("#kpi-new").count(), 0, "直近7日の新規登録のカードが残っている");
  assert.equal(await page.textContent('[data-sort="last_registered_at"]'), "最終登録・保存");
  await page.click('[data-sort="verified"]');
  assert.deepEqual((await rows()).map((r) => r[1]).slice(0, 4), ["Google連携 済", "Google連携 未", "アプリ内", "—"]);
  assert.deepEqual(errors, []);
  await ctx.close();
});

// ---------- 交番表 ----------
// 休みの並び(⚙ で覚える)。一覧の休日は 特休・公休・特公 の順。泊は「1」
const K_MASTER = [
  { code: "1", kind: "泊", weekday_start: "10:00", weekday_end: "9:00", holiday_start: "10:00", holiday_end: "9:00", stay: "京都", sort_order: 1 },
  { code: "25", kind: "日勤", weekday_start: "9:00", weekday_end: "17:45", holiday_start: "9:00", holiday_end: "17:45", stay: "", sort_order: 2 },
  { code: "特休", kind: "休日", weekday_start: "", weekday_end: "", holiday_start: "", holiday_end: "", stay: "", sort_order: 3 },
  { code: "公休", kind: "休日", weekday_start: "", weekday_end: "", holiday_start: "", holiday_end: "", stay: "", sort_order: 4 },
  { code: "特公", kind: "休日", weekday_start: "", weekday_end: "", holiday_start: "", holiday_end: "", stay: "", sort_order: 5 },
];
const kDay = (d) => `${thisMonth.y}-${String(thisMonth.m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const codeTexts = (page) => page.$$eval("#list tr td.code", (tds) => tds.map((td) => td.textContent.trim()));
const kOpen = (opts, asked) => open("input.html", {
  userId: "u1",
  opts: { profile: USER, master: K_MASTER, ...opts },
  beforeLoad: async (p) => { p.removeAllListeners("dialog"); p.on("dialog", (d) => { asked.push(d.message()); d.accept(); }); },
});
const kSaved = (be) => be.st.calls.filter((c) => c.path === "/rest/v1/user_settings" && c.method === "PATCH").pop().body.kouban;

await check("交番表: 並びが無ければ ⚙ が開く。タップで なし→特休→公休→なし と切り替わり(特公は出ない)、保存する", async () => {
  const asked = [];
  const { page, ctx, be, errors } = await kOpen({}, asked);
  await page.waitForSelector("#register:not([disabled])");
  assert.equal(await page.isVisible("#kouban"), true); // どの区所にも出る
  await page.click("#kouban");
  await page.waitForSelector("#kouban-settings-dialog[open]");
  assert.equal(await page.textContent(".kouban-month-note"), "※本番の月で入力してください。");
  assert.equal(await page.locator("#kouban-start").count(), 0); // 始まりの日の欄は無い(表示している月の1日から)
  assert.equal(await page.inputValue("#kouban-cycle"), "30");
  assert.equal(await page.textContent("#kouban-order"), "タップするたびに: なし → 特休 → 公休 → なし");
  assert.equal(await page.locator("#kouban-cal button").count(), 30);
  const day = (i) => page.locator("#kouban-cal button").nth(i);
  await day(2).click();
  assert.equal(await day(2).locator(".c").textContent(), "特休");
  await day(3).click();
  await day(3).click();
  assert.equal(await day(3).locator(".c").textContent(), "公休");
  await day(14).click();
  assert.equal(await day(14).locator(".c").textContent(), "特休");
  for (let n = 0; n < 3; n++) await day(20).click(); // 3回で なし に戻る
  assert.equal(await day(20).locator(".c").textContent(), "");
  // 入力する月を次の月にすると、カレンダーはその月の1日から。戻すと元のまま(タップした日付は変わらない)
  assert.equal(await page.inputValue("#kouban-month"), kDay(1).slice(0, 7));
  const next = thisMonth.m === 12 ? `${thisMonth.y + 1}-01` : `${thisMonth.y}-${String(thisMonth.m + 1).padStart(2, "0")}`;
  await page.fill("#kouban-month", next);
  await page.dispatchEvent("#kouban-month", "change");
  assert.ok((await day(0).textContent()).startsWith(Number(next.slice(5)) + "/1"));
  await page.fill("#kouban-month", kDay(1).slice(0, 7));
  await page.dispatchEvent("#kouban-month", "change");
  assert.equal(await day(2).locator(".c").textContent(), "特休");
  // 予備の月のボタンは「何もしない」のときだけ出る(2・5・8・11)
  assert.equal(await page.isVisible("#kouban-months"), false);
  await page.check("#kouban-spare-none");
  assert.equal(await page.isVisible("#kouban-months"), true);
  for (const m of [2, 5, 8, 11]) await page.click(`#kouban-months button:text-is("${m}月")`);
  assert.equal(await page.locator('#kouban-months button[aria-pressed="true"]').count(), 4);
  await page.screenshot({ path: OUT + "kouban-settings.png", fullPage: true });
  await page.click("#kouban-settings-save");
  await page.waitForFunction(() => document.getElementById("status").textContent.includes("設定を保存"));
  assert.deepEqual(kSaved(be), { start: kDay(1), cycle: 30, days: { 2: "特休", 3: "公休", 14: "特休" }, spareMonths: [2, 5, 8, 11], spareOff: false });
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("交番表: 休みの日だけ上書きし、ほかの日はそのまま。非番の日には入れない", async () => {
  const asked = [];
  // 3日が泊(4日は非番)、6日に25、5日に手入力のメモ。並びの休みは 4日・5日・6日・10日
  const records = [{ date: kDay(3), code: "1", memo: "" }, { date: kDay(6), code: "25", memo: "" }, { date: kDay(7), code: "25", memo: "残す" }];
  const kouban = { start: kDay(1), cycle: 30, days: { 3: "特休", 4: "公休", 5: "特公", 9: "公休" }, spareMonths: [], spareOff: true };
  const { page, ctx, errors } = await kOpen({ records, settings: { kouban } }, asked);
  await page.waitForSelector("#register:not([disabled])");
  await page.click("#kouban");
  await page.waitForFunction(() => document.getElementById("status").textContent.includes("交番:"));
  assert.ok(asked[0].includes("交番で設定した休みを3日分入れます。") && asked[0].includes("今の番号を休みに変える日: 6日") && asked[0].includes("非番なので入れない日: 4日"), asked[0]);
  assert.ok(!/[()(]/.test(asked[0]), "確認に括弧がある: " + asked[0]);
  const codes = await codeTexts(page);
  assert.equal(codes[2], "1");
  assert.equal(codes[3], "非番");
  assert.equal(codes[4], "公休");
  assert.equal(codes[5], "特公");
  assert.equal(codes[6], "25"); // 休みでない日はそのまま
  assert.equal(codes[9], "公休");
  assert.equal(await page.locator("td.memo input").nth(6).inputValue(), "残す");
  assert.ok((await page.textContent("#status")).includes("4日は非番"));
  assert.equal(await page.locator("#list tr.imported").count(), 3);
  assert.equal(await page.isDisabled("#save"), false);
  await page.screenshot({ path: OUT + "kouban-filled.png" });
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("交番表: 予備の月で「何もしない」なら入れない。⚙ は表示している月の1日から出し、覚えた日付は変わらない", async () => {
  const asked = [];
  // 2日に特休(2日から始まる並びで覚えていた)
  const kouban = { start: kDay(2), cycle: 30, days: { 0: "特休" }, spareMonths: [thisMonth.m], spareOff: false };
  const { page, ctx, be, errors } = await kOpen({ settings: { kouban } }, asked);
  await page.waitForSelector("#register:not([disabled])");
  assert.equal(await page.textContent("#kouban"), "交番");
  await page.click("#kouban");
  await page.waitForFunction(() => document.getElementById("status").textContent.includes("予備の月"));
  assert.equal(asked.length, 0);
  assert.equal((await codeTexts(page))[1], "");
  await page.click("#kouban-settings");
  await page.waitForSelector("#kouban-settings-dialog[open]");
  assert.equal(await page.isChecked("#kouban-spare-none"), true);
  assert.equal(await page.isVisible("#kouban-months"), true);
  // 1日から出す。2日(2つ目)が特休
  assert.ok((await page.locator("#kouban-cal button").nth(0).textContent()).startsWith(thisMonth.m + "/1"));
  assert.equal(await page.locator("#kouban-cal button").nth(1).locator(".c").textContent(), "特休");
  // 一周を7日にしても、外に出る休みは無い。確かめは出ない
  await page.fill("#kouban-cycle", "7");
  await page.dispatchEvent("#kouban-cycle", "change");
  assert.equal(await page.locator("#kouban-cal button").count(), 7);
  await page.check("#kouban-spare-on");
  assert.equal(await page.isVisible("#kouban-months"), false);
  await page.click("#kouban-settings-save");
  await page.waitForFunction(() => document.getElementById("status").textContent.includes("設定を保存"));
  // 「休みを入れる」なら予備の月は覚えない
  assert.deepEqual(kSaved(be), { start: kDay(1), cycle: 7, days: { 1: "特休" }, spareMonths: [], spareOff: true });
  assert.equal(asked.length, 0);
  // 予備の月でも休みを入れる → 2日・9日・16日…
  await page.click("#kouban");
  await page.waitForFunction(() => document.getElementById("status").textContent.includes("交番:"));
  assert.ok(asked[0].includes("交番で設定した休みを") && !asked[0].includes("予備"), asked[0]);
  const codes = await codeTexts(page);
  assert.equal(codes[1], "特休");
  assert.equal(codes[8], "特休");
  assert.equal(codes[2], "");
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("交番表: 一周を短くして休みが外に出るときは確かめる(やめると元のまま)", async () => {
  const asked = [];
  const kouban = { start: kDay(1), cycle: 30, days: { 2: "特休", 20: "公休" }, spareMonths: [], spareOff: true };
  const { page, ctx, errors } = await open("input.html", {
    userId: "u1",
    opts: { profile: USER, master: K_MASTER, settings: { kouban } },
    beforeLoad: async (p) => { p.removeAllListeners("dialog"); p.on("dialog", (d) => { asked.push(d.message()); d.dismiss(); }); },
  });
  await page.waitForSelector("#register:not([disabled])");
  await page.click("#kouban-settings");
  await page.waitForSelector("#kouban-settings-dialog[open]");
  await page.fill("#kouban-cycle", "14");
  await page.dispatchEvent("#kouban-cycle", "change");
  assert.ok(asked[0].includes("1日分") && asked[0].includes("消えます"), asked[0]);
  assert.equal(await page.inputValue("#kouban-cycle"), "30");
  assert.equal(await page.locator("#kouban-cal button").count(), 30);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("交番表: 幅320pxでもボタンが画面に収まる", async () => {
  const { page, ctx, errors } = await open("input.html", { userId: "u1", viewport: { width: 320, height: 640 }, opts: { profile: USER, master: K_MASTER } });
  await page.waitForSelector("#register:not([disabled])");
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(over <= 0, "横にはみ出す: " + over);
  await page.click("#kouban-settings");
  await page.waitForSelector("#kouban-settings-dialog[open]");
  const box = await page.locator("#kouban-settings-dialog").boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 320, JSON.stringify(box));
  await page.screenshot({ path: OUT + "kouban-320.png" });
  assert.deepEqual(errors, []);
  await ctx.close();
});

await browser.close();
server.kill();
console.log(failures.length ? `\n${failures.length} NG` : "\nall ok");
process.exit(failures.length ? 1 : 0);
