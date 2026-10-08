// The database side of the game's endpoints, on supabase-js with the service role.
// Tables, views and functions are in supabase/migrations/20261008000000_game_telemetry.sql.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CrashStore, ReportInsertResult } from "./crash.ts";
import type { FeedbackStore } from "./feedback.ts";
import type { RateLimiter } from "./game-http.ts";
import type { TelemetryStore } from "./telemetry.ts";

export function createRateLimiter(db: SupabaseClient): RateLimiter {
  return {
    async hit(rule, key) {
      const { data, error } = await db.rpc("game_rate_limit_hit", {
        p_bucket: rule.bucket,
        p_subject: key,
        p_limit: rule.limit,
        p_window_seconds: rule.windowSeconds,
      });
      if (error) throw new Error(`rate limit: ${error.message}`);
      const row = (Array.isArray(data) ? data[0] : data) as { allowed: boolean; retry_after: number } | null;
      if (!row) throw new Error("rate limit: no answer");
      return { allowed: row.allowed, retryAfter: row.retry_after };
    },
  };
}

export function createTelemetryStore(db: SupabaseClient): TelemetryStore {
  return {
    async insertEvents(rows) {
      // ON CONFLICT (session_id, seq) DO NOTHING: a retried batch is not counted twice.
      // Only newly inserted rows come back.
      const { data, error } = await db
        .from("telemetry_events")
        .upsert(rows, { onConflict: "session_id,seq", ignoreDuplicates: true })
        .select("id");
      if (error) throw new Error(`telemetry insert failed: ${error.code ?? "?"} ${error.message}`);
      return data?.length ?? 0;
    },
  };
}

async function insertReport(
  db: SupabaseClient,
  table: string,
  row: Record<string, unknown>,
): Promise<ReportInsertResult> {
  const { error } = await db.from(table).insert(row);
  if (!error) return "ok";
  if (error.code === "23505" && `${error.message} ${error.details ?? ""}`.includes(`${table}_report_id_key`)) {
    return "duplicate_id";
  }
  throw new Error(`${table} insert failed: ${error.code ?? "?"} ${error.message}`);
}

export function createCrashStore(db: SupabaseClient): CrashStore {
  return {
    insertCrash: (row) => insertReport(db, "crash_reports", { ...row }),

    async recordSignature(signature, version, claim) {
      const { data, error } = await db.rpc("crash_signature_seen", {
        p_signature: signature,
        p_version: version,
        p_claim: claim,
      });
      if (error) throw new Error(`crash signature: ${error.message}`);
      const row = (Array.isArray(data) ? data[0] : data) as { seen: number; notify: boolean } | null;
      return { seen: row?.seen ?? 0, notify: row?.notify === true };
    },

    async markSignaturePosted(signature) {
      const { error } = await db
        .from("crash_signatures")
        .update({ discord_posted_at: new Date().toISOString() })
        .eq("signature", signature);
      if (error) throw new Error(`crash signature update: ${error.message}`);
    },
  };
}

export function createFeedbackStore(db: SupabaseClient): FeedbackStore {
  return {
    insertFeedback: (row) => insertReport(db, "feedback_reports", { ...row }),

    async markDiscordPosted(reportId, at) {
      const { error } = await db
        .from("feedback_reports")
        .update({ discord_ok: true, discord_posted_at: at })
        .eq("report_id", reportId);
      if (error) throw new Error(`feedback update: ${error.message}`);
    },
  };
}
