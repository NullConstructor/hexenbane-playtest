// The playtest application: fields, limits, sanitising and validation.
//
// This file has no dependencies and runs in both Deno (the Edge Function) and the browser
// (the website imports it through the `@shared` alias), so the form and the server enforce
// exactly the same rules. The server's verdict is the one that counts.

export const FIELD_LIMITS = {
  preferredName: { min: 1, max: 60 },
  discordUsername: { min: 2, max: 32 },
  email: { min: 0, max: 254 },
  interestReason: { min: 10, max: 1500 },
  similarGames: { min: 2, max: 1000 },
  testingExperience: { min: 2, max: 1500 },
  cpu: { min: 2, max: 120 },
  gpu: { min: 2, max: 120 },
  ram: { min: 1, max: 40 },
  operatingSystem: { min: 2, max: 80 },
  additionalNotes: { min: 0, max: 1500 },
} as const;

export type TextField = keyof typeof FIELD_LIMITS;

/** Fields that are a single line; newlines in them are folded into spaces. */
const SINGLE_LINE: ReadonlySet<TextField> = new Set([
  "preferredName",
  "discordUsername",
  "email",
  "cpu",
  "gpu",
  "ram",
  "operatingSystem",
]);

const OPTIONAL: ReadonlySet<TextField> = new Set(["email", "additionalNotes"]);

export const FIELD_LABELS: Record<TextField | "joinedDiscord" | "agreementAccepted", string> = {
  preferredName: "Display name",
  discordUsername: "Discord username",
  email: "Backup email",
  interestReason: "What interests you about Hexenbane",
  similarGames: "Similar games you've played",
  testingExperience: "Gaming and playtesting experience",
  cpu: "CPU",
  gpu: "GPU",
  ram: "RAM",
  operatingSystem: "Operating system",
  additionalNotes: "Additional notes",
  joinedDiscord: "Discord membership",
  agreementAccepted: "Private Playtest Agreement",
};

/** Name of the hidden honeypot input. Humans never see it; bots tend to fill it. */
export const HONEYPOT_FIELD = "website";

/** Submissions faster than this after the form loaded are treated as automated. */
export const MIN_FILL_MS = 3000;

/** Largest request body the Edge Function will read. */
export const MAX_BODY_BYTES = 32 * 1024;

export interface ApplicationInput {
  preferredName: string;
  discordUsername: string;
  email: string | null;
  interestReason: string;
  similarGames: string;
  testingExperience: string;
  cpu: string;
  gpu: string;
  ram: string;
  operatingSystem: string;
  additionalNotes: string | null;
  joinedDiscord: true;
  agreementAccepted: true;
}

export type FieldErrors = Partial<Record<keyof ApplicationInput, string>>;

export type ValidationResult =
  | { ok: true; value: ApplicationInput }
  | { ok: false; errors: FieldErrors };

// Bidirectional overrides and zero-width characters can disguise text; C0/C1 controls have no
// business in a form answer. Tabs and newlines survive in multi-line fields.
// deno-lint-ignore no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const INVISIBLE_CHARS = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/** Normalises one answer: Unicode NFC, no control or invisible characters, trimmed. */
export function sanitizeText(value: string, singleLine: boolean): string {
  let text = value.normalize("NFC").replace(/\r\n?/g, "\n").replace(CONTROL_CHARS, "").replace(INVISIBLE_CHARS, "");
  if (singleLine) text = text.replace(/\s+/g, " ");
  else text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

/** Length as people count it (code points, so an emoji is one). */
export function textLength(value: string): number {
  return Array.from(value).length;
}

/**
 * The key used to spot repeated applications: trimmed, leading "@" removed, lower-cased.
 * The database computes the same thing in the generated column discord_username_normalized.
 */
export function normalizeDiscordUsername(value: string): string {
  return value.trim().replace(/^@+/, "").toLowerCase();
}

const DISCORD_USERNAME = /^[a-z0-9_.]{2,32}$/;
const LEGACY_DISCORD_TAG = /#\d{4}$/;
// Deliberately simple: one "@", something on each side, a dot in the domain, no spaces.
const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

function validateDiscordUsername(raw: string): string | null {
  if (LEGACY_DISCORD_TAG.test(raw)) {
    return "Use your current Discord username, without the old #1234 tag.";
  }
  const normalized = normalizeDiscordUsername(raw);
  if (normalized.length < 2 || normalized.length > 32) {
    return "Discord usernames are 2 to 32 characters long.";
  }
  if (!DISCORD_USERNAME.test(normalized)) {
    return "Discord usernames only use letters, numbers, underscores and periods. Use your username, not your display name.";
  }
  if (normalized.includes("..")) {
    return "Discord usernames cannot contain two periods in a row.";
  }
  return null;
}

/**
 * Validates an untrusted object (parsed JSON or form data) and returns clean values or
 * per-field messages. Unknown keys are ignored. The honeypot and timing checks live in
 * `checkSpamSignals` so the browser can run this without them.
 */
export function validateApplication(input: unknown): ValidationResult {
  const source = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const errors: FieldErrors = {};
  const clean: Partial<Record<TextField, string | null>> = {};

  for (const field of Object.keys(FIELD_LIMITS) as TextField[]) {
    const rawValue = source[field];
    const { min, max } = FIELD_LIMITS[field];
    const label = FIELD_LABELS[field];

    if (rawValue !== undefined && rawValue !== null && typeof rawValue !== "string") {
      errors[field] = `${label} must be text.`;
      continue;
    }
    // Refuse absurd payloads before doing any work on them.
    if (typeof rawValue === "string" && rawValue.length > max * 4 + 100) {
      errors[field] = `${label} must be at most ${max} characters.`;
      continue;
    }
    const value = sanitizeText(rawValue ?? "", SINGLE_LINE.has(field));
    const length = textLength(value);

    if (length === 0) {
      if (OPTIONAL.has(field)) {
        clean[field] = null;
        continue;
      }
      errors[field] = `${label} is required.`;
      continue;
    }
    if (length < min) {
      errors[field] = `${label} needs at least ${min} characters.`;
      continue;
    }
    if (length > max) {
      errors[field] = `${label} must be at most ${max} characters (currently ${length}).`;
      continue;
    }
    if (field === "discordUsername") {
      const problem = validateDiscordUsername(value);
      if (problem) {
        errors[field] = problem;
        continue;
      }
    }
    if (field === "email" && !EMAIL.test(value)) {
      errors[field] = "That doesn't look like an email address. Leave it empty if you'd rather not give one.";
      continue;
    }
    clean[field] = value;
  }

  if (source.joinedDiscord !== true) {
    errors.joinedDiscord = "Join the Hexenbane Discord server and tick this box. Approved testers are contacted there.";
  }
  if (source.agreementAccepted !== true) {
    errors.agreementAccepted = "You must read and agree to the Private Playtest Agreement to apply.";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      preferredName: clean.preferredName as string,
      discordUsername: clean.discordUsername as string,
      email: clean.email ?? null,
      interestReason: clean.interestReason as string,
      similarGames: clean.similarGames as string,
      testingExperience: clean.testingExperience as string,
      cpu: clean.cpu as string,
      gpu: clean.gpu as string,
      ram: clean.ram as string,
      operatingSystem: clean.operatingSystem as string,
      additionalNotes: clean.additionalNotes ?? null,
      joinedDiscord: true,
      agreementAccepted: true,
    },
  };
}

export type SpamVerdict = { ok: true } | { ok: false; reason: "honeypot" | "too_fast" };

/** Lightweight bot checks that need no personal data: a honeypot and a minimum fill time. */
export function checkSpamSignals(input: unknown): SpamVerdict {
  const source = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const trap = source[HONEYPOT_FIELD];
  if (trap !== undefined && trap !== null && trap !== "") return { ok: false, reason: "honeypot" };
  const elapsed = source.elapsedMs;
  if (typeof elapsed !== "number" || !Number.isFinite(elapsed) || elapsed < MIN_FILL_MS) {
    return { ok: false, reason: "too_fast" };
  }
  return { ok: true };
}

/** The request body the website sends. */
export interface SubmitRequestBody extends Partial<Record<TextField, string>> {
  joinedDiscord: boolean;
  agreementAccepted: boolean;
  [HONEYPOT_FIELD]: string;
  elapsedMs: number;
  captchaToken?: string;
}

export type SubmitResponse =
  | { success: true; applicationId: string }
  | {
    success: false;
    error: {
      code: "invalid_request" | "validation_failed" | "duplicate" | "rejected" | "captcha_failed" | "server_error";
      message: string;
      fields?: FieldErrors;
    };
  };
