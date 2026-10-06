// Optional CAPTCHA. Off unless TURNSTILE_SECRET_KEY is set as a Supabase secret.
//
// To add a different provider later, implement CaptchaVerifier and return it from
// captchaFromEnv. The website sends the widget's token as `captchaToken`.

export interface CaptchaVerifier {
  readonly name: string;
  verify(token: string | undefined): Promise<boolean>;
}

/** Cloudflare Turnstile. The visitor's IP address is deliberately not sent. */
export class TurnstileVerifier implements CaptchaVerifier {
  readonly name = "turnstile";
  constructor(private readonly secret: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async verify(token: string | undefined): Promise<boolean> {
    if (!token || token.length > 2048) return false;
    try {
      const response = await this.fetchImpl("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        body: new URLSearchParams({ secret: this.secret, response: token }),
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) return false;
      const result = (await response.json()) as { success?: boolean };
      return result.success === true;
    } catch {
      return false;
    }
  }
}

export function captchaFromEnv(env: { get(name: string): string | undefined }): CaptchaVerifier | null {
  const turnstileSecret = env.get("TURNSTILE_SECRET_KEY");
  if (turnstileSecret) return new TurnstileVerifier(turnstileSecret);
  return null;
}
