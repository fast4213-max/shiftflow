// お問い合わせの DB の読み書き(service_role で動く。contact-core.ts の Repo の本物)

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.117.2";
import type { Inquiry, Message, NewMessage, Repo } from "./contact-core.ts";
import { sanitizeDbError } from "./db-error.ts";

// 既存の import(テスト)が contact-repo.ts から読めるように
export { sanitizeDbError };

function check<T>(res: { data: T; error: unknown }): T {
  if (res.error) throw sanitizeDbError(res.error);
  return res.data;
}

async function officeName(db: SupabaseClient, userId: string): Promise<string | null> {
  const settings = check(await db.from("user_settings").select("office_id").eq("user_id", userId).maybeSingle());
  if (!settings?.office_id) return null;
  const office = check(await db.from("offices").select("name").eq("id", settings.office_id).maybeSingle());
  return office?.name ?? null;
}

export function supabaseRepo(db: SupabaseClient): Repo {
  return {
    async rateHit(key, max, minutes) {
      return check(await db.rpc("rate_limit_hit", { p_key: key, p_max: max, p_minutes: minutes })) === true;
    },
    async memberInfo(userId) {
      const p = check(await db.from("profiles").select("role, employee_no, family_name, given_name").eq("user_id", userId).maybeSingle());
      if (!p) return null;
      return {
        role: p.role,
        employeeNo: p.employee_no,
        name: `${p.family_name} ${p.given_name}`.trim(),
        officeName: p.role === "admin" ? null : await officeName(db, userId),
      };
    },
    async createInquiry(row) {
      const data = check(await db.rpc("create_inquiry", { p: row })) as { id: number; duplicate: boolean };
      return { id: Number(data.id), duplicate: data.duplicate === true };
    },
    async getInquiry(id) {
      return check(await db.from("inquiries").select("*").eq("id", id).maybeSingle()) as Inquiry | null;
    },
    async updateInquiry(id, patch) {
      check(await db.from("inquiries").update(patch).eq("id", id));
    },
    async listInquiries(filter, limit) {
      let q = db.from("inquiries").select("*");
      if (filter === "todo") q = q.eq("status", "open");
      if (filter === "replied") q = q.eq("status", "replied");
      q = q.order("has_new_mail", { ascending: false }).order("last_activity_at", { ascending: false }).limit(limit);
      return check(await q) as Inquiry[];
    },
    async countTodo() {
      const res = await db.from("inquiries").select("id", { count: "exact", head: true }).eq("status", "open");
      if (res.error) throw sanitizeDbError(res.error);
      return res.count ?? 0;
    },
    async myInquiries(userId, limit) {
      return check(
        await db.from("inquiries").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(limit),
      ) as Inquiry[];
    },
    async messages(inquiryId) {
      return check(await db.from("inquiry_messages").select("*").eq("inquiry_id", inquiryId).order("id")) as Message[];
    },
    async insertMessage(row: NewMessage) {
      const res = await db.from("inquiry_messages").insert(row).select("*").single();
      if (res.error) {
        if ((res.error as { code?: string }).code === "23505") return null; // 同じ request_key / gmail_message_id
        throw sanitizeDbError(res.error);
      }
      return res.data as Message;
    },
    async getMessage(id) {
      if (!Number.isInteger(id) || id <= 0) return null;
      return check(await db.from("inquiry_messages").select("*").eq("id", id).maybeSingle()) as Message | null;
    },
    async messageByRequestKey(key) {
      return check(await db.from("inquiry_messages").select("*").eq("request_key", key).maybeSingle()) as Message | null;
    },
    async messageExists(gmailMessageId) {
      const row = check(await db.from("inquiry_messages").select("id").eq("gmail_message_id", gmailMessageId).maybeSingle());
      return !!row;
    },
    async updateMessage(id, patch) {
      check(await db.from("inquiry_messages").update(patch).eq("id", id));
    },
    async deleteMessage(id) {
      check(await db.from("inquiry_messages").delete().eq("id", id));
    },
    // こちら(管理者)がメールで返事を送ったスレッドだけを見る。件名の番号で入ってきた他人のメールのスレッドを、
    // 次から「スレッドで当てはまった」扱いにしない(Q3。送り主が違うときの注意が消えないように)
    async inquiryIdByThread(threadId) {
      const rows = check(
        await db.from("inquiry_messages").select("inquiry_id").eq("gmail_thread_id", threadId).eq("sender", "admin")
          .not("inquiry_id", "is", null).limit(1),
      ) as { inquiry_id: number }[];
      return rows[0]?.inquiry_id ?? null;
    },
    async unmatchedMails(limit) {
      return check(
        await db.from("inquiry_messages").select("*").is("inquiry_id", null).order("created_at", { ascending: false }).limit(limit),
      ) as Message[];
    },
    async countUnmatched() {
      const since = new Date(Date.now() - 7 * 86400_000).toISOString();
      const res = await db.from("inquiry_messages").select("id", { count: "exact", head: true })
        .is("inquiry_id", null).eq("sender", "mail").eq("bounce", false).gte("created_at", since);
      if (res.error) throw sanitizeDbError(res.error);
      return res.count ?? 0;
    },
    async profileByEmployeeNo(no) {
      const p = check(await db.from("profiles").select("user_id, family_name, given_name").eq("employee_no", no).maybeSingle());
      if (!p) return null;
      return { name: `${p.family_name} ${p.given_name}`.trim(), officeName: await officeName(db, p.user_id) };
    },
    async recordDiscordPost(messageId, inquiryId) {
      check(await db.from("discord_posts").upsert({ message_id: messageId, inquiry_id: inquiryId }));
    },
    async oldDiscordPosts(days, limit) {
      const before = new Date(Date.now() - days * 86400_000).toISOString();
      const rows = check(
        await db.from("discord_posts").select("message_id").lt("created_at", before).order("created_at").limit(limit),
      ) as { message_id: string }[];
      return rows.map((r) => r.message_id);
    },
    async deleteDiscordPost(messageId) {
      check(await db.from("discord_posts").delete().eq("message_id", messageId));
    },
    async setStatus(key, value) {
      check(await db.from("app_status").upsert({ key, value, updated_at: new Date().toISOString() }));
    },
    async statuses() {
      const rows = check(await db.from("app_status").select("key, value, updated_at")) as {
        key: string;
        value: Record<string, unknown>;
        updated_at: string;
      }[];
      return Object.fromEntries(rows.map((r) => [r.key, { value: r.value, updated_at: r.updated_at }]));
    },
    async purge() {
      return check(await db.rpc("purge_old_contact")) as Record<string, unknown>;
    },
  };
}
