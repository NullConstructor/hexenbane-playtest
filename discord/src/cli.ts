// Hexenbane Discord server provisioning.
//
//   npm run discord                     dry run: show what would change (default)
//   npm run discord -- --apply          make the changes
//   npm run discord -- --apply --fix-role-permissions   also reset drifted role permissions
//   npm run discord -- --invite-url     print the bot invite URL with exactly the permissions needed
//   npm run discord -- --matrix         print who can see and post where (no login needed)
//   npm run discord -- --forum-tags     print the #bug-reports tag ids for DISCORD_BUG_REPORTS_TAGS (read-only)
//
// Reads DISCORD_BOT_TOKEN and DISCORD_GUILD_ID from discord/.env (see .env.example).

import { fileURLToPath } from "node:url";
import { ChannelType, Client, Events, type ForumChannel, GatewayIntentBits } from "discord.js";
import { config as loadEnv } from "dotenv";
import { serverConfig } from "../server-config.ts";
import { applyPlan, takeSnapshot } from "./discord-io.ts";
import { printMatrix } from "./matrix.ts";
import { names, requiredBotPermissions } from "./permissions.ts";
import { buildPlan, describeAction } from "./plan.ts";

loadEnv({ path: fileURLToPath(new URL("../.env", import.meta.url)), quiet: true });

const args = new Set(process.argv.slice(2));
const known = ["--apply", "--fix-role-permissions", "--invite-url", "--matrix", "--forum-tags", "--help", "-h"];
for (const arg of args) {
  if (!known.includes(arg)) {
    console.error(`Unknown option ${arg}. Options: ${known.join(", ")}`);
    process.exit(2);
  }
}

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  violet: (s: string) => `\x1b[35m${s}\x1b[0m`,
};

if (args.has("--help") || args.has("-h")) {
  console.log(`Usage:
  npm run discord                        dry run: show what would change (default)
  npm run discord -- --apply             make the changes
  npm run discord -- --apply --fix-role-permissions
                                         also reset roles whose permissions drifted
  npm run discord -- --invite-url        print the bot invite URL with exactly the permissions needed
  npm run discord -- --matrix            print who can see and post in each channel
  npm run discord -- --forum-tags        print the #bug-reports forum tag ids (for DISCORD_BUG_REPORTS_TAGS)`);
  process.exit(0);
}

if (args.has("--matrix")) {
  printMatrix(serverConfig);
  process.exit(0);
}

/** A bot token's first segment is the bot's user ID (which is also its application ID) in base64. */
function applicationIdFromToken(token: string): string | null {
  try {
    const id = Buffer.from(token.split(".")[0], "base64").toString("utf8");
    return /^\d{17,20}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

const token = process.env.DISCORD_BOT_TOKEN?.trim();
const guildId = process.env.DISCORD_GUILD_ID?.trim();

if (args.has("--invite-url")) {
  const perms = requiredBotPermissions(serverConfig);
  const appId = process.env.DISCORD_CLIENT_ID?.trim() || (token ? applicationIdFromToken(token) : null);
  console.log(c.bold("Permissions the provisioning bot needs:"));
  console.log("  " + names(perms).join(", "));
  console.log(c.dim(`  (permissions integer ${perms})`));
  if (!appId) {
    console.log(c.yellow("\nSet DISCORD_BOT_TOKEN (or DISCORD_CLIENT_ID) in discord/.env to print the full invite URL."));
  } else {
    const url = `https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot&permissions=${perms}` +
      (guildId ? `&guild_id=${guildId}&disable_guild_select=true` : "");
    console.log(c.bold("\nInvite URL:"));
    console.log("  " + url);
  }
  process.exit(0);
}

if (!token || !guildId) {
  console.error(c.red("DISCORD_BOT_TOKEN and DISCORD_GUILD_ID must be set in discord/.env (copy discord/.env.example)."));
  process.exit(1);
}
if (!/^\d{17,20}$/.test(guildId)) {
  console.error(c.red("DISCORD_GUILD_ID should be the server's numeric ID (right-click the server icon → Copy Server ID)."));
  process.exit(1);
}

if (args.has("--forum-tags")) {
  // Read-only: the game's bug-report endpoints tag forum posts by id, and Discord's app has no
  // "Copy ID" for forum tags. This prints the JSON for the DISCORD_BUG_REPORTS_TAGS secret.
  const reader = new Client({ intents: [GatewayIntentBits.Guilds] });
  let code = 0;
  try {
    await reader.login(token);
    await new Promise<void>((resolve) => (reader.isReady() ? resolve() : reader.once(Events.ClientReady, () => resolve())));
    const guild = await reader.guilds.fetch(guildId);
    const forum = [...(await guild.channels.fetch()).values()].find(
      (ch) => ch?.type === ChannelType.GuildForum && ch.name === "bug-reports",
    ) as ForumChannel | undefined;
    if (!forum) throw new Error("No #bug-reports forum channel found. Run `npm run discord -- --apply` first.");
    const wanted = ["New", "Crash", "UI", "Combat"];
    const tags = Object.fromEntries(forum.availableTags.filter((t) => wanted.includes(t.name)).map((t) => [t.name, t.id]));
    const missing = wanted.filter((name) => !(name in tags));
    if (missing.length) console.log(c.yellow(`⚠ #bug-reports has no tag named ${missing.join(", ")}; those reports go untagged.`));
    console.log(c.bold("Set this as the Supabase secret DISCORD_BUG_REPORTS_TAGS:"));
    console.log(JSON.stringify(tags));
  } catch (err) {
    console.error(c.red(`\n✖ ${err instanceof Error ? err.message : String(err)}`));
    code = 1;
  } finally {
    await reader.destroy();
  }
  process.exit(code);
}

const apply = args.has("--apply");
console.log(c.violet(c.bold(`\nHexenbane Discord provisioning — ${apply ? "APPLY" : "DRY RUN (nothing will change)"}\n`)));

// Only the Guilds intent: no message content, no member lists, no privileged intents.
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
let exitCode = 0;

try {
  await client.login(token);
  await new Promise<void>((resolve) => (client.isReady() ? resolve() : client.once(Events.ClientReady, () => resolve())));
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) throw new Error(`The bot is not in a server with ID ${guildId}. Invite it first (npm run discord -- --invite-url).`);

  const snapshot = await takeSnapshot(guild);
  console.log(`Server: ${c.bold(snapshot.guildName)}  ${c.dim(`(${snapshot.roles.length} roles, ${snapshot.channels.length} channels, Community ${snapshot.community ? "on" : "off"})`)}`);
  console.log(`Bot:    ${client.user?.tag}\n`);

  const plan = buildPlan(serverConfig, snapshot, { fixRolePermissions: args.has("--fix-role-permissions") });

  for (const w of plan.warnings) console.log(c.yellow(`⚠ ${w}`));
  for (const b of plan.blockers) console.log(c.red(`✖ ${b}`));
  if (plan.warnings.length || plan.blockers.length) console.log("");

  if (!plan.actions.length) {
    console.log(c.green("✔ The server already matches server-config.ts. Nothing to do."));
  } else {
    console.log(c.bold(`${plan.actions.length} change${plan.actions.length === 1 ? "" : "s"}${apply ? "" : " would be made"}:`));
    for (const action of plan.actions) console.log(`  • ${describeAction(action, serverConfig)}`);
    console.log("");

    if (!apply) {
      console.log(c.dim("Nothing was changed. Run `npm run discord -- --apply` to make these changes."));
      console.log(c.dim("Nothing is ever deleted or renamed; roles and channels not in server-config.ts are left alone."));
    } else if (plan.blockers.length) {
      console.log(c.red("Not applying: fix the problems marked ✖ above, then run again."));
      exitCode = 1;
    } else {
      await applyPlan(guild, serverConfig, plan.actions, snapshot, {
        step: (m) => process.stdout.write(`  → ${m} … `),
        ok: () => console.log(c.green("ok")),
        warn: (m) => console.log(c.yellow(`⚠ ${m}`)),
      });
      // Verify by planning again against the server as it is now.
      const after = buildPlan(serverConfig, await takeSnapshot(guild), { fixRolePermissions: args.has("--fix-role-permissions") });
      const remaining = after.actions.filter((a) => a.type !== "order-roles" && a.type !== "order-channels");
      if (remaining.length) {
        console.log(c.yellow(`\n${remaining.length} change(s) still pending after applying; run again or check the messages above:`));
        for (const a of remaining) console.log(`  • ${describeAction(a, serverConfig)}`);
        exitCode = 1;
      } else {
        console.log(c.green("\n✔ Done. The server matches server-config.ts."));
        console.log("Next: the manual settings in discord/README.md, then the webhook for #playtest-applications.");
      }
    }
  }
} catch (err) {
  console.error(c.red(`\n✖ ${err instanceof Error ? err.message : String(err)}`));
  if (err && typeof err === "object" && "code" in err && (err as { code: unknown }).code === 50013) {
    console.error(c.red("Discord said the bot lacks permission. Check its role position and permissions (discord/README.md)."));
  }
  if (err && typeof err === "object" && "code" in err && (err as { code: unknown }).code === "TokenInvalid") {
    console.error(c.red("The bot token was rejected. Reset it in the Developer Portal → Bot and update discord/.env."));
  }
  exitCode = 1;
} finally {
  await client.destroy();
}
process.exit(exitCode);
