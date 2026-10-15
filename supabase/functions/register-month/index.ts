// 指定月の入力を shift_records に保存し、カレンダーに登録する。
// このアプリが作った予定だけを消してから作り直す(手で入れた予定は消さない)。
// saveOnly: true のときは、保存と翌月1日・2日の記録の片付けまでを行い、カレンダーは変えない(勤務入力の「保存」。17回目の N1)。
// 保存も登録と同じ順番・同じ鍵で行うので、「保存してから登録」しても翌月1日の片付けが効き、保存とリセットも重ならない

import { requireMember } from "../_shared/auth.ts";
import { loadHolidays } from "../_shared/holidays.ts";
import { AppError, entriesFrom, readBody, serve, yearMonthOf } from "../_shared/http.ts";
import { addDays, buildPlan, codeOf, dateKey, daysInMonth } from "../_shared/plan.js";
import {
  addTimeToTitles,
  createEvents,
  deleteAppEvents,
  deleteRecords,
  eventsToRegister,
  listAppEvents,
  loadMasterSet,
  loadVerifiedCalendars,
  nextFirstNewlyOffduty,
  periodErrorText,
  shouldKeepTimedNextFirst,
  splitDayEvents,
  splitOffdutyEvents,
  staleNextMonthRecords,
  toTimedEvents,
  withUserLock,
} from "../_shared/shift-calendar.ts";

serve(async (req) => {
  const ctx = await requireMember(req);
  const body = await readBody(req);
  const { year, month } = yearMonthOf(body);
  const entries = entriesFrom(body);
  const saveOnly = body.saveOnly === true;

  const calendars = await loadVerifiedCalendars(ctx);
  if (!calendars.officeId) throw new AppError(400, "設定画面で区所を選んでください。", "no_office");

  return await withUserLock(ctx, async () => {
    const first = dateKey(year, month, 1);
    const last = dateKey(year, month, daysInMonth(year, month));
    const prevLast = addDays(first, -1);
    const nextFirst = addDays(last, 1);

    // 月末(last)は、登録する前の番号を見るために読む(翌月1日の非番が変わるかどうか)
    // 祝日は前月末〜翌月2日を読む(泊の日と翌日の平休で、出勤・退勤の列を選ぶため。翌月1日の泊の出勤は翌月2日を見る)
    // マスタは切替日(ダイヤ改正・ダイヤ修正)ごとに読み、日ごとにその日のマスタを使う
    const [master, recordsRes, holidays] = await Promise.all([
      loadMasterSet(ctx, calendars.officeId as number),
      ctx.db.from("shift_records").select("date, code, memo").in("date", [prevLast, last, nextFirst]),
      loadHolidays(ctx.admin, prevLast, addDays(nextFirst, 1)),
    ]);
    if (recordsRes.error) throw recordsRes.error;
    const byDate = Object.fromEntries((recordsRes.data || []).map((r) => [r.date, r]));

    const planOf = (nextFirstEntry: { code: string; memo: string } | undefined) =>
      buildPlan({ year, month, entries, prevLastCode: codeOf(byDate[prevLast]), nextFirstEntry, master, holidays });
    let plan = planOf(byDate[nextFirst]);
    const nextFirstOffduty = plan.events.some((e) => e.date === nextFirst && e.kind === "offduty");
    // 月末が今回はじめて泊になったなら、翌月1日の番号の無いメモ(別の用事のメモ)を非番のメモに使わない(W6)。
    // 画面が、月の中で新しく非番になった日のメモを消すのと同じ。前から泊なら、手で書いた非番のメモなのでそのまま使う
    const newlyOffduty = nextFirstNewlyOffduty({ last, lastCode: codeOf(byDate[last]), nextFirstOffduty, master });
    if (newlyOffduty && byDate[nextFirst] && !codeOf(byDate[nextFirst])) {
      plan = planOf({ code: "", memo: "" });
    }
    // マスタの切替で登録できない日があれば、何も変えずに止める。確かめるのは最後に組み立てた予定
    // (翌月1日のメモを外して組み立て直すと、エラーになることがあるため)。
    // 「保存」は通す(新しいマスタを待つあいだも、写真取込などの入力を残せるように。カレンダーは変えない)
    const periodError = periodErrorText(plan.errors);
    if (periodError && !saveOnly) throw new AppError(400, periodError, "master_period");

    const saved = await ctx.db.rpc("save_month_records", { p_year: year, p_month: month, p_entries: plan.entries });
    if (saved.error) throw saved.error;

    // 月末の泊が変わって翌月1日の非番が変わったら、翌月1日・2日の記録の、前の状態のための番号やメモを消す。
    // 残しておくと、あとで月末を泊から戻したとき(泊を1日前へ入れ直したときなど)、消えたはずの番号が戻ってしまうため
    await deleteRecords(ctx, staleNextMonthRecords({
      nextFirst,
      lastCode: codeOf(byDate[last]),
      nextFirstOffduty,
      nextFirstCode: codeOf(byDate[nextFirst]),
      master,
      newlyOffduty,
    }));

    // 「保存」はここまで(カレンダーは変えない。登録したときに作り直す)。登録できない理由があれば添える
    if (saveOnly) return periodError ? { saved: true, periodError } : { saved: true };

    const existing = await listAppEvents(calendars, year, month);
    // 前の登録が途中で失敗して、翌月1日の予定を消したままになっていないか(印が今回の翌月1日なら、作り直す)
    const pendingRes = await ctx.admin.from("user_settings").select("next_first_pending").eq("user_id", ctx.userId).maybeSingle();
    if (pendingRes.error) throw pendingRes.error;
    const retryNextFirst = pendingRes.data?.next_first_pending === nextFirst;
    // 時間つきの設定で、翌月1日に時間つきのアプリの予定が(翌月の登録で)すでにあるときは、翌月1日を作り直さない(R1)
    const keepNextFirst = shouldKeepTimedNextFirst({
      timedEvents: !!calendars.timedEvents,
      nextFirstOffduty,
      existing,
      nextFirst,
    });
    const registered = eventsToRegister(plan.events, existing, nextFirst, retryNextFirst)
      .filter((e) => !keepNextFirst || e.date !== nextFirst);
    // 勤務を時間つきの予定で登録する設定の人は、泊を出勤から翌日の退勤までの1件に、日勤を出勤から退勤までにする
    // (「2件で登録」「名前に時間」は使わない)
    let events;
    if (calendars.timedEvents) {
      // 1日の「〜」は、前の月の月末から続く時間つきの泊の1件がカレンダーにあるときだけ作らない(Z1)
      const prevStayTimed = existing.some((e) => e.carried);
      events = toTimedEvents(registered, master, { first, nextFirst, prevStayTimed });
    } else {
      // 出勤を終日2件(番号・時間)に分ける設定の人は、次回の登録から時間の予定も作る。
      // 非番を2件(「〜」・退勤時間)に分ける設定の人も同じ(時間の予定は非番の時間用カレンダーへ)
      const daySplit = calendars.splitDayEvents ? splitDayEvents(registered, master) : registered;
      const split = calendars.splitOffdutyEvents ? splitOffdutyEvents(daySplit, master) : daySplit;
      // タイトルに時間を付ける設定の人は、番号のあとに出勤時間・「〜」のあとに退勤時間を付ける(例「1(10:00)」「〜(9:00)」)。
      // 番号でマスタを引くので、2件に分けたあとに通す
      events = addTimeToTitles(split, master, { day: calendars.titleDayTime, offduty: calendars.titleOffdutyTime });
    }
    // 翌月1日の予定(月末が泊なら非番、泊でなければ翌月1日の記録の予定)を作るときは、
    // 翌月1日にあるアプリの予定を全部消してから作り直す(重ならないように)。
    // 月末が泊なら、時間つきの設定で翌月1日の非番を作らない(泊の1件が翌月1日の朝まで入る)ときも同じ。
    // 翌月1日が非番なら翌月2日は非番にならないので、翌月2日に残った非番(翌月1日が泊だったとき)も消す
    const clearNextFirst = nextFirstOffduty || events.some((e) => e.date === nextFirst);
    // 翌月1日のアプリの予定を消す前に印を残す(消したあとで作り直しに失敗しても、やり直したときに作り直せる)
    if (existing.some((e) => e.date === nextFirst)) {
      const marked = await ctx.admin.from("user_settings").update({ next_first_pending: nextFirst }).eq("user_id", ctx.userId);
      if (marked.error) throw marked.error;
    }
    await deleteAppEvents(calendars, year, month, { clearNextFirst, clearNextSecondOffduty: nextFirstOffduty, existing });
    const { created, skipped } = await createEvents(calendars, events);

    await ctx.admin.from("user_settings").update({ last_registered_at: new Date().toISOString() }).eq("user_id", ctx.userId);
    // 最後まで登録できたので、今回の翌月1日の印は消す(Q8)。翌月1日に作る予定が無いとき(月末を泊から戻した)も消す。
    // 別の月の印(ほかの月の登録が途中で止まったもの)は、その月をやり直すときに使うので消さない
    await ctx.admin.from("user_settings").update({ next_first_pending: null })
      .eq("user_id", ctx.userId).eq("next_first_pending", nextFirst);

    // skipped: 休日用のカレンダーを設定していない人の「休日」の予定(登録していない)
    return { count: created, skipped };
  });
});
