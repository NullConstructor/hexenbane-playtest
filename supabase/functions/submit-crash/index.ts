// Supabase Edge Function: submit-crash
//
// POST JSON crash / script-error reports from the Hexenbane game → validate → insert into
// public.crash_reports → the first report of each crash signature (per version) becomes a post
// in the #bug-reports forum → { ok: true, id, posted }.
// Contract: supabase/functions/_shared/crash.ts.
//
// Secrets (Supabase Dashboard → Edge Functions → Secrets, or `supabase secrets set`):
//   DISCORD_BUG_REPORTS_WEBHOOK_URL  #bug-reports forum webhook; without it reports are only stored
//   DISCORD_BUG_REPORTS_TAGS         optional JSON {"New":"<tag id>","Crash":"<tag id>",...}
//   RATE_LIMIT_IP_SALT               random string; turns on the per-IP rate limit
// Provided by Supabase automatically: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from "@supabase/supabase-js";
import { createCrashHandler } from "../_shared/crash.ts";
import { parseForumTags, sendDiscordForumPost } from "../_shared/discord-forum.ts";
import { createCrashStore, createRateLimiter } from "../_shared/game-store.ts";

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
  createCrashHandler({
    store: createCrashStore(db),
    limiter: createRateLimiter(db),
    ipSalt: Deno.env.get("RATE_LIMIT_IP_SALT"),
    notify: webhookUrl ? (payload, files) => sendDiscordForumPost(webhookUrl, payload, files) : null,
    tags: parseForumTags(Deno.env.get("DISCORD_BUG_REPORTS_TAGS")),
  }),
);
