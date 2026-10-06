// お問い合わせの Edge Function が使う本物の部品(DB・Discord・メールの中継)をまとめて作る

import { adminClient } from "./auth.ts";
import type { Deps } from "./contact-core.ts";
import { supabaseRepo } from "./contact-repo.ts";
import { discordFromEnv } from "./discord.ts";
import { relayFromEnv } from "./mail-relay.ts";

export function contactDeps(): Deps {
  return {
    repo: supabaseRepo(adminClient()),
    discord: discordFromEnv(),
    relay: relayFromEnv(),
    background: (p) => {
      const runtime = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
      const safe = p.catch((err) => console.error("background task failed", err instanceof Error ? err.message : err));
      if (runtime?.waitUntil) runtime.waitUntil(safe);
    },
  };
}
