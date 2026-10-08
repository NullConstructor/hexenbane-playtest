// Supabase Edge Function: ingest-telemetry
//
// POST JSON batches of gameplay events from the Hexenbane game → validate → insert into
// public.telemetry_events (duplicates skipped) → { ok: true, accepted, duplicates }.
// Contract: supabase/functions/_shared/telemetry.ts. No IP address is stored.
//
// Secrets (Supabase Dashboard → Edge Functions → Secrets, or `supabase secrets set`):
//   RATE_LIMIT_IP_SALT   random string; turns on the per-IP rate limit (IPs are only kept hashed)
// Provided by Supabase automatically: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from "@supabase/supabase-js";
import { createRateLimiter, createTelemetryStore } from "../_shared/game-store.ts";
import { createTelemetryHandler } from "../_shared/telemetry.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be available to the function.");
}

// The service role bypasses row level security. It exists only inside this function.
const db = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

Deno.serve(
  createTelemetryHandler({
    store: createTelemetryStore(db),
    limiter: createRateLimiter(db),
    ipSalt: Deno.env.get("RATE_LIMIT_IP_SALT"),
  }),
);
