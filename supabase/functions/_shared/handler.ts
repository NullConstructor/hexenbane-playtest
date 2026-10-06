// The submit-playtest-application request handler, independent of Supabase and Deno so it can
// be tested with fakes. index.ts wires it to the real database, Discord and Deno.serve.

import {
  type ApplicationInput,
  checkSpamSignals,
  MAX_BODY_BYTES,
  type SubmitResponse,
  validateApplication,
} from "./application.ts";
import { AGREEMENT_SHA256, AGREEMENT_TEXT, AGREEMENT_VERSION } from "./agreement.generated.ts";
import type { CaptchaVerifier } from "./captcha.ts";
import { corsHeaders, isOriginAllowed } from "./cors.ts";
import { buildApplicationEmbed, type DiscordWebhookPayload, type NotifyResult } from "./discord.ts";
import { generatePublicApplicationId } from "./ids.ts";

/** The row the Edge Function writes. Agreement fields always come from the server. */
export interface NewApplicationRow {
  public_application_id: string;
  preferred_name: string;
  discord_username: string;
  email: string | null;
  interest_reason: string;
  similar_games: string;
  testing_experience: string;
  cpu: string;
  gpu: string;
  ram: string;
  operating_system: string;
  additional_notes: string | null;
  joined_discord: true;
  agreement_accepted: true;
  agreement_version: string;
  agreement_hash: string;
  agreement_accepted_at: string;
}

export type InsertResult = "ok" | "duplicate_discord" | "duplicate_public_id";

export interface ApplicationStore {
  /** Records the agreement text for this version if new; throws if the version exists with other text. */
  ensureAgreementVersion(version: string, sha256: string, body: string): Promise<void>;
  insertApplication(row: NewApplicationRow): Promise<InsertResult>;
  markDiscordNotified(publicApplicationId: string, at: string): Promise<void>;
}

export interface Logger {
  info(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export interface HandlerDeps {
  store: ApplicationStore;
  notify(payload: DiscordWebhookPayload): Promise<NotifyResult>;
  allowedOrigins: readonly string[];
  captcha?: CaptchaVerifier | null;
  now?: () => Date;
  newPublicId?: () => string;
  log?: Logger;
}

export const consoleLogger: Logger = {
  info: (message, data) => console.log(JSON.stringify({ level: "info", message, ...data })),
  error: (message, data) => console.error(JSON.stringify({ level: "error", message, ...data })),
};

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function toRow(app: ApplicationInput, publicId: string, acceptedAt: string): NewApplicationRow {
  return {
    public_application_id: publicId,
    preferred_name: app.preferredName,
    discord_username: app.discordUsername,
    email: app.email,
    interest_reason: app.interestReason,
    similar_games: app.similarGames,
    testing_experience: app.testingExperience,
    cpu: app.cpu,
    gpu: app.gpu,
    ram: app.ram,
    operating_system: app.operatingSystem,
    additional_notes: app.additionalNotes,
    joined_discord: true,
    agreement_accepted: true,
    // Server-controlled: whatever the browser sent about the agreement is ignored.
    agreement_version: AGREEMENT_VERSION,
    agreement_hash: AGREEMENT_SHA256,
    agreement_accepted_at: acceptedAt,
  };
}

const MAX_ID_ATTEMPTS = 5;

export function createHandler(deps: HandlerDeps): (request: Request) => Promise<Response> {
  const now = deps.now ?? (() => new Date());
  const newPublicId = deps.newPublicId ?? (() => generatePublicApplicationId());
  const log = deps.log ?? consoleLogger;

  // Verified once per running instance; retried if it failed.
  let agreementReady: Promise<void> | null = null;
  const ensureAgreement = () => {
    agreementReady ??= (async () => {
      const actual = await sha256Hex(AGREEMENT_TEXT);
      if (actual !== AGREEMENT_SHA256) {
        throw new Error(
          "agreement.generated.ts was edited by hand: its text no longer matches AGREEMENT_SHA256. Run npm run agreement:sync.",
        );
      }
      await deps.store.ensureAgreementVersion(AGREEMENT_VERSION, AGREEMENT_SHA256, AGREEMENT_TEXT);
    })().catch((err) => {
      agreementReady = null;
      throw err;
    });
    return agreementReady;
  };

  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get("Origin");
    const allowed = isOriginAllowed(origin, deps.allowedOrigins);
    const baseHeaders: Record<string, string> = allowed ? corsHeaders(origin) : { Vary: "Origin" };

    const json = (status: number, body: SubmitResponse, extra: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), {
        status,
        headers: {
          ...baseHeaders,
          ...extra,
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    const fail = (
      status: number,
      code: Extract<SubmitResponse, { success: false }>["error"]["code"],
      message: string,
      extra: {
        fields?: Extract<SubmitResponse, { success: false }>["error"]["fields"];
        headers?: Record<string, string>;
      } = {},
    ) =>
      json(
        status,
        { success: false, error: { code, message, ...(extra.fields ? { fields: extra.fields } : {}) } },
        extra.headers,
      );

    if (!allowed) {
      return fail(403, "invalid_request", "This site is not allowed to submit applications.");
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: baseHeaders });
    }
    if (request.method !== "POST") {
      return fail(405, "invalid_request", "Only POST is supported.", { headers: { Allow: "POST, OPTIONS" } });
    }
    if (!(request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) {
      return fail(415, "invalid_request", "Send the application as JSON.");
    }
    const declaredLength = Number(request.headers.get("Content-Length") ?? "0");
    if (declaredLength > MAX_BODY_BYTES) {
      return fail(413, "invalid_request", "The application is too large.");
    }

    let raw: string;
    try {
      raw = await request.text();
    } catch {
      return fail(400, "invalid_request", "The request body could not be read.");
    }
    if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
      return fail(413, "invalid_request", "The application is too large.");
    }

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return fail(400, "invalid_request", "The application was not valid JSON.");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return fail(400, "invalid_request", "The application must be a JSON object.");
    }

    const spam = checkSpamSignals(body);
    if (!spam.ok) {
      log.info("submission rejected by spam check", { reason: spam.reason });
      return fail(
        400,
        "rejected",
        "We couldn't accept this submission. Please reload the page, check your answers and try again.",
      );
    }

    if (deps.captcha) {
      const token = (body as Record<string, unknown>).captchaToken;
      if (!(await deps.captcha.verify(typeof token === "string" ? token : undefined))) {
        return fail(400, "captcha_failed", "The anti-spam check failed. Please complete it again and resubmit.");
      }
    }

    const result = validateApplication(body);
    if (!result.ok) {
      return fail(422, "validation_failed", "Some answers need another look.", { fields: result.errors });
    }

    try {
      await ensureAgreement();
    } catch (err) {
      log.error("agreement version check failed", { error: String(err) });
      return fail(500, "server_error", "Applications are temporarily unavailable. Please try again later.");
    }

    const submittedAt = now().toISOString();
    let publicId = "";
    try {
      let inserted: InsertResult = "duplicate_public_id";
      for (let attempt = 0; attempt < MAX_ID_ATTEMPTS && inserted === "duplicate_public_id"; attempt++) {
        publicId = newPublicId();
        inserted = await deps.store.insertApplication(toRow(result.value, publicId, submittedAt));
      }
      if (inserted === "duplicate_discord") {
        return fail(
          409,
          "duplicate",
          "An application for this Discord username is already on file. You don't need to apply again; if something has changed, mention it to us on Discord.",
          { fields: { discordUsername: "An application for this Discord username is already on file." } },
        );
      }
      if (inserted !== "ok") {
        throw new Error(`could not generate a unique application ID in ${MAX_ID_ATTEMPTS} attempts`);
      }
    } catch (err) {
      log.error("storing application failed", { error: String(err) });
      return fail(
        500,
        "server_error",
        "Something went wrong on our side and your application was not saved. Please try again in a few minutes.",
      );
    }

    log.info("application stored", { applicationId: publicId });

    // The application is saved; from here on, nothing may turn this into a failure.
    try {
      const notified = await deps.notify(
        buildApplicationEmbed({
          ...result.value,
          publicApplicationId: publicId,
          agreementVersion: AGREEMENT_VERSION,
          submittedAt,
        }),
      );
      if (notified.ok) {
        await deps.store.markDiscordNotified(publicId, now().toISOString());
      } else {
        log.error("discord notification failed; application is stored", {
          applicationId: publicId,
          reason: notified.reason,
        });
      }
    } catch (err) {
      log.error("discord notification step threw; application is stored", {
        applicationId: publicId,
        error: String(err),
      });
    }

    return json(201, { success: true, applicationId: publicId });
  };
}
