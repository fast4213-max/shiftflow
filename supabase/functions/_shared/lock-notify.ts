// PIN の長いロック(AD1)がかかったら、Discord に知らせる。
// 送った通知は discord_posts に残し、お問い合わせの通知と同じく90日で消す(社員番号が入るため)

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.117.2";
import type { LockNotifier } from "./attempts.ts";
import { type Discord, discordFromEnv } from "./discord.ts";

// 日本時間の「10/16 9:30」
function jstText(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 9 * 3600_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

export function pinLockPayload(employeeNo: string, until: string) {
  return {
    embeds: [{
      title: "🔒 PIN の間違いが多いため、ロックしました",
      description: "同じ社員番号で、PIN の間違いが続きました。本人が忘れたのでなければ、ほかの人が試している可能性があります。\n" +
        "本人から連絡があれば、管理画面の「利用者」で PIN を再設定すると、すぐ使えるようになります。",
      color: 0xe53935,
      fields: [
        { name: "社員番号", value: employeeNo, inline: true },
        { name: "解除", value: `${jstText(until)} ごろ(日本時間)`, inline: true },
      ],
    }],
    allowed_mentions: { parse: [] as string[] },
  };
}

export function pinLockNotifier(admin: SupabaseClient, discord: Discord = discordFromEnv()): LockNotifier {
  return async (employeeNo, until) => {
    if (!discord.configured) return;
    const res = await discord.post(pinLockPayload(employeeNo, until));
    if (!res.ok) {
      console.error("pin lock notify failed", res.status);
      return;
    }
    const { error } = await admin.from("discord_posts").upsert({ message_id: res.id, inquiry_id: null });
    if (error) console.error("discord_posts insert failed", error.message);
  };
}
