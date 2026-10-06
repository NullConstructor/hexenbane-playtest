import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/sections.css";
import "./styles/form.css";
import { config } from "./config.ts";
import { initDialogs } from "./dialogs.ts";
import { initForm } from "./form.ts";
import { initGallery } from "./gallery.ts";
import { initTopbar } from "./topbar.ts";

// Discord links are baked in at build time; if the invite was not configured, say so instead
// of sending people to a dead link.
if (!config.discordInviteUrl) {
  for (const link of document.querySelectorAll<HTMLAnchorElement>("[data-discord-link]")) {
    link.removeAttribute("href");
    link.setAttribute("aria-disabled", "true");
    link.title = "Discord invite not configured yet (VITE_DISCORD_INVITE_URL)";
  }
}

initTopbar();
initDialogs();
initGallery();
initForm();
