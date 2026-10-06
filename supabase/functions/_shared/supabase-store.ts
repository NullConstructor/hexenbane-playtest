// The database side of the Edge Function, on supabase-js with the service role.

import type { SupabaseClient } from "@supabase/supabase-js";
import { type ApplicationStore, consoleLogger } from "./handler.ts";

const ACTIVE_DISCORD_CONSTRAINT = "playtest_applications_active_discord_username_key";
const PUBLIC_ID_CONSTRAINT = "playtest_applications_public_application_id_key";

export function createSupabaseStore(db: SupabaseClient): ApplicationStore {
  return {
    async ensureAgreementVersion(version, sha256, body) {
      const { error: insertError } = await db
        .from("playtest_agreement_versions")
        .upsert({ version, sha256, body }, { onConflict: "version", ignoreDuplicates: true });
      if (insertError) throw new Error(`recording agreement version: ${insertError.message}`);

      const { data, error } = await db.from("playtest_agreement_versions").select("sha256").eq("version", version)
        .single();
      if (error) throw new Error(`reading agreement version: ${error.message}`);
      if (data.sha256 !== sha256) {
        throw new Error(
          `${version} is already recorded with a different hash (${data.sha256}). Published agreements are permanent: release the change as a new version.`,
        );
      }
    },

    async insertApplication(row) {
      const { error } = await db.from("playtest_applications").insert(row);
      if (!error) return "ok";
      if (error.code === "23505") {
        const text = `${error.message} ${error.details ?? ""}`;
        if (text.includes(ACTIVE_DISCORD_CONSTRAINT)) return "duplicate_discord";
        if (text.includes(PUBLIC_ID_CONSTRAINT)) return "duplicate_public_id";
      }
      throw new Error(`insert failed: ${error.code ?? "?"} ${error.message}`);
    },

    async markDiscordNotified(publicApplicationId, at) {
      const { error } = await db
        .from("playtest_applications")
        .update({ discord_notified_at: at })
        .eq("public_application_id", publicApplicationId);
      if (error) {
        consoleLogger.error("could not record discord_notified_at", {
          applicationId: publicApplicationId,
          error: error.message,
        });
      }
    },
  };
}
