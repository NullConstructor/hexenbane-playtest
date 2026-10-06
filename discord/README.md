# Hexenbane Discord server setup

A local, one-time (and safely rerunnable) script that turns your existing Hexenbane Community
server into the layout in [`server-config.ts`](server-config.ts): roles, categories, channels,
forum tags and channel permissions.

It is **not** a bot that stays online. It logs in, makes the changes, prints a report and exits.
Nothing about the playtest workflow depends on it after that.

## What it will and won't do

| It will | It won't |
| --- | --- |
| Create missing roles, categories, channels and forum tags | Delete or rename any channel, role or tag |
| Move an existing channel with a matching name (e.g. the default `#general`) into its category | Touch channels or roles that aren't in `server-config.ts` |
| Set the permission overwrites for `@everyone`, its own roles and itself on the channels it manages | Change overwrites for any other role or member |
| Remove **Mention @everyone** from `@everyone` | Give anyone Administrator |
| Keep its roles in config order, below its own role | Change server settings (verification, AutoMod, onboarding, Community) |
| Report roles whose permissions drifted | Change a drifted role unless you pass `--fix-role-permissions` |

Every run starts as a **dry run** that only prints what it would do. Nothing changes without
`--apply`. After applying, it re-reads the server and confirms everything matches.

## Commands

Run these from the repository root (Node 22+).

```bash
npm run discord                       # dry run (safe; changes nothing)
npm run discord -- --apply            # make the changes
npm run discord -- --invite-url       # bot invite link with exactly the permissions needed
npm run discord -- --matrix           # table of who can see and post in every channel
npm run discord -- --apply --fix-role-permissions   # also reset drifted role permissions
```

## 1. Create the bot (Discord Developer Portal)

1. Open <https://discord.com/developers/applications> and sign in with the account that owns
   the Hexenbane server.
2. **New Application** → name it `Hexenbane Setup` → accept the terms → **Create**.
3. Left menu → **Bot**.
   - **Reset Token** → copy the token. This is `DISCORD_BOT_TOKEN`. Treat it like a password:
     anyone with it controls the bot. It is shown once; if you lose it, reset it again.
   - Turn **Public Bot** off (only you should be able to add it to servers).
   - **Privileged Gateway Intents**: leave all three **off**. The script only uses the
     non-privileged *Guilds* intent: it never reads messages or member lists.
4. Copy the token into `discord/.env`:

   ```bash
   cp discord/.env.example discord/.env      # PowerShell: Copy-Item discord/.env.example discord/.env
   ```

   ```ini
   DISCORD_BOT_TOKEN=paste-the-token-here
   DISCORD_GUILD_ID=
   ```

## 2. Find your server ID (`DISCORD_GUILD_ID`)

1. Discord → **User Settings** (cog) → **Advanced** → turn on **Developer Mode**.
2. Right-click the Hexenbane server icon → **Copy Server ID**.
3. Paste it as `DISCORD_GUILD_ID` in `discord/.env`.

## 3. Invite the bot with least privilege

```bash
npm run discord -- --invite-url
```

Open the printed URL, pick the Hexenbane server and authorise. The URL asks for exactly these
permissions and nothing else (no Administrator):

| Permission | Why the script needs it |
| --- | --- |
| Manage Roles | Create the roles; set channel permission overwrites; edit `@everyone` |
| Manage Channels | Create and move categories and channels; add forum tags |
| View Channel, Read Message History, Connect | See the channels it manages (including voice) |
| Send Messages, Send Messages in Threads, Create Public/Private Threads | It sets these as allow/deny on read-only channels |
| Manage Messages, Manage Threads | It grants these to moderating roles on channels |
| Kick, Ban, Timeout (Moderate) Members, Manage Nicknames, View Audit Log, Mute, Deafen, Move Members, Priority Speaker, Manage/Create Events, Mention @everyone | They are in the Developer and Moderator role permissions |

Why so many? **Discord only lets a bot give out permissions it holds itself.** The list is
computed from `server-config.ts`; if you trim a role's permissions there, the invite URL shrinks
too.

After inviting: **Server Settings → Roles** → drag the bot's role (`Hexenbane Setup`) to the top,
just under your own. The script refuses to run if any of its roles sit above the bot's role.

## 4. Run it

```bash
npm run discord              # read the plan
npm run discord -- --apply   # apply it
```

Example dry-run output on a fresh Community server:

```text
Hexenbane Discord provisioning — DRY RUN (nothing will change)

Server: Hexenbane  (1 roles, 6 channels, Community on)
Bot:    Hexenbane Setup#1234

51 changes would be made:
  • @everyone: remove MentionEveryone
  • Create role "Developer" with ViewAuditLog, ManageMessages, …
  • Create role "Playtest Manager" with ManageRoles
  • …
  • Create category START HERE
  • Create text channel #welcome in START HERE
  • Create announcement channel #announcements in START HERE
  • Move existing #general from "Text Channels" into THE CHAPTER HOUSE
  • …
Nothing was changed. Run `npm run discord -- --apply` to make these changes.
```

Running it again after a successful apply prints *"The server already matches
server-config.ts. Nothing to do."* If someone later breaks a permission (say, makes
`#playtest-applications` visible to everyone), a dry run shows it and `--apply` puts it back.

## 5. After setup: reduce or remove the bot

The bot is only needed while you run the script.

- **Remove it entirely (recommended):** Server Settings → Members → `Hexenbane Setup` → Kick.
  Its role disappears with it. The per-channel overwrite it gave itself on hidden channels is
  inert once it has left (you can delete those entries in each channel's Permissions if you
  like tidiness). Re-invite it with `--invite-url` whenever you change `server-config.ts`.
- **Keep it but defang it:** Server Settings → Roles → `Hexenbane Setup` → turn off everything
  except View Channels. It can't change anything until you restore its permissions.
- **Rotate the token** (Developer Portal → Bot → Reset Token) if it was ever shared or pasted
  anywhere other than `discord/.env`.

## The layout

```text
START HERE            #welcome  #rules-and-info  #announcements  #faq        read-only
THE CHAPTER HOUSE     #general  #screenshots-and-clips  #deckbuilding  #lore-discussion
                      #suggestions (forum)  #off-topic
DEVELOPMENT           #dev-updates  #patch-notes  #known-issues               read-only
PLAYTEST OPERATIONS   #playtest-applications  #playtest-admin  #playtest-notes
                      → Developer and Playtest Manager only
PRIVATE PLAYTEST      #playtest-info  #build-downloads  #playtest-announcements  (read-only)
                      #bug-reports (forum)  #playtest-feedback (forum)  #balance-discussion  #spoilers
                      → Playtester, Developer, Playtest Manager, Moderator
INTERNAL DEVELOPMENT  #dev-team  #art-review  #audio-review  #internal-builds  #internal-notes
                      → Developer, Artist, Composer
VOICE                 The Chapter House (everyone)  Playtest Session (testers)  Dev Room (team)
```

Roles, highest first: **Developer**, **Playtest Manager**, **Moderator**, **Artist**,
**Composer**, **Playtester**, **Early Supporter**, **Hunter**. Only Developer, Playtest Manager
and Moderator carry server-wide permissions; the rest only unlock channels. Artist and Composer
get no moderation powers. You (the server owner) always have full access.

`npm run discord -- --matrix` prints the full who-sees-what table, worked out with Discord's
own permission rules. The automated tests (`npm test`) check the important lines of it: normal
members can't see the tester or internal categories, Playtesters can't see operations or
internal channels, and `#build-downloads` is read-only for testers.

## Changing the layout later

Edit `server-config.ts` (add a channel, rename what a new category will be called, add a forum
tag, give a role access), run the dry run, then `--apply`. Things to know:

- Renaming something in the config creates a **new** channel or role with the new name; the old
  one is left alone (the script never renames or deletes). Rename it by hand in Discord first,
  then update the config, and the script will recognise it.
- Removing something from the config just stops the script managing it.
- A future always-on management bot can import `server-config.ts` and the role keys from here,
  so the layout stays defined in one place.
