// Optional Cloudflare Turnstile widget, loaded only when VITE_TURNSTILE_SITE_KEY is set.
// The Edge Function checks the token when TURNSTILE_SECRET_KEY is set (see README).

export interface CaptchaHandle {
  token(): string | null;
  reset(): void;
}

interface TurnstileApi {
  render(el: HTMLElement, options: Record<string, unknown>): string;
  reset(id?: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

export function initTurnstile(host: HTMLElement, siteKey: string): CaptchaHandle {
  let token: string | null = null;
  let widgetId: string | undefined;

  const script = document.createElement("script");
  script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
  script.async = true;
  script.defer = true;
  script.addEventListener("load", () => {
    widgetId = window.turnstile?.render(host, {
      sitekey: siteKey,
      theme: "dark",
      callback: (value: string) => (token = value),
      "expired-callback": () => (token = null),
      "error-callback": () => (token = null),
    });
  });
  document.head.append(script);

  return {
    token: () => token,
    reset: () => {
      token = null;
      window.turnstile?.reset(widgetId);
    },
  };
}
