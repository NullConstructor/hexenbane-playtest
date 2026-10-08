# Hexenbane Private Playtest

Everything behind the Hexenbane private playtest:

1. **A public website** (GitHub Pages) where people learn about Hexenbane, join the Discord
   server, read the Private Playtest Agreement and apply.
2. **A Supabase backend**: one Edge Function that validates each application and stores it, a
   locked-down database table, and a Discord notification for every application. Three more
   Edge Functions serve the game itself: gameplay telemetry, crash reports and the in-game F8
   bug report form ([section 13](#13-game-telemetry-crash-reports-and-f8-reports)).
3. **A Discord setup script** that turns your existing Community server into an organised
   Hexenbane server with roles, a hidden staff area and a private tester area.

Approval is manual on purpose. You read applications in Discord (and in Supabase, which is the
authoritative record), decide, message the person, and give them the Playtester role. Nothing
delivers the game automatically.

```text
Visitor ──► GitHub Pages site ──POST──► Supabase Edge Function ──► playtest_applications (Postgres)
                                          │  validates, sanitises,     (no public access)
                                          │  attaches agreement v/hash
                                          └──► Discord webhook ──► #playtest-applications (staff only)

Hexenbane game ──POST──► ingest-telemetry ──► telemetry_events ──► balance views (SQL Editor)
               ──POST──► submit-crash ──────► crash_reports ──────► first of each crash ─┐
               ──POST──► submit-feedback ───► feedback_reports ───► every F8 report ─────┴─► #bug-reports (forum)
```

> New here? Follow **[SETUP_CHECKLIST.md](SETUP_CHECKLIST.md)** from top to bottom. It takes you
> from nothing to your first real application, and links back to the detailed steps below.

## Contents

- [What's in this repository](#whats-in-this-repository)
- [Security model: what must never be public](#security-model-what-must-never-be-public)
- [1. Local development](#1-local-development)
- [2. Create the Supabase project](#2-create-the-supabase-project)
- [3. Configure Supabase secrets](#3-configure-supabase-secrets)
- [4. Configure the Discord application and bot](#4-configure-the-discord-application-and-bot)
- [5. Provision the Discord server](#5-provision-the-discord-server)
- [6. Configure the Discord webhook](#6-configure-the-discord-webhook)
- [7. Configure the Discord invite](#7-configure-the-discord-invite)
- [8. GitHub Pages deployment](#8-github-pages-deployment)
- [AUTOMATICALLY CONFIGURED](#automatically-configured)
- [MANUAL DISCORD SETTINGS YOU MUST CONFIGURE](#manual-discord-settings-you-must-configure)
- [HOW YOU RECEIVE PLAYTEST REQUESTS](#how-you-receive-playtest-requests)
- [10. Approving a tester](#10-approving-a-tester)
- [11. Updating the agreement](#11-updating-the-agreement)
- [12. Updating the website](#12-updating-the-website)
- [13. Game telemetry, crash reports and F8 reports](#13-game-telemetry-crash-reports-and-f8-reports)
- [Anti-spam, and adding a CAPTCHA later](#anti-spam-and-adding-a-captcha-later)
- [Checks and tests](#checks-and-tests)
- [Extending it later](#extending-it-later)

## What's in this repository

```text
/
├── README.md                     ← you are here
├── SETUP_CHECKLIST.md            ← blank deployment → first application
├── package.json                  ← root scripts (npm workspaces: site, discord)
├── .github/workflows/
│   ├── deploy-pages.yml          ← builds and publishes the site on every push to main
│   └── checks.yml                ← type-checks, tests, SQL checks on pull requests
├── site/                         ← the public website (Vite + TypeScript, no framework)
│   ├── index.html                ← page structure
│   ├── .env.example              ← PUBLIC config: Supabase URL, Discord invite
│   ├── vite.config.ts            ← base path for GitHub Pages; renders content into HTML
│   ├── public/media/             ← key art, screenshots, social card (replace these)
│   └── src/
│       ├── content.ts            ← ALL the page copy, screenshots list, FAQ, social links
│       ├── form.ts               ← application form, validation, submit states
│       ├── styles/tokens.css     ← colours, fonts, spacing
│       └── styles/fonts.css      ← font files (swap in Kingdom/Eternity here)
├── legal/
│   ├── playtest-agreement-v1.md  ← THE agreement text (never edit after publishing)
│   ├── current.json              ← which version applicants accept now
│   ├── agreement-ledger.json     ← generated: every version + SHA-256
│   └── README.md                 ← lawyer warning, how versioning works
├── supabase/
│   ├── config.toml               ← Supabase CLI config (function has JWT check off)
│   ├── migrations/               ← database schema, RLS, triggers
│   ├── functions/
│   │   ├── .env.example          ← SERVER secrets template (webhook URLs, origins, IP salt)
│   │   ├── submit-playtest-application/index.ts   ← the website's Edge Function
│   │   ├── ingest-telemetry/index.ts              ← the game: gameplay events
│   │   ├── submit-crash/index.ts                  ← the game: crashes and script errors
│   │   ├── submit-feedback/index.ts               ← the game: F8 bug reports
│   │   └── _shared/              ← validation, Discord embeds, CORS, IDs, agreement (generated),
│   │                               game endpoints (telemetry.ts, crash.ts, feedback.ts, game-*.ts)
│   └── tests/                    ← SQL security checks, end-to-end test
├── discord/
│   ├── server-config.ts          ← the server layout: roles, categories, channels
│   ├── .env.example              ← LOCAL bot token + server ID template
│   ├── README.md                 ← bot setup, permissions, removing the bot
│   └── src/                      ← dry-run planner, Discord calls, permission simulator
├── scripts/
│   ├── agreement.mjs             ← computes agreement version/hash, guards old versions
│   └── check-secrets.mjs         ← fails the build if a secret is in the site or the repo
└── tests/                        ← unit tests (validation, embed, handler, Discord layout)
```

## Security model: what must never be public

| Value | Where it lives | Public? |
| --- | --- | --- |
| Supabase project URL | `site/.env.local`, GitHub variable `VITE_SUPABASE_URL` | Yes, safe |
| Supabase anon / publishable key (optional) | GitHub variable `VITE_SUPABASE_ANON_KEY` | Yes, safe; it can't read applications |
| Discord invite URL | GitHub variable `VITE_DISCORD_INVITE_URL` | Yes |
| **Supabase service_role / secret key** | Supabase only (injected into the function automatically) | **NEVER** |
| **Discord webhook URL** | Supabase secret `DISCORD_WEBHOOK_URL` | **NEVER** |
| **#bug-reports webhook URL** | Supabase secret `DISCORD_BUG_REPORTS_WEBHOOK_URL` | **NEVER** |
| **IP hash salt** | Supabase secret `RATE_LIMIT_IP_SALT` | **NEVER** |
| #bug-reports forum tag ids | Supabase secret `DISCORD_BUG_REPORTS_TAGS` | Harmless; kept with the others |
| Functions base URL (`https://<ref>.supabase.co/functions/v1`) | The game's `project.godot` (`hexenbane/backend_url`) | Yes, safe |
| **Discord bot token** | `discord/.env` on your PC only | **NEVER** |
| Database password | Your password manager | **NEVER** |

**Never put the service role key, the webhook URL or the bot token in GitHub Pages, in any
`VITE_` variable, in GitHub repository variables, or in any committed file.** Anything in the
website can be read by anyone. Safeguards in this repo:

- The build stops if a `VITE_` variable's name looks like a secret.
- `npm run check:secrets` (run by every deploy) scans the built site and every committed file
  for webhook URLs, bot tokens, service-role keys and Supabase secret keys.
- `.gitignore` excludes every `.env` file except the `.env.example` templates.
- The database tables have row level security on, no policies, and no table privileges for the
  public `anon`/`authenticated` roles, so the public key can neither read nor insert
  applications. Only the Edge Function (service role) and your Dashboard can.
- The function returns only `{ success, applicationId }`. It never returns database rows or the
  internal UUID. Applicant IP addresses are not stored or logged.

If a secret ever leaks: rotate it (reset the bot token; delete and recreate the webhook; roll
the service key in Supabase → Project Settings → API Keys) and update where it's stored.

---

## 1. Local development

You need **Node.js 22 LTS or newer** (<https://nodejs.org>) and Git. Commands work in
PowerShell, Command Prompt, macOS and Linux terminals unless noted.

```bash
git clone https://github.com/NullConstructor/hexenbane-playtest.git
cd hexenbane-playtest
npm install
```

### Run the website on its own

```bash
cp site/.env.example site/.env.local        # PowerShell: Copy-Item site/.env.example site/.env.local
npm run dev
```

Open <http://localhost:5173>. Edits to `site/src/content.ts`, styles and images show up
immediately. Fill in `site/.env.local` to make the form and Discord buttons work:

```ini
VITE_SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co   # or http://127.0.0.1:54321 for local Supabase
VITE_DISCORD_INVITE_URL=https://discord.gg/your-invite
```

To submit against your hosted project from localhost, `ALLOWED_ORIGINS` (step 3) must include
`http://localhost:5173`.

### Run Supabase locally (optional, needs Docker Desktop)

This gives you a private database and the function on your own machine, so you can test without
touching real data.

```bash
npx supabase start                          # first run downloads images; applies supabase/migrations
cp supabase/functions/.env.example supabase/functions/.env
#   fill in DISCORD_WEBHOOK_URL (a test channel's webhook, or leave empty)
#   ALLOWED_ORIGINS=http://localhost:5173
npx supabase functions serve --env-file supabase/functions/.env
```

`npx supabase start` prints the local **API URL** (`http://127.0.0.1:54321`), **Studio URL**
(<http://127.0.0.1:54323>, a local Dashboard) and keys. Put `VITE_SUPABASE_URL=http://127.0.0.1:54321`
in `site/.env.local`, run `npm run dev` in another terminal, and submit the form. The row
appears in local Studio → Table Editor → `playtest_applications`.

Stop everything with `npx supabase stop`.

### Test a submission without the website

macOS/Linux/Git Bash:

```bash
curl -i -X POST "http://127.0.0.1:54321/functions/v1/submit-playtest-application" \
  -H "Origin: http://localhost:5173" -H "Content-Type: application/json" \
  -d '{"preferredName":"Test","discordUsername":"test_hunter","interestReason":"Testing the form end to end.","similarGames":"Slay the Spire","testingExperience":"Some","cpu":"Ryzen 5","gpu":"RTX 3060","ram":"16 GB","operatingSystem":"Windows 11","joinedDiscord":true,"agreementAccepted":true,"website":"","elapsedMs":60000}'
```

PowerShell:

```powershell
$body = @{ preferredName="Test"; discordUsername="test_hunter"; interestReason="Testing the form end to end.";
  similarGames="Slay the Spire"; testingExperience="Some"; cpu="Ryzen 5"; gpu="RTX 3060"; ram="16 GB";
  operatingSystem="Windows 11"; joinedDiscord=$true; agreementAccepted=$true; website=""; elapsedMs=60000 } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:54321/functions/v1/submit-playtest-application" `
  -Headers @{ Origin = "http://localhost:5173" } -ContentType "application/json" -Body $body
```

Expected answer: `{"success":true,"applicationId":"HEX-PT-…"}`. Send it twice and the second
answer is a `409` duplicate. Swap the URL for `https://YOUR-PROJECT-REF.supabase.co/...` to test
the hosted function.

---

## 2. Create the Supabase project

1. Sign in at <https://supabase.com/dashboard> → **New project**.
   - Organization: yours. Name: `hexenbane-playtest`.
   - **Database password**: generate one and save it in your password manager. You need it once
     for `supabase link`.
   - Region: the one closest to most of your testers. Plan: Free is enough.
   - **Create new project** and wait a minute or two.
2. **Find the project URL and public key.** Click **Connect** at the top of the project (or
   **Project Settings → Data API / API Keys**):
   - **Project URL**: `https://abcdefghijklmnop.supabase.co`. The part before `.supabase.co` is
     your **project ref**. The URL goes into `VITE_SUPABASE_URL`.
   - **Publishable key** (`sb_publishable_…`) or legacy **anon** key: safe to expose, but this
     site doesn't need it. Only set `VITE_SUPABASE_ANON_KEY` if you turn JWT verification on.
   - The **secret** / **service_role** key: don't copy it anywhere. The Edge Function receives
     it automatically.
3. **Link this repository to the project and run the migrations** (from the repo root):

   ```bash
   npx supabase login                               # opens the browser once
   npx supabase link --project-ref YOUR-PROJECT-REF # asks for the database password
   npx supabase db push                             # creates the tables, RLS and triggers
   ```

   Check it: Dashboard → **Table Editor** shows `playtest_applications` and
   `playtest_agreement_versions`, both marked **RLS enabled**. Optional extra check: Dashboard →
   **SQL Editor** → paste all of `supabase/tests/security_checks.sql` → **Run**. It ends with
   `ALL DATABASE CHECKS PASSED` and rolls itself back, leaving no data behind.
4. **Set the secrets** (next section), then **deploy the Edge Function**:

   ```bash
   npx supabase functions deploy submit-playtest-application
   ```

   `supabase/config.toml` deploys it with JWT verification **off**, because the public website
   calls it without a logged-in user. The function protects itself instead (validation, CORS,
   honeypot, duplicate protection, optional CAPTCHA). You'll see it under Dashboard → **Edge
   Functions**, with its URL:
   `https://YOUR-PROJECT-REF.supabase.co/functions/v1/submit-playtest-application`.
5. **Allowed frontend origin.** Browsers may only call the function from origins listed in the
   `ALLOWED_ORIGINS` secret (step 3). For GitHub Pages that is `https://nullconstructor.github.io`
   (origin only: no `/hexenbane-playtest/` path, no trailing slash).

## 3. Configure Supabase secrets

Secrets are set once and read by the function at runtime. Either in the Dashboard: **Edge
Functions → Secrets** (Manage secrets) → add each name and value → Save, or from the terminal:

```bash
npx supabase secrets set DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/…"
npx supabase secrets set ALLOWED_ORIGINS="https://nullconstructor.github.io,http://localhost:5173"
npx supabase secrets list            # shows names and digests, never values
```

| Secret | Required | Value |
| --- | --- | --- |
| `DISCORD_WEBHOOK_URL` | Yes, for notifications | The `#playtest-applications` webhook URL (step 6). Without it, applications are still stored; the function logs that Discord wasn't notified. |
| `ALLOWED_ORIGINS` | Yes | Comma-separated origins allowed to submit. Without it, only `localhost` works. |
| `TURNSTILE_SECRET_KEY` | No | Turns on the Cloudflare Turnstile check (see anti-spam). |
| `DISCORD_BUG_REPORTS_WEBHOOK_URL` | Yes, for the game's reports | The `#bug-reports` forum webhook ([section 13](#13-game-telemetry-crash-reports-and-f8-reports)). Without it crashes are only stored and every F8 report answers "not delivered". |
| `DISCORD_BUG_REPORTS_TAGS` | No | `#bug-reports` tag ids as JSON, from `npm run discord -- --forum-tags`. Without it posts are untagged. |
| `RATE_LIMIT_IP_SALT` | Yes, for the game's endpoints | A long random string that salts the hashed IPs used for per-IP rate limits. Without it only the per-install limits apply. |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided automatically; don't set them.
Secrets apply immediately to new requests; no redeploy needed.

**These values must NEVER go into GitHub Pages, `VITE_` variables, GitHub repository variables
or any committed file.**

## 4. Configure the Discord application and bot

Full walkthrough with screenshots-in-words: **[discord/README.md](discord/README.md)**. In short:

1. <https://discord.com/developers/applications> → **New Application** → `Hexenbane Setup`.
2. **Bot** → **Reset Token** → copy it into `discord/.env` as `DISCORD_BOT_TOKEN`. Turn **Public
   Bot** off. **Privileged Gateway Intents: leave all off** (the script uses only the
   non-privileged Guilds intent).
3. **`DISCORD_GUILD_ID`**: Discord → User Settings → Advanced → **Developer Mode** on →
   right-click the Hexenbane server icon → **Copy Server ID**.
4. **Invite with least privilege**: `npm run discord -- --invite-url` prints an OAuth2 URL
   (`scope=bot`) with exactly the permissions the layout needs, never Administrator. Open it,
   choose the Hexenbane server, authorise.
5. **Server Settings → Roles**: drag the `Hexenbane Setup` role to the top (just under yours).

## 5. Provision the Discord server

```bash
cp discord/.env.example discord/.env        # PowerShell: Copy-Item discord/.env.example discord/.env
# fill in DISCORD_BOT_TOKEN and DISCORD_GUILD_ID
npm run discord                              # dry run: prints every change, changes nothing
npm run discord -- --apply                   # makes the changes, then re-checks the server
```

What happens on `--apply`, in order:

1. `@everyone` loses **Mention @everyone, @here and All Roles**.
2. The roles Developer, Playtest Manager, Moderator, Artist, Composer, Playtester, Early
   Supporter and Hunter are created (if missing) and ordered under the bot's role.
3. The categories START HERE, THE CHAPTER HOUSE, DEVELOPMENT, PLAYTEST OPERATIONS, PRIVATE
   PLAYTEST, INTERNAL DEVELOPMENT and VOICE are created with their permissions.
4. Each channel is created inside them; an existing channel with the same name (such as the
   default `#general`) is moved in instead of duplicated. Forum channels get their tags.
5. The script reads the server back and confirms it matches `discord/server-config.ts`.

It never deletes, renames or edits anything it doesn't manage. Run it again any time; it only
does what's missing. Afterwards, kick the bot or strip its permissions (see
[discord/README.md](discord/README.md#5-after-setup-reduce-or-remove-the-bot)).

## 6. Configure the Discord webhook

After `#playtest-applications` exists:

1. In Discord, hover `#playtest-applications` → **⚙ Edit Channel** → **Integrations** →
   **Webhooks** → **New Webhook** (or **Create Webhook**).
2. Name it `Playtest Applications` (the embed also sets this name). Check the channel is
   `#playtest-applications`.
3. **Copy Webhook URL** → **Save Changes**.
4. Store it **only** as a Supabase secret:

   ```bash
   npx supabase secrets set DISCORD_WEBHOOK_URL="paste-it-here"
   ```

**NEVER put the webhook URL in the website's JavaScript, a `VITE_` variable or Git.** Anyone with
it can post into your staff channel. If it leaks: delete the webhook in the same menu, create a
new one, and update the secret.

## 7. Configure the Discord invite

1. Right-click `#welcome` (so new people land there) → **Invite People** → **Edit invite link**.
2. **Expire after: Never**. **Max number of uses: No limit**. Leave "Grant temporary membership"
   off. **Generate a New Link** → copy it (`https://discord.gg/…`).
3. Put it in the site's public configuration:
   - Locally: `VITE_DISCORD_INVITE_URL=` in `site/.env.local`.
   - Live site: GitHub repository variable `VITE_DISCORD_INVITE_URL` (step 8).

Every Discord button on the site (hero, form, success screen, footer) uses this one value.

## 8. GitHub Pages deployment

The workflow `.github/workflows/deploy-pages.yml` builds and publishes the site whenever `main`
changes. One-time setup:

1. **Push the repository** (already done if you're reading this on GitHub). The repository must
   be **public** for free GitHub Pages.
2. **Enable Pages with GitHub Actions as the source:** repository → **Settings → Pages** →
   **Build and deployment → Source: GitHub Actions**. (No branch to pick; the workflow uploads the
   site.)
3. **Add the public configuration as repository *variables*:** **Settings → Secrets and
   variables → Actions → Variables tab → New repository variable**:

   | Name | Value |
   | --- | --- |
   | `VITE_SUPABASE_URL` | `https://YOUR-PROJECT-REF.supabase.co` |
   | `VITE_DISCORD_INVITE_URL` | `https://discord.gg/…` |
   | `VITE_SUPABASE_ANON_KEY` | optional, leave unset |
   | `VITE_TURNSTILE_SITE_KEY` | optional |
   | `SITE_BASE_PATH` | optional; only for a custom domain (`/`) |
   | `SITE_URL` | optional; only for a custom domain (`https://play.example.com/`) |

   Variables, not secrets: they're public anyway. The build fails with a clear message if
   `VITE_SUPABASE_URL` or `VITE_DISCORD_INVITE_URL` is missing. **No repository secrets are
   needed**, and none of the server secrets belong here.
4. **Run it:** **Actions → Deploy site to GitHub Pages → Run workflow** (or push to `main`).
   When it's green, the deploy job shows the URL:
   **<https://nullconstructor.github.io/hexenbane-playtest/>**.
5. Add that origin to `ALLOWED_ORIGINS` (step 3) if you haven't: `https://nullconstructor.github.io`.

**Base path.** Project pages live under `/<repository-name>/`, not `/`. The workflow builds with
`BASE_PATH=/<repository-name>/` automatically, and every asset, image and font URL uses it (the
checks workflow verifies this). If you rename the repository, it follows. For a custom domain
served at the root, set `SITE_BASE_PATH` to `/`.

---

## AUTOMATICALLY CONFIGURED

Done for you by `npm run discord -- --apply`:

- [x] Roles: Developer, Playtest Manager, Moderator, Artist, Composer, Playtester, Early
      Supporter, Hunter, in that order, with minimal permissions (no Administrator anywhere).
- [x] `@everyone` can no longer mention @everyone, @here or all roles.
- [x] Seven categories and their channels, forum channels for `#suggestions`, `#bug-reports`
      and `#playtest-feedback` with tags, announcement channel for `#announcements`, topics,
      slowmode on `#suggestions` and `#screenshots-and-clips`.
- [x] Read-only channels: `#welcome`, `#rules-and-info`, `#announcements`, `#faq`,
      `#dev-updates`, `#patch-notes` (Developer posts), `#known-issues` (Developer and Playtest
      Manager), `#playtest-info`, `#build-downloads`, `#playtest-announcements` (Developer and
      Playtest Manager post; testers read).
- [x] PLAYTEST OPERATIONS hidden from everyone except Developer and Playtest Manager.
- [x] PRIVATE PLAYTEST (and the Playtest Session voice room) visible only to Playtester,
      Developer, Playtest Manager and Moderator.
- [x] INTERNAL DEVELOPMENT (and Dev Room) visible only to Developer, Artist and Composer.
- [x] Moderation rights (delete messages, manage threads) per area; none for Artist, Composer,
      Playtester, Early Supporter or Hunter.

## MANUAL DISCORD SETTINGS YOU MUST CONFIGURE

Discord doesn't let a bot change these safely, or at all, so the script doesn't pretend to.
Menu names are current as of October 2026; Discord moves things occasionally.

**Community (Server Settings → Community / Overview)**
- [ ] **Rules or Guidelines Channel** → `#rules-and-info`.
- [ ] **Community Updates Channel** (Discord's notices to admins) → `#playtest-admin`.
- [ ] Then delete the placeholder `#rules` and `#moderator-only` channels Community mode
      created, and the empty default `Text Channels` / `Voice Channels` categories and the
      `General` voice channel if you don't want them. The script never deletes.
- [ ] Drag the categories into order if START HERE isn't at the top (new categories are added at
      the bottom; the script doesn't reorder things it didn't create).

**Safety Setup (Server Settings → Safety Setup)**
- [ ] **Verification level: Medium** (account older than 5 minutes) or **High** (member for 10
      minutes) if you get raids.
- [ ] **Explicit image filter**: filter messages from **all members**.
- [ ] **Require 2FA for moderator actions**: on.
- [ ] **Raid protection / DM spam detection**: on; alerts to `#playtest-admin`.
- [ ] **Rules screening** (members must accept the rules before talking): on, with the same
      rules as `#rules-and-info`.

**AutoMod (Server Settings → AutoMod)**
- [ ] **Block Mention Spam**: on, limit **5** mentions per message, block and time out.
- [ ] **Block Suspected Spam Content**: on.
- [ ] **Block Commonly Flagged Words**: on (pick the lists that suit you).
- [ ] **Custom keyword rule** "Scam links": block messages containing `free nitro`, `nitro
      gift`, `steamcommunnity`, `steamcomunity`, `discord-gift`, `discordgift` (extend as scams
      appear). Exempt Developer and Moderator.
- [ ] Send AutoMod alerts to `#playtest-admin`.

**Notifications (Server Settings → Overview)**
- [ ] **Default Notification Settings: Only @mentions** (essential for a growing community).

**Onboarding and Server Guide (Server Settings → Onboarding)**
- [ ] **Default channels**: `#welcome`, `#rules-and-info`, `#announcements`, `#faq`, `#general`,
      `#dev-updates`.
- [ ] **Customisation question** (optional): "What brings you to Hexenbane?" with answers like
      *Following development*, *Interested in the playtest*. Assign the **Hunter** role to every
      answer and mark the question required if you want everyone to get Hunter automatically.
- [ ] **Server Guide**: a welcome message; to-dos "Read the rules" (`#rules-and-info`), "Read
      the FAQ" (`#faq`), "Say hello" (`#general`); resource pages for `#rules-and-info` and
      `#faq`.
- [ ] Never offer **Playtester** in onboarding: it's only given by you, by hand.

**Who can do what (Server Settings → Roles → @everyone)**
- [ ] **Mention @everyone**: already removed by the script; leave it off for @everyone and
      Hunter. Developer has it.
- [ ] **Create Invite**: recommended **off** for @everyone, so the one invite from step 7 is
      the way in. (Or leave on if you want members to invite friends.)
- [ ] **Manage Webhooks**: no role should have it. Only you, the owner, can create webhooks, and
      each webhook URL is a secret.
- [ ] **Media**: Attach Files and Embed Links stay on for @everyone in chat channels; AutoMod
      catches scam links. Turn them off per channel if spam appears.

**Your own setup**
- [ ] Write the content of `#welcome`, `#rules-and-info`, `#faq` and `#playtest-info` (test
      goals, the confidentiality reminder, how to report bugs: one problem per post in
      `#bug-reports` with build, steps and hardware).
- [ ] Remove or defang the setup bot ([discord/README.md](discord/README.md#5-after-setup-reduce-or-remove-the-bot)).

---

## HOW YOU RECEIVE PLAYTEST REQUESTS

### PRIMARY METHOD — DISCORD

Every valid submission creates an embed in **`#playtest-applications`** (visible only to
Developer, Playtest Manager and you). It looks like this:

```text
┃ Hexenbane Playtest                                            APP
┃ PLAYTEST APPLICATION
┃ HEX-PT-7KQ3XM
┃ Find it in Supabase → Table Editor → playtest_applications → public_application_id.
┃
┃ Application        Discord             Applicant
┃ HEX-PT-7KQ3XM      wren.hunter         Wren
┃
┃ Why they're interested
┃ I love gothic horror and deckbuilders, and the duel system looks…
┃ Relevant games
┃ Slay the Spire, Inscryption, Darkest Dungeon
┃ Experience
┃ 400 hours of roguelikes; tested two indie games on itch.io
┃ Hardware
┃ CPU Ryzen 5 5600 · GPU RTX 3060 · RAM 16 GB · OS Windows 11
┃
┃ Backup email       Agreement                               Submitted
┃ Not given          Accepted — HEXENBANE-PLAYTEST-2026-10-v1   2026-10-06 21:14:03 UTC
┃
┃ Status
┃ PENDING
┃ Hexenbane Private Playtest · approval is manual        Today at 16:14
```

Applicant text is shown literally: mentions are disabled (`allowed_mentions: { parse: [] }`)
and neutralised, so nobody can ping @everyone, a role or a user through the form, or sneak in
links or formatting. Long answers are cut to fit Discord's limits; the full text is in Supabase.

The embed is a copy. Its "PENDING" never changes; the live status is in Supabase.

If Discord is down or the webhook is wrong, the application is **still saved** and the applicant
still sees success. Those rows have an empty `discord_notified_at`, and the function log
(Dashboard → Edge Functions → submit-playtest-application → Logs) says why.

### SECONDARY/AUTHORITATIVE METHOD — SUPABASE

**Supabase Dashboard → Table Editor → `playtest_applications`.** Each row is one application:

| You want | Column |
| --- | --- |
| Application ID (what the applicant and the embed show) | `public_application_id` |
| Applicant | `preferred_name` |
| Discord username, as typed / normalised | `discord_username` / `discord_username_normalized` |
| Their answers | `interest_reason`, `similar_games`, `testing_experience`, `additional_notes` |
| Hardware | `cpu`, `gpu`, `ram`, `operating_system` |
| Backup contact | `email` (often empty) |
| Agreement acceptance | `agreement_accepted` (always true), `agreement_version`, `agreement_hash`, `agreement_accepted_at` |
| When submitted | `created_at` (UTC) |
| Status | `status`: pending, contacted, approved, rejected, withdrawn |
| Your notes | `internal_notes` |
| Review times | `contacted_at`, `reviewed_at` |
| Did Discord get it? | `discord_notified_at` |

Find an application: click **Filter → public_application_id → equals → HEX-PT-7KQ3XM**, or sort
by `created_at`. Double-click a long cell to read it all.

**Change the status** (pending → contacted → approved, or pending → rejected): double-click the
`status` cell, type the new value, press Enter (or open the row with the expand icon and edit
it there, then **Save**). Only the five statuses are accepted. When status first becomes
`contacted` (or `approved`), `contacted_at` fills itself; when it first becomes `approved` or
`rejected`, `reviewed_at` fills itself. `updated_at` always tracks the last edit. Add context in
`internal_notes`.

Some things are locked on purpose: the application ID, creation time and agreement fields can't
be edited, and agreement versions can't be changed or deleted.

Handy queries (Dashboard → **SQL Editor**):

```sql
-- Waiting for review, oldest first
select public_application_id, preferred_name, discord_username, created_at
from playtest_applications where status = 'pending' order by created_at;

-- Applications Discord didn't announce
select public_application_id, created_at from playtest_applications where discord_notified_at is null;

-- Who accepted which agreement
select agreement_version, count(*) from playtest_applications group by agreement_version;
```

A rejected or withdrawn applicant can apply again; someone with a pending, contacted or approved
application can't submit a second one for the same Discord username.

## 10. Approving a tester

1. **Review the application** in `#playtest-applications`, and in Supabase for full answers.
2. **Confirm the applicant is in Discord**: search the member list for their username (shown in
   the embed). Not there? Leave it `pending`, or contact them by the backup email if they gave one.
3. **Message the applicant** directly on Discord. Set the row's `status` to `contacted`.
4. **Assign the Playtester role**: right-click their name → **Roles** → tick **Playtester**.
5. **The PRIVATE PLAYTEST category becomes visible** to them immediately.
6. **Provide the build through `#build-downloads`**: post the file or link there (only
   Developer and Playtest Manager can post; testers can only read). Point them to `#playtest-info`.
7. **Update the application status** in Supabase to `approved` (and add `internal_notes`).

To remove a tester: take away the Playtester role (the category disappears for them), and set
their status to `withdrawn` with a note.

## 11. Updating the agreement

The agreement's text lives in **`legal/playtest-agreement-v1.md`**; which version applicants
accept is set by **`legal/current.json`**. Every application stores the exact version and the
SHA-256 of its text, and the database keeps the full text of every version ever accepted (in
`playtest_agreement_versions`, which refuses edits and deletes).

**Never edit a published agreement file.** `npm run agreement:check` (and CI) fails if a
published version's text changes, and the database refuses a version whose text differs from
what it recorded. To release v2:

1. Copy `legal/playtest-agreement-v1.md` to `legal/playtest-agreement-v2.md`. Leave v1 untouched.
2. In v2, change the front matter and the last line to the new version and date, then edit the
   text:

   ```yaml
   ---
   version: HEXENBANE-PLAYTEST-2026-11-v2
   effective: 2026-11-01
   ---
   ```

3. Point `legal/current.json` at it: `"current": "playtest-agreement-v2.md"`.
4. Run `npm run agreement:sync`. It adds v2 to `legal/agreement-ledger.json` (v1 stays) and
   regenerates `supabase/functions/_shared/agreement.generated.ts`.
5. Commit, open a PR, review the diff.
6. Deploy the function: `npx supabase functions deploy submit-playtest-application`. From now on
   new applications record v2.
7. Merge the PR so the website shows the v2 text (the Pages workflow deploys it).

Old applications keep `HEXENBANE-PLAYTEST-2026-10-v1` and its hash forever, and the v1 text
stays in both `legal/` and the database. Existing testers don't automatically accept v2; if
you need them to, ask them in Discord and note it in `internal_notes`.

> **This agreement was not written or reviewed by a lawyer.** It is plain-English and adequate
> for a small private test. If you ever need stronger contractual protection, have a lawyer
> review it and release their version as a new agreement version. See `legal/README.md`.

## 12. Updating the website

| To change | Edit |
| --- | --- |
| Logo | Put the image in `site/public/media/` and set `site.logo` in `site/src/content.ts` (e.g. `"media/logo.png"`). Leave `null` for the HEXENBANE wordmark. |
| Hero background | Replace `site/public/media/hero-keyart.svg` (or set `site.heroArt`). Wide, dark at the bottom. |
| Screenshots | Drop images in `site/public/media/` and update `gallery.screenshots` in `content.ts` (path, alt text, caption). 16:9, ideally 1920×1080. Real in-game shots: e.g. the main menu, a duel, the Trail map and a Reckoning. |
| Game description, tagline, playtest info, tester asks | `about`, `hero`, `playtest`, `testers` in `content.ts` |
| FAQ | `faq.items` in `content.ts` |
| Discord invite | `VITE_DISCORD_INVITE_URL` (GitHub variable; `site/.env.local` locally) |
| Social links (footer) | `socialLinks` in `content.ts`; empty `url` hides a link |
| Link preview image | `site/public/media/social-card.png` (1200×630) |
| Agreement | `legal/` (see section 11), never the website |
| Colours, fonts, spacing | `site/src/styles/tokens.css`; fonts in `site/src/styles/fonts.css` |
| Form questions and limits | `site/index.html` (fields) + `supabase/functions/_shared/application.ts` (rules, shared by site and server) + a new migration for any new column |

Fonts: the site uses three free (SIL Open Font License) fonts bundled from npm: *Jacquard 24* (a
pixel blackletter standing in for the game's Kingdom), *Pixelify Sans* for labels and *Crimson
Pro* for text (standing in for Eternity). Once you've confirmed Kingdom and Eternity may be used
on the web, follow the three steps at the top of `fonts.css`.

Every change merged to `main` redeploys the site within a couple of minutes.

## 13. Game telemetry, crash reports and F8 reports

Three more Edge Functions are called by the game itself (not the website):

| Function | The game sends | Stored in | Discord |
| --- | --- | --- | --- |
| `ingest-telemetry` | batches of gameplay events | `telemetry_events` | never |
| `submit-crash` | a crash or script error with the log tail | `crash_reports` (+ `crash_signatures`) | the **first** report of each crash per version, as a `#bug-reports` post with `crash-log.txt` |
| `submit-feedback` | the F8 report form: title, details, screenshot, log | `feedback_reports` (no screenshot or log) | every report, as a `#bug-reports` post with `screenshot.jpg` and `game-log.txt` |

The game finds them through one setting in its `project.godot`:

```ini
[hexenbane]
backend_url="https://YOUR-PROJECT-REF.supabase.co/functions/v1"
```

(no trailing slash; the game appends `/ingest-telemetry`, `/submit-crash`, `/submit-feedback`).

### Deploy (you do this; nothing deploys automatically)

1. **Apply the migration** (creates the tables, rate limits and views):

   ```bash
   npx supabase db push
   ```

   Then, optionally, SQL Editor → paste all of `supabase/tests/security_checks.sql` → **Run** →
   `ALL DATABASE CHECKS PASSED` (it rolls itself back).
2. **Create the `#bug-reports` webhook.** `#bug-reports` is a **forum** channel (made by
   `npm run discord -- --apply`). Hover it → **⚙ Edit Channel → Integrations → Webhooks → New
   Webhook** → name it `Hexenbane Bug Reports` → **Copy Webhook URL** → **Save Changes**.
   Store it only as a secret:

   ```bash
   npx supabase secrets set DISCORD_BUG_REPORTS_WEBHOOK_URL="paste-it-here"
   ```

3. **Forum tags (optional).** With the bot still in the server and able to see `#bug-reports`,
   run `npm run discord -- --forum-tags`. It prints something like
   `{"New":"1234…","Crash":"2345…","UI":"3456…","Combat":"4567…"}`. Set it:

   ```bash
   npx supabase secrets set DISCORD_BUG_REPORTS_TAGS='{"New":"1234…","Crash":"2345…","UI":"3456…","Combat":"4567…"}'
   ```

   (In PowerShell, the same single quotes work.) Every post gets **New**; a report of kind
   Crash also gets **Crash**, UI gets **UI**, Balance gets **Combat**; Bug and Other get only New.
   If the bot is gone, skip this or re-invite it (`npm run discord -- --invite-url`).
4. **The IP salt.** Any long random string; never share it or commit it:

   ```bash
   npx supabase secrets set RATE_LIMIT_IP_SALT="$(openssl rand -hex 32)"
   ```

   PowerShell: `npx supabase secrets set "RATE_LIMIT_IP_SALT=$([guid]::NewGuid().ToString('N'))$([guid]::NewGuid().ToString('N'))"`
5. **Deploy the three functions** (`supabase/config.toml` already turns JWT verification off for
   them; the game has no logged-in user, so each function validates and rate-limits itself):

   ```bash
   npx supabase functions deploy ingest-telemetry
   npx supabase functions deploy submit-crash
   npx supabase functions deploy submit-feedback
   ```

6. **Point the game at them:** set `hexenbane/backend_url` in the game's `project.godot` to
   `https://YOUR-PROJECT-REF.supabase.co/functions/v1`, export a build, press **F8** in game and
   send a test report. A post appears in `#bug-reports` and a row in `feedback_reports`.

### The contract

Every request: `POST`, `Content-Type: application/json`, header `X-Hexenbane-Build: <version>`
(semver-like such as `0.8.0` or `0.8.1-playtest`, at most 32 characters). Errors come back as
`{ "ok": false, "error": "<code>", "message": "…", "fields"?: { "<field>": "<problem>" } }`:

| Status | `error` | Meaning for the game |
| --- | --- | --- |
| 400 | `bad_build`, `invalid_json`, `validation_failed` | Don't retry; the payload is wrong. |
| 405 / 415 | `method_not_allowed` / `unsupported_media_type` | Don't retry. |
| 413 | `too_large` | Don't retry; send less. |
| 429 | `rate_limited` | Retry after the `Retry-After` header (seconds). |
| 500 | `server_error` | Retry later. |
| 502 | `discord_failed` | Feedback only: saved, but not posted to Discord. |

Ids: `install_id` is a random UUID v4 per installation; `session_id` a UUID per game run.
Timestamps are ISO-8601 UTC (`2026-10-08T12:00:00Z`; a bare `2026-10-08T12:00:00` is read as UTC).
The body's `version` is stored; it may differ from the header (a batch queued by an older build).

**`ingest-telemetry`** (body ≤ 512 KB) → `200 { "ok": true, "accepted": n, "duplicates": d }`

```json
{ "install_id": "uuid-v4", "session_id": "uuid", "version": "0.8.0",
  "events": [ { "name": "fight_end", "seq": 12, "at": "2026-10-08T12:00:00Z", "data": { } } ] }
```

1 to 200 events. `name` is one of `session_start`, `session_end`, `hunt_start`, `fight_end`,
`card_offer`, `boss_reward`, `purchase`, `inscription_cut`, `scene_lead`, `hunt_end`,
`feedback_sent`; `seq` a whole number ≥ 0, unique within the session; `data` an object of at most
8 KB as JSON. One bad event refuses the whole batch. Resending a batch is safe: events whose
`(session_id, seq)` is already stored are skipped and counted in `duplicates`.

**`submit-crash`** (body ≤ 384 KB) → `200 { "ok": true, "id": "CR-7KQ3XM", "posted": true|false }`

```json
{ "install_id": "uuid-v4", "session_id": "uuid of the crashed session", "version": "0.8.0",
  "kind": "crash", "message": "…", "stack": "…", "log_tail": "…", "occurred_at": "2026-10-08T12:00:00Z",
  "context": { "os": "…", "gpu": "…", "window": "1920x1080", "scene": "…",
               "coven": "…", "night": 2, "hours": 3, "quarry": "…" } }
```

`kind` is `crash` or `error`; `message` 1–2000 characters; `stack` ≤ 8000 (may be empty);
`log_tail` ≤ 64 KB; `os`, `gpu`, `window`, `scene` required (may be empty strings), the rest
optional. The **signature** is the SHA-256 of version, kind, the message with digits removed and
the first stack line. Only the first report of a signature is posted (`posted: true`); if that post
fails, a later report retries it (at most every 15 minutes). Without the webhook secret, crashes
are only stored.

**`submit-feedback`** (body ≤ 5 MB) → `200 { "ok": true, "id": "BR-7KQ3XM" }` when the
`#bug-reports` post was created, otherwise `502 { "ok": false, "error": "discord_failed", "id": … }`
(the report is still stored; tell the player it was saved but not delivered).

```json
{ "install_id": "uuid-v4", "version": "0.8.0", "kind": "Bug", "title": "…", "details": "…",
  "context": { "version": "0.8.0", "scene": "…", "os": "…", "gpu": "…", "window": "…",
               "time_utc": "2026-10-08T12:00:00Z", "coven": "…", "implements": ["…", "…"],
               "night": 2, "hours": 3, "vitality": 18, "quarry": "…" },
  "screenshot_jpg": "base64 JPEG, optional", "log": "optional" }
```

`kind` is `Bug`, `Crash`, `Balance`, `UI` or `Other`; `title` 1–90 characters (it becomes the
forum post's title); `details` ≤ 4000; the six context keys up to `time_utc` are required;
`screenshot_jpg` is plain base64 (no `data:` prefix) of a real JPEG of at most 3 MB; `log` ≤ 64 KB.
Unknown context keys are dropped.

**Rate limits** (fixed windows; 429 past them):

| Endpoint | Per install | Per IP (salted hash) |
| --- | --- | --- |
| `ingest-telemetry` | 60 requests / 10 min | 300 / 10 min |
| `submit-crash` | 20 / hour | 60 / hour |
| `submit-feedback` | 10 / hour | 30 / hour |

**Privacy.** No IP address is stored or logged: per-IP limits use a salted SHA-256 that is
forgotten after two days. The install id is random and not linked to a person. Screenshots and
game logs go to the `#bug-reports` post only (logs can contain Windows user names in file paths;
`#bug-reports` is private to testers and staff); crash reports keep their log tail in
`crash_reports.log_tail`.

### Reading the data

Dashboard → **SQL Editor**. The views are not reachable with the public keys.

```sql
-- Which quarries are too hard? (Hunt-mode fights only)
select * from quarry_balance order by quarry, night;

-- Cards nobody picks, and cards that win
select * from card_stats where offered >= 20 order by pick_rate;
select * from card_stats where fights_played_in >= 20 order by win_rate_when_played desc;

-- Coven + implement pairs (hunt_start joined to hunt_end by session_id + hunt_id)
select * from implement_pairs where hunts >= 5 order by win_rate desc;

-- What kills hunters, and when
select * from death_causes order by deaths desc;

-- Crashes, most common first
select * from crash_summary order by reports desc;

-- F8 reports that never reached Discord
select report_id, kind, title, received_at from feedback_reports where not discord_ok order by received_at desc;

-- Everything one install sent (the 8-character prefix is in each post's footer)
select * from telemetry_events where install_id::text like '3f2b8c1e%' order by occurred_at;
```

The views cover every version; to look at one build, query `telemetry_events` with
`where version = '0.8.0'`, or copy a view's definition and add that filter. `card_stats` counts
plays and wins from Hunt-mode fights only (lab fights are left out), like `quarry_balance`.

---

## Anti-spam, and adding a CAPTCHA later

Built in, with no tracking and no personal data:

- **Honeypot**: a hidden `website` field people never see; bots that fill it are rejected.
- **Minimum fill time**: submissions within 3 seconds of the page loading are rejected.
- **Strict server-side validation**: types, required fields, length limits, Discord username
  format, email format, a 32 KB body limit, and stripping of control and invisible characters.
- **Duplicate protection**: one open application per normalised Discord username, enforced by
  a database unique index.
- **CORS**: only your site's origin may call the function from a browser.
- No IP addresses or fingerprints are stored.

**Cloudflare Turnstile** is already wired in and off. To turn it on: create a Turnstile widget
at <https://dash.cloudflare.com> → Turnstile (hostname `nullconstructor.github.io`, plus
`localhost` for testing), then set the **site key** as GitHub variable
`VITE_TURNSTILE_SITE_KEY` and the **secret key** as Supabase secret `TURNSTILE_SECRET_KEY`.
Another provider: implement `CaptchaVerifier` in `supabase/functions/_shared/captcha.ts`.

## Checks and tests

```bash
npm run verify        # agreement check, type-checks, unit tests, build, secret scan
npm test              # unit tests only
npm run discord -- --matrix   # who can see and post in each Discord channel
npm run function:check        # type-check the Edge Functions (needs Deno: https://deno.com)
npm run test:e2e              # real database test (needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY set,
                              # e.g. from `npx supabase status` with local Supabase running)
```

The unit tests cover form validation, the Discord embed (mention safety, size limits), the
function handler (CORS, methods, honeypot, duplicate, agreement fields set by the server,
Discord failure still saving) and the Discord layout (who can see what, a dry run that changes
nothing twice, never touching unknown channels), and the game endpoints (validation, rate limits,
crash signatures, mention safety, the multipart forum post, Discord failures).
`supabase/tests/security_checks.sql` checks the database (no public access, frozen agreement
evidence, status rules, the game tables, rate limits and views); the checks workflow runs it on a
fresh Postgres for every pull request. `npm run test:e2e` also runs `supabase/tests/game-e2e.test.ts`.

## Extending it later

- **A management bot** (slash commands to approve testers, sync status back to Supabase) can
  reuse `discord/server-config.ts` for role and channel names and query
  `playtest_applications` with the service role from a server you control.
- **An admin page** would read through a new authenticated Edge Function or RLS policies tied to
  Supabase Auth; the table's current "no public access" setup stays the default.
- **Steam Playtest**: approved rows are your list; add a column for the Steam key or account
  in a new migration.
