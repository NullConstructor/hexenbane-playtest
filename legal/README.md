# Private Playtest Agreement

> **Warning: this agreement was not written or reviewed by a lawyer.**
> It is a plain-English statement of what testers agree to, good enough for a
> small private playtest. If you ever need stronger contractual protection
> (paid testers, studios, publishers, a leak you want to act on, testers in
> other countries), have a lawyer review it and publish their version as a new
> agreement version.

## Where things live

| File | What it is |
| --- | --- |
| `legal/playtest-agreement-v1.md` | The text of v1. **Never edit it after it is published.** |
| `legal/playtest-agreement-v2.md` | The text of v2 (adds "Data and privacy"). Applicants accept it from Oct 8 2026. |
| `legal/privacy-policy-v1.md` | The playtest Privacy Policy: the application, the game's telemetry, crash reports and F8 reports. Shown in the site's Privacy Policy dialog. Publish changes as a new file. |
| `legal/current.json` | Which file applicants accept right now. |
| `legal/agreement-ledger.json` | Generated record of every version and its SHA-256 hash. Committed, never hand-edited. |
| `supabase/functions/_shared/agreement.generated.ts` | Generated copy the Edge Function and the website both import. Never hand-edited. |

## How the version and hash work

Each agreement file starts with front matter naming its version, for example
`HEXENBANE-PLAYTEST-2026-10-v1`. `npm run agreement:sync` reads the current
file, normalises its line endings, and computes the SHA-256 of the text below
the front matter. That pair (version, hash) is what Supabase records against
every application, together with `agreement_accepted = true` and the UTC time.

The browser never chooses the version: the Edge Function attaches the version
and hash compiled into it. The first time a version is used, the Edge Function
stores its full text in the `playtest_agreement_versions` table, which refuses
updates and deletes, so the exact words each tester accepted stay on record.

`npm run agreement:check` (run by CI and by `npm run verify`) fails if:

- the generated file is out of date with the agreement text;
- a version already in the ledger now has a different hash, meaning someone
  edited a published agreement instead of releasing a new version.

See "Updating the agreement" in the root README for the step-by-step release
of v2.
