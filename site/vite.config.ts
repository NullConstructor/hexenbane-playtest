import { fileURLToPath, URL } from "node:url";
import { marked } from "marked";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { AGREEMENT_TEXT, AGREEMENT_VERSION } from "../supabase/functions/_shared/agreement.generated.ts";
import { site } from "./src/content.ts";
import { renderTokens } from "./src/render.ts";

// Values a browser must never receive. If one of these appears as a VITE_ variable the build
// stops, because Vite would copy it into the public JavaScript.
const FORBIDDEN_PUBLIC_ENV = /SERVICE_ROLE|SECRET|WEBHOOK|BOT_TOKEN|PASSWORD|PRIVATE/i;

function normalizeBase(value: string | undefined): string {
  if (!value || value === "/") return "/";
  return `/${value.replace(/^\/+|\/+$/g, "")}/`;
}

/** Agreement markdown → HTML for the dialog. Its own title is dropped (the dialog has one). */
function agreementHtml(): string {
  const body = AGREEMENT_TEXT.replace(/^# .*\n+/, "");
  return marked.parse(body, { async: false, gfm: true }).replace(/<(\/?)h2>/g, "<$1h3>");
}

function hexenbaneContent(base: string, env: Record<string, string>): Plugin {
  return {
    name: "hexenbane-content",
    transformIndexHtml(html) {
      const tokens = renderTokens(base, env.VITE_DISCORD_INVITE_URL ?? "", agreementHtml(), AGREEMENT_VERSION);
      // Link previews (Discord, social sites) need an absolute image URL.
      if (env.SITE_URL) tokens.SOCIAL_IMAGE = new URL(site.socialImage, env.SITE_URL.replace(/\/?$/, "/")).href;
      const out = html.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
        if (!(key in tokens)) throw new Error(`index.html uses unknown token ${match}`);
        return tokens[key];
      });
      return out;
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const base = normalizeBase(env.BASE_PATH);

  for (const key of Object.keys(env)) {
    if (key.startsWith("VITE_") && FORBIDDEN_PUBLIC_ENV.test(key)) {
      throw new Error(`${key} looks like a secret. Secrets must never be VITE_ variables: they would be published in the website.`);
    }
  }

  const required = ["VITE_SUPABASE_URL", "VITE_DISCORD_INVITE_URL"];
  const missing = required.filter((k) => !env[k]);
  if (missing.length) {
    const message = `Missing public configuration: ${missing.join(", ")} (see site/.env.example).`;
    if (env.REQUIRE_PUBLIC_CONFIG === "true") throw new Error(message);
    console.warn(`\n⚠ ${message} The form and Discord buttons will not work until they are set.\n`);
  }

  return {
    base,
    plugins: [hexenbaneContent(base, env)],
    resolve: {
      alias: { "@shared": fileURLToPath(new URL("../supabase/functions/_shared", import.meta.url)) },
    },
    server: { port: 5173, strictPort: true },
    preview: { port: 4173, strictPort: true },
    build: { target: "es2022", sourcemap: false, assetsInlineLimit: 0 },
  };
});
