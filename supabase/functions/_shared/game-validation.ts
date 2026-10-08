// Shared validation for the three endpoints the Hexenbane game calls (ingest-telemetry,
// submit-crash, submit-feedback).
//
// Everything the game sends is untrusted: the endpoints are public and anyone can call them with
// any body. These helpers accept only the exact shapes the game produces and turn everything
// else into a short, field-named error. No dependencies; runs in Deno and in the Node tests.

/** The header every game request carries: the game's version, e.g. `0.8.0` or `0.8.1-playtest`. */
export const BUILD_HEADER = "X-Hexenbane-Build";

const VERSION = /^v?\d{1,4}\.\d{1,4}(?:\.\d{1,6})?(?:[-+][0-9A-Za-z.+-]{1,24})?$/;
export const MAX_VERSION_LENGTH = 32;

/** A semver-ish game version, at most 32 characters. */
export function isGameVersion(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_VERSION_LENGTH && VERSION.test(value);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function isUuidV4(value: unknown): value is string {
  return typeof value === "string" && UUID_V4.test(value);
}

// "2026-10-08T13:51:00Z", with optional fraction; "+00:00" and a bare time (which Godot's
// Time.get_datetime_string_from_system(true) produces) are read as UTC as well.
const ISO_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|\+00:00|-00:00)?$/;

/** Parses an ISO-8601 UTC timestamp into a normalised `toISOString()` form, or null. */
export function parseUtcTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40) return null;
  const m = ISO_UTC.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac] = m;
  const ms = frac ? Math.floor(Number(`0${frac}`) * 1000) : 0;
  const date = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, ms));
  // Reject rollovers such as February 31st or 25:00.
  if (
    date.getUTCFullYear() !== +y || date.getUTCMonth() !== +mo - 1 || date.getUTCDate() !== +d ||
    date.getUTCHours() !== +h || date.getUTCMinutes() !== +mi || date.getUTCSeconds() !== +s
  ) {
    return null;
  }
  if (+y < 2020 || +y > 2100) return null;
  return date.toISOString();
}

// deno-lint-ignore no-control-regex
const CONTROL_EXCEPT_NEWLINE_TAB = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
// deno-lint-ignore no-control-regex
const ANSI_ESCAPE = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;
const INVISIBLE_CHARS = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/**
 * Cleans untrusted text for storage: no NUL or other control characters (Postgres text cannot
 * hold NUL), no terminal colour codes, no invisible direction marks. Multi-line text keeps its
 * newlines and tabs; single-line text has all whitespace folded to single spaces.
 */
export function cleanText(value: string, singleLine: boolean): string {
  let text = value.replace(/\r\n?/g, "\n").replace(ANSI_ESCAPE, "").replace(CONTROL_EXCEPT_NEWLINE_TAB, "")
    .replace(INVISIBLE_CHARS, "");
  if (singleLine) text = text.replace(/\s+/g, " ").trim();
  return text;
}

/** Characters as people count them (code points). */
export function codePoints(value: string): number {
  return Array.from(value).length;
}

const encoder = new TextEncoder();

/** UTF-8 size of a string in bytes. */
export function utf8Bytes(value: string): number {
  return encoder.encode(value).length;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export type FieldErrors = Record<string, string>;

/**
 * Reads a string field. `max` counts code points after cleaning; `maxBytes` (optional) caps the
 * UTF-8 size. Returns the cleaned value, or records an error and returns null.
 */
export function readText(
  source: Record<string, unknown>,
  key: string,
  errors: FieldErrors,
  opts: { min?: number; max: number; maxBytes?: number; singleLine?: boolean; optional?: boolean },
  label = key,
): string | null {
  const raw = source[key];
  if (raw === undefined || raw === null) {
    if (opts.optional) return "";
    errors[label] = "is required";
    return null;
  }
  if (typeof raw !== "string") {
    errors[label] = "must be a string";
    return null;
  }
  // Refuse absurd values before doing any work on them.
  if (raw.length > (opts.maxBytes ?? opts.max * 4) + 1024) {
    errors[label] = `must be at most ${opts.max} characters`;
    return null;
  }
  const value = cleanText(raw, opts.singleLine ?? false);
  const length = codePoints(value);
  if (length < (opts.min ?? 0)) {
    errors[label] = opts.min === 1 ? "must not be empty" : `must be at least ${opts.min} characters`;
    return null;
  }
  if (length > opts.max) {
    errors[label] = `must be at most ${opts.max} characters`;
    return null;
  }
  if (opts.maxBytes !== undefined && utf8Bytes(value) > opts.maxBytes) {
    errors[label] = `must be at most ${opts.maxBytes} bytes`;
    return null;
  }
  return value;
}

/** Context values the game reports about where a player was: short text or a plain number. */
export type ContextValue = string | number | string[];

export interface ContextSpec {
  /** Short single-line text, at most 200 characters. */
  text?: readonly string[];
  /** Finite numbers between 0 and 1,000,000 (or numeric strings, which are converted). */
  numbers?: readonly string[];
  /** Up to 8 short ids (or one comma-separated string, which is split). */
  lists?: readonly string[];
  /** Keys that must be present. */
  required?: readonly string[];
}

const CONTEXT_TEXT_MAX = 200;
const CONTEXT_LIST_MAX = 8;
const CONTEXT_ID_MAX = 64;

/**
 * Validates a context object against a spec. Unknown keys are dropped (never stored), so a
 * newer game can send more without being refused, but nothing unexpected reaches the database.
 */
export function readContext(
  source: Record<string, unknown>,
  key: string,
  spec: ContextSpec,
  errors: FieldErrors,
): Record<string, ContextValue> | null {
  const raw = source[key];
  if (!isPlainObject(raw)) {
    errors[key] = "must be an object";
    return null;
  }
  const out: Record<string, ContextValue> = {};
  let ok = true;
  const bad = (k: string, message: string) => {
    errors[`${key}.${k}`] = message;
    ok = false;
  };
  for (const k of spec.required ?? []) {
    if (raw[k] === undefined || raw[k] === null) bad(k, "is required");
  }
  for (const k of spec.text ?? []) {
    const v = raw[k];
    if (v === undefined || v === null) continue;
    if (typeof v === "number" && Number.isFinite(v)) {
      out[k] = String(v);
      continue;
    }
    if (typeof v !== "string" || v.length > CONTEXT_TEXT_MAX * 4) {
      bad(k, "must be a short string");
      continue;
    }
    const clean = cleanText(v, true);
    if (codePoints(clean) > CONTEXT_TEXT_MAX) bad(k, `must be at most ${CONTEXT_TEXT_MAX} characters`);
    else out[k] = clean;
  }
  for (const k of spec.numbers ?? []) {
    const v = raw[k];
    if (v === undefined || v === null || v === "") continue;
    const n = typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : v;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1_000_000) bad(k, "must be a number");
    else out[k] = n;
  }
  for (const k of spec.lists ?? []) {
    const v = raw[k];
    if (v === undefined || v === null) continue;
    const items = typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : v;
    if (
      !Array.isArray(items) || items.length > CONTEXT_LIST_MAX ||
      !items.every((i) => typeof i === "string" && i.length > 0 && i.length <= CONTEXT_ID_MAX)
    ) {
      bad(k, `must be a list of at most ${CONTEXT_LIST_MAX} short ids`);
      continue;
    }
    out[k] = (items as string[]).map((i) => cleanText(i, true));
  }
  return ok ? out : null;
}

/** The response every game endpoint sends on failure. */
export interface GameErrorBody {
  ok: false;
  error:
    | "method_not_allowed"
    | "unsupported_media_type"
    | "bad_build"
    | "too_large"
    | "invalid_json"
    | "validation_failed"
    | "rate_limited"
    | "discord_failed"
    | "server_error";
  message: string;
  fields?: FieldErrors;
}
