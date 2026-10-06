// CORS for the public submission endpoint.
//
// Only origins listed in the ALLOWED_ORIGINS secret (comma-separated, exact matches such as
// "https://nullconstructor.github.io") may call the function from a browser. When the secret
// is not set, only local development origins are allowed. CORS is a browser rule, not
// authentication: the function validates every request regardless.

export const DEFAULT_DEV_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
];

/** Parses ALLOWED_ORIGINS into normalised origins, ignoring blanks and stray paths. */
export function parseAllowedOrigins(value: string | undefined): string[] {
  if (!value || !value.trim()) return [...DEFAULT_DEV_ORIGINS];
  const origins: string[] = [];
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    try {
      // "https://name.github.io/hexenbane-playtest/" becomes "https://name.github.io".
      origins.push(new URL(trimmed).origin);
    } catch {
      // Ignore entries that are not URLs; they can never match a browser Origin header.
    }
  }
  return origins;
}

export function isOriginAllowed(origin: string | null, allowed: readonly string[]): origin is string {
  return origin !== null && allowed.includes(origin);
}

export function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}
