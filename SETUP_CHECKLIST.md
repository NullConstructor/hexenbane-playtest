# Setup checklist: from nothing to your first real application

Tick these off top to bottom. Each line links to the README section with the details. Order
matters in two places: the Discord channel must exist before you can make its webhook, and the
Pages URL must be in `ALLOWED_ORIGINS` before the live form can submit.

## A. Before you start

- [ ] Node.js 22.12+ installed (`node -v`).
- [ ] Repository cloned, then `npm install` at its root.
- [ ] `npm run verify` passes (typecheck, tests, agreement hash, build, secret scan).
- [ ] **Have a lawyer review** [`legal/playtest-agreement-v1.md`](legal/playtest-agreement-v1.md).
      It is a plain-language starting point, not legal advice. If they change it, follow
      [README §11](README.md#11-updating-the-agreement) *before* anyone applies.

## B. Supabase ([README §2–3](README.md#2-create-the-supabase-project))

- [ ] Create the Supabase project `hexenbane-playtest`; save the database password.
- [ ] Note the **project ref** and **Project URL** (`https://<ref>.supabase.co`).
- [ ] `npx supabase login`
- [ ] `npx supabase link --project-ref <ref>`
- [ ] `npx supabase db push`
- [ ] Table Editor shows `playtest_applications` and `playtest_agreement_versions`, both **RLS
      enabled**.
- [ ] (Optional) SQL Editor → run `supabase/tests/security_checks.sql` → `ALL DATABASE CHECKS PASSED`.
- [ ] `npx supabase secrets set ALLOWED_ORIGINS="https://nullconstructor.github.io,http://localhost:5173"`
- [ ] `npx supabase functions deploy submit-playtest-application`

## C. Discord server ([README §4–5](README.md#4-configure-the-discord-application-and-bot), [discord/README.md](discord/README.md))

- [ ] Developer Portal: create the `Hexenbane Setup` application and bot; Public Bot **off**;
      all privileged intents **off**; copy the token.
- [ ] `cp discord/.env.example discord/.env`; fill `DISCORD_BOT_TOKEN` and `DISCORD_GUILD_ID`.
- [ ] `npm run discord -- --invite-url` → open the link → add the bot to the Hexenbane server.
- [ ] Server Settings → Roles: drag `Hexenbane Setup` to the top, just under your own role.
- [ ] `npm run discord` (dry run) → read the plan.
- [ ] `npm run discord -- --apply` → ends with the server matching the config.
- [ ] `npm run discord -- --matrix` → spot-check who sees what.
- [ ] Give yourself the **Developer** role (and anyone helping you **Playtest Manager**).
- [ ] Kick the bot, or strip its role down to View Channels.
- [ ] Work through [MANUAL DISCORD SETTINGS YOU MUST CONFIGURE](README.md#manual-discord-settings-you-must-configure)
      (Community, rules screening, verification level, AutoMod, notifications, onboarding,
      invites, webhooks audit).

## D. Webhook and invite ([README §6–7](README.md#6-configure-the-discord-webhook))

- [ ] `#playtest-applications` → Edit Channel → Integrations → Webhooks → New Webhook → copy URL.
- [ ] `npx supabase secrets set DISCORD_WEBHOOK_URL="<that URL>"` (nowhere else, ever).
- [ ] Create a never-expiring, unlimited invite to `#welcome`; copy the `https://discord.gg/…` link.

## E. Try it locally (optional, recommended)

- [ ] `cp site/.env.example site/.env.local`; set `VITE_SUPABASE_URL` to your project URL and
      `VITE_DISCORD_INVITE_URL` to the invite.
- [ ] `npm run dev` → <http://localhost:5173> → submit a test application with your own Discord name.
- [ ] The embed appears in `#playtest-applications` and the row in Table Editor.
- [ ] Delete the test row (Table Editor → row → Delete), so your real application isn't
      blocked as a duplicate.

## F. GitHub Pages ([README §8](README.md#8-github-pages-deployment))

- [ ] Repository is **public**.
- [ ] Settings → Pages → Source: **GitHub Actions**.
- [ ] Settings → Secrets and variables → Actions → **Variables**: `VITE_SUPABASE_URL`,
      `VITE_DISCORD_INVITE_URL`. (No secrets.)
- [ ] Actions → **Deploy site to GitHub Pages** → Run workflow → green.
- [ ] Open <https://nullconstructor.github.io/hexenbane-playtest/>: images, fonts and both
      Discord buttons work; the agreement opens and shows `HEXENBANE-PLAYTEST-2026-10-v1`.

## G. First real application

- [ ] On the live site, try to submit without ticking the agreement: the form refuses and points at the agreement.
- [ ] Submit a complete application: you see **APPLICATION RECEIVED** with a `HEX-PT-XXXXXX` ID.
- [ ] `#playtest-applications` shows the embed with the same ID and **Status: PENDING**; nobody
      was pinged.
- [ ] Supabase Table Editor → `playtest_applications`: the row has `agreement_accepted = true`,
      the version, the hash and `discord_notified_at` set.
- [ ] Submitting again with the same Discord username is refused as a duplicate.
- [ ] Delete that test row, swap in real screenshots ([README §12](README.md#12-updating-the-website)),
      and share the link.

When a real application arrives, follow [README §10, Approving a tester](README.md#10-approving-a-tester).
