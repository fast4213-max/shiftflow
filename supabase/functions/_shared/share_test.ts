import { assertEquals } from "jsr:@std/assert@1";
import { mateView, sharedOwners, timeOnlyMemo } from "./share.ts";
import type { ViewEvent } from "./shift-view.ts";

const A = "a0000000-0000-4000-8000-000000000001";
const B = "b0000000-0000-4000-8000-000000000002";
const C = "c0000000-0000-4000-8000-000000000003";

Deno.test("sharedOwners: 相手が自分に見せる範囲を使う(自分が見せる範囲ではない)", () => {
  const links = [{ user_a: A, user_b: B, scope_a: "none", scope_b: "duty_off" }];
  assertEquals(sharedOwners(A, links), [{ ownerId: B, scope: "duty_off", couple: false }]);
  assertEquals(sharedOwners(B, links), []); // A は B に見せていない
});

Deno.test("sharedOwners: 自分に関係しない行・決めていない範囲は入れない", () => {
  const links = [
    { user_a: B, user_b: C, scope_a: "duty", scope_b: "duty" },
    { user_a: A, user_b: C, scope_a: "duty", scope_b: "all" },
  ];
  assertEquals(sharedOwners(A, links), []);
});

const ev = (group: ViewEvent["group"], title: string): ViewEvent => ({
  group, date: "2026-11-12", endDate: "2026-11-12", allDay: true, startTime: "", endTime: "", calendar: group === "off" ? "holiday" : "work",
  kind: "day", title, description: "",
});

Deno.test("mateView: 勤務だけの人の休日は返さない。非番は勤務に入れる", () => {
  const all = [ev("duty", "1"), ev("off", "公"), ev("offduty", "9:00")];
  assertEquals(mateView(all, "duty").map((e) => [e.group, e.title]), [["duty", "1"], ["duty", "9:00"]]);
  assertEquals(mateView(all, "duty_off").map((e) => [e.group, e.title]), [["duty", "1"], ["off", "公"], ["duty", "9:00"]]);
  assertEquals(mateView(all, "none"), []);
});

Deno.test("sharedOwners・mateView: 夫婦は非番を非番のまま返す(仲間は勤務に入れる)", () => {
  const links = [{ user_a: A, user_b: B, scope_a: "duty", scope_b: "duty", kind: "couple" }];
  assertEquals(sharedOwners(A, links), [{ ownerId: B, scope: "duty", couple: true }]);
  const all = [ev("duty", "1"), ev("off", "公"), ev("offduty", "9:00")];
  assertEquals(mateView(all, "duty", true).map((e) => [e.group, e.title]), [["duty", "1"], ["offduty", "9:00"]]);
});

Deno.test("timeOnlyMemo: 相手に見せるメモは先頭の時間だけ(手で書いた言葉は落とす)", () => {
  assertEquals(timeOnlyMemo("10:15〜19:02"), "10:15〜19:02");
  assertEquals(timeOnlyMemo("10:00 早出"), "10:00");
  assertEquals(timeOnlyMemo("１０：００～１８：３０　通院のため"), "１０：００～１８：３０");
  assertEquals(timeOnlyMemo("〜9:02 眠い"), "〜9:02");
  assertEquals(timeOnlyMemo("9:02"), "9:02");
  assertEquals(timeOnlyMemo("8:30-9:02\n2行目の言葉"), "8:30-9:02");
  assertEquals(timeOnlyMemo("10:00から"), "10:00から");
  assertEquals(timeOnlyMemo("旅行"), "");
  assertEquals(timeOnlyMemo("早出 10:00"), "");
  assertEquals(timeOnlyMemo(""), "");
  assertEquals(timeOnlyMemo(null), "");
});
