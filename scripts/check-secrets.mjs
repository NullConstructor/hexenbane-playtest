#!/usr/bin/env node
// Fails if anything that looks like a server-side secret is in the built website or in files
// git would commit. Run by CI before every deploy and by `npm run verify`.
import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const PATTERNS = [
  { name: "Discord webhook URL", re: /discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d{5,}\/[\w-]{20,}/i },
  { name: "Discord bot token", re: /\b[MNO][A-Za-z\d_-]{23,25}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,}\b/ },
  { name: "Supabase secret key", re: /\bsb_secret_[A-Za-z0-9_-]{10,}/ },
  { name: "Postgres connection string with password", re: /postgres(?:ql)?:\/\/[^:\s/]+:[^@\s]{6,}@/i },
];

/** A JWT whose payload says role=service_role is the Supabase service key. */
function serviceRoleJwts(text) {
  const found = [];
  for (const m of text.matchAll(/eyJ[A-Za-z0-9_-]+\.(eyJ[A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+/g)) {
    try {
      const payload = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8"));
      if (payload.role === "service_role" || payload.role === "supabase_admin") found.push(m[0].slice(0, 16) + "…");
    } catch {
      /* not a JWT */
    }
  }
  return found;
}

function scan(file, label) {
  const text = readFileSync(file, "utf8");
  const problems = [];
  for (const { name, re } of PATTERNS) if (re.test(text)) problems.push(name);
  if (serviceRoleJwts(text).length) problems.push("Supabase service_role key");
  return problems.map((p) => `${label}: ${p}`);
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const problems = [];
const textFile = (f) => /\.(html|js|mjs|cjs|css|json|map|txt|ts|tsx|md|toml|sql|yml|yaml|svg|example)$/i.test(f) || /\.env/.test(f);

// 1. The built website (everything in it is public).
const dist = join(root, "site/dist");
if (existsSync(dist)) {
  for (const file of walk(dist).filter(textFile)) problems.push(...scan(file, `site/dist/${relative(dist, file)}`));
} else {
  console.warn("⚠ site/dist not found; run the build first to scan the website bundle.");
}

// 2. Every file git would commit.
let tracked = [];
try {
  tracked = execSync("git ls-files --cached --others --exclude-standard", { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
} catch {
  console.warn("⚠ not a git repository; skipping the source scan.");
}
for (const file of tracked) {
  if (/(^|\/)\.env(\.|$)/.test(file) && !file.endsWith(".env.example")) problems.push(`${file}: a .env file would be committed`);
  const abs = join(root, file);
  if (existsSync(abs) && textFile(file) && statSync(abs).size < 2_000_000) problems.push(...scan(abs, file));
}

if (problems.length) {
  for (const p of problems) console.error(`✖ ${p}`);
  console.error("\nSecrets must live only in Supabase secrets or local .env files. Remove them, and rotate any real secret that was exposed.");
  process.exit(1);
}
console.log(`✔ No secrets found in the website bundle or ${tracked.length} source files.`);
