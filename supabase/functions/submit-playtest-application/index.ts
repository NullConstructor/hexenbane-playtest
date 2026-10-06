// Supabase Edge Function: submit-playtest-application
//
// POST JSON from the Hexenbane playtest website → validate → store in
// public.playtest_applications → notify #playtest-applications → { success, applicationId }.
//
// Secrets (Supabase Dashboard → Edge Functions → Secrets, or `supabase secrets set`):
//   DISCORD_WEBHOOK_URL   required for notifications; never put it in the website
//   ALLOWED_ORIGINS       comma-separated browser origins, e.g. https://nullconstructor.github.io
//   TURNSTILE_SECRET_KEY  optional; turns on the Cloudflare Turnstile check
// Provided by Supabase automatically: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from "@supabase/supabase-js";
import { captchaFromEnv } from "../_shared/captcha.ts";
import { parseAllowedOrigins } from "../_shared/cors.ts";
import { sendDiscordWebhook } from "../_shared/discord.ts";
import { createHandler } from "../_shared/handler.ts";
import { createSupabaseStore } from "../_shared/supabase-store.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be available to the function.");
}

// The service role bypasses row level security. It exists only inside this function;
// the website never sees it.
const db = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

const store = createSupabaseStore(db);

const webhookUrl = Deno.env.get("DISCORD_WEBHOOK_URL");

Deno.serve(
  createHandler({
    store,
    notify: (payload) => sendDiscordWebhook(webhookUrl, payload),
    allowedOrigins: parseAllowedOrigins(Deno.env.get("ALLOWED_ORIGINS")),
    captcha: captchaFromEnv(Deno.env),
  }),
);
