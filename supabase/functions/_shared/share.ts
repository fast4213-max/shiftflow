// カレンダーの共有(docs/share/DESIGN.md): 誰の勤務を、どの範囲で見せてもらえるか。
// cal_share_links は1組1行(user_a < user_b)。scope_a は a が b に見せる範囲

import type { ViewEvent } from "./shift-view.ts";

export type Scope = "none" | "duty" | "duty_off";
export type ShareLink = { user_a: string; user_b: string; scope_a: string; scope_b: string; kind?: string };
export type Owner = { ownerId: string; scope: Exclude<Scope, "none">; couple: boolean };

// 自分(me)に勤務を見せてくれている人と、その範囲(「見せない」の人は入れない)
export function sharedOwners(me: string, links: ShareLink[]): Owner[] {
  const out: Owner[] = [];
  for (const l of links) {
    let owner = "", scope = "";
    if (l.user_a === me) [owner, scope] = [l.user_b, l.scope_b];
    else if (l.user_b === me) [owner, scope] = [l.user_a, l.scope_a];
    else continue; // 自分に関係しない行(来ないはずだが、念のため)
    if (scope === "duty" || scope === "duty_off") out.push({ ownerId: owner, scope, couple: l.kind === "couple" });
  }
  return out;
}

// 相手の勤務の予定を、見せてもらえる範囲に絞る。仲間の名前のラベルは「勤務」と「休日」の2つなので、非番(offduty)は勤務に入れる。
// 夫婦は、カレンダーに相手の非番のラベル(「花子・非」)もあるので、非番のまま返す(keepOffduty)
export function mateView(events: ViewEvent[], scope: Scope, keepOffduty = false): ViewEvent[] {
  if (scope === "none") return [];
  return events
    .filter((e) => scope === "duty_off" || e.group !== "off")
    .map((e) => ({ ...e, group: e.group === "off" ? "off" : keepOffduty && e.group === "offduty" ? "offduty" : "duty" }));
}
