// The request pipeline shared by the game's endpoints: method, content type, build header,
// body size, rate limits, JSON parsing and validation, in that order, before the endpoint's own
// work runs. Independent of Supabase and Deno so it can be tested with fakes.
//
// The game is a desktop program, not a browser page, so there is no CORS allow-list: an
// OPTIONS request gets an empty 204 without any Access-Control-Allow-* headers, which means a
// browser on another site can never send these JSON requests. Every request is validated anyway.

import { BUILD_HEADER, type FieldErrors, type GameErrorBody, isGameVersion, sha256Hex } from "./game-validation.ts";
import { consoleLogger, type Logger } from "./handler.ts";

export interface RateLimitRule {
  /** Name stored in the rate-limit table, e.g. "telemetry:install". */
  bucket: string;
  limit: number;
  windowSeconds: number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** Seconds until the current window ends (for Retry-After). */
  retryAfter: number;
}

export interface RateLimiter {
  /** Counts one request for `key` in `bucket` and says whether it is within the limit. */
  hit(rule: RateLimitRule, key: string): Promise<RateLimitVerdict>;
}

export interface GameEndpointConfig {
  /** Function name, for logs. */
  name: string;
  maxBodyBytes: number;
  installRule: RateLimitRule;
  ipRule: RateLimitRule;
}

export interface GameDeps {
  limiter: RateLimiter;
  /** Salt for hashing client IPs (secret RATE_LIMIT_IP_SALT). Without it, per-IP limits are off. */
  ipSalt?: string | null;
  now?: () => Date;
  log?: Logger;
}

export type Validated<T> = { ok: true; value: T; installId: string } | { ok: false; errors: FieldErrors };

export interface GameResult {
  status: number;
  body: Record<string, unknown>;
}

export interface RunContext {
  build: string;
  now: Date;
  log: Logger;
}

const BASE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

export function gameJson(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, ...extra } });
}

function fail(
  status: number,
  error: GameErrorBody["error"],
  message: string,
  extra: { fields?: FieldErrors; headers?: Record<string, string> } = {},
): Response {
  const body: GameErrorBody = { ok: false, error, message, ...(extra.fields ? { fields: extra.fields } : {}) };
  return gameJson(status, body, extra.headers);
}

/** The caller's IP as the Supabase edge reports it, or null. Only ever used hashed. */
export function clientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const candidate = forwarded || request.headers.get("cf-connecting-ip")?.trim() ||
    request.headers.get("x-real-ip")?.trim();
  if (!candidate || candidate.length > 64 || !/^[0-9A-Fa-f:.]+$/.test(candidate)) return null;
  return candidate;
}

/** Salted SHA-256 of an IP. The raw IP is never stored or logged. */
export function hashIp(ip: string, salt: string): Promise<string> {
  return sha256Hex(`hexenbane-ip:${salt}:${ip}`);
}

/**
 * Reads at most `maxBytes` of the body. Returns null when the body is larger, without reading
 * the rest, so a huge upload cannot exhaust memory.
 */
export async function readBodyCapped(request: Request, maxBytes: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Builds a request handler for one game endpoint. `validate` turns the parsed JSON into a clean
 * value (and the install it came from); `run` does the endpoint's work and returns its answer.
 */
export function createGameEndpoint<T>(
  config: GameEndpointConfig,
  deps: GameDeps,
  validate: (body: unknown) => Validated<T>,
  run: (value: T, ctx: RunContext) => Promise<GameResult>,
): (request: Request) => Promise<Response> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? consoleLogger;
  let warnedNoSalt = false;

  const limited = async (rule: RateLimitRule, key: string): Promise<Response | null> => {
    try {
      const verdict = await deps.limiter.hit(rule, key);
      if (verdict.allowed) return null;
      log.info("rate limited", { function: config.name, bucket: rule.bucket });
      return fail(429, "rate_limited", "Too many requests. Try again later.", {
        headers: { "Retry-After": String(Math.max(1, Math.ceil(verdict.retryAfter))) },
      });
    } catch (err) {
      // A broken limiter must not take the endpoint down; the database insert is the real gate.
      log.error("rate limit check failed; allowing the request", { function: config.name, error: String(err) });
      return null;
    }
  };

  return async (request: Request): Promise<Response> => {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { Allow: "POST, OPTIONS" } });
    }
    if (request.method !== "POST") {
      return fail(405, "method_not_allowed", "Only POST is supported.", { headers: { Allow: "POST, OPTIONS" } });
    }
    if (!(request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) {
      return fail(415, "unsupported_media_type", "Send the body as JSON.");
    }
    const build = request.headers.get(BUILD_HEADER);
    if (!isGameVersion(build)) {
      return fail(400, "bad_build", `The ${BUILD_HEADER} header is missing or not a game version.`);
    }
    const declaredLength = Number(request.headers.get("Content-Length") ?? "0");
    if (declaredLength > config.maxBodyBytes) {
      return fail(413, "too_large", "The request body is too large.");
    }

    if (deps.ipSalt) {
      const ip = clientIp(request);
      if (ip) {
        const blocked = await limited(config.ipRule, await hashIp(ip, deps.ipSalt));
        if (blocked) return blocked;
      }
    } else if (!warnedNoSalt) {
      warnedNoSalt = true;
      log.error("RATE_LIMIT_IP_SALT is not set; per-IP rate limits are off", { function: config.name });
    }

    let raw: string | null;
    try {
      raw = await readBodyCapped(request, config.maxBodyBytes);
    } catch {
      return fail(400, "invalid_json", "The request body could not be read.");
    }
    if (raw === null) return fail(413, "too_large", "The request body is too large.");

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return fail(400, "invalid_json", "The body was not valid JSON.");
    }

    const result = validate(body);
    if (!result.ok) {
      return fail(400, "validation_failed", "The request did not pass validation.", { fields: result.errors });
    }

    const blocked = await limited(config.installRule, result.installId);
    if (blocked) return blocked;

    try {
      const answer = await run(result.value, { build, now: now(), log });
      return gameJson(answer.status, answer.body);
    } catch (err) {
      log.error("request failed", { function: config.name, error: String(err) });
      return fail(500, "server_error", "Something went wrong on our side. Try again later.");
    }
  };
}
