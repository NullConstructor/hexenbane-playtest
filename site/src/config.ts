// Public runtime configuration, read from VITE_ variables at build time.
// Only values that are safe for anyone to see belong here (see site/.env.example).

const trimSlash = (value: string) => value.replace(/\/+$/, "");

const supabaseUrl = trimSlash(import.meta.env.VITE_SUPABASE_URL ?? "");

export const config = {
  submitUrl: import.meta.env.VITE_SUBMIT_URL || (supabaseUrl ? `${supabaseUrl}/functions/v1/submit-playtest-application` : ""),
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY ?? "",
  discordInviteUrl: import.meta.env.VITE_DISCORD_INVITE_URL ?? "",
  turnstileSiteKey: import.meta.env.VITE_TURNSTILE_SITE_KEY ?? "",
} as const;
