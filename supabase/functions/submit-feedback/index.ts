// Supabase Edge Function: submit-feedback
//
// POST JSON from the Hexenbane game's F8 report form → validate → insert into
// public.feedback_reports → post to the #bug-reports forum with the screenshot and log attached
// → { ok: true, id } when Discord accepted it, or 502 { ok: false, error: "discord_failed", id }.
// Contract: supabase/functions/_shared/feedback.ts. Screenshots and logs are not stored.
//
// Secrets (Supabase Dashboard → Edge Functions → Secrets, or `supabase secrets set`):
//   DISCORD_BUG_REPORTS_WEBHOOK_URL  #bug-reports forum webhook (required: without it every report answers 502)
//   DISCORD_BUG_REPORTS_TAGS         optional JSON {"New":"<tag id>","Crash":"<tag id>","UI":"…","Combat":"…"}
//   RATE_LIMIT_IP_SALT               random string; turns on the per-IP rate limit
// Provided by Supabase automatically: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from "@supabase/supabase-js";
import { parseForumTags, sendDiscordForumPost } from "../_shared/discord-forum.ts";
import { createFeedbackHandler } from "../_shared/feedback.ts";
import { createFeedbackStore, createRateLimiter } from "../_shared/game-store.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be available to the function.");
}

// The service role bypasses row level security. It exists only inside this function.
const db = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

const webhookUrl = Deno.env.get("DISCORD_BUG_REPORTS_WEBHOOK_URL");

Deno.serve(
  createFeedbackHandler({
    store: createFeedbackStore(db),
    limiter: createRateLimiter(db),
    ipSalt: Deno.env.get("RATE_LIMIT_IP_SALT"),
    notify: webhookUrl ? (payload, files) => sendDiscordForumPost(webhookUrl, payload, files) : null,
    tags: parseForumTags(Deno.env.get("DISCORD_BUG_REPORTS_TAGS")),
  }),
);
