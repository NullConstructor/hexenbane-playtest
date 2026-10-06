// Turns content.ts into HTML at build time (see vite.config.ts). Runs in Node, not the browser.
// Everything from content.ts is escaped, so copy can safely contain <, & and quotes.

import { about, apply, faq, footer, gallery, hero, playtest, site, socialLinks, testers } from "./content.ts";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Joins the site's base path (e.g. "/hexenbane-playtest/") with a path under site/public. */
export function assetUrl(base: string, path: string): string {
  if (/^(https?:)?\/\//.test(path) || path.startsWith("data:")) return path;
  return base.replace(/\/?$/, "/") + path.replace(/^\/+/, "");
}

// ── Pixel icons ───────────────────────────────────────────────────────────────
// Drawn as grids so they stay crisp at any size; "#" is a filled pixel.

const ICONS: Record<string, string[]> = {
  eye: [
    "............",
    "....####....",
    "..##....##..",
    ".#...##...#.",
    "#...####...#",
    "#..##..##..#",
    "#...####...#",
    ".#...##...#.",
    "..##....##..",
    "....####....",
    "............",
    "............",
  ],
  blade: [
    ".....##.....",
    "....#..#....",
    "....#..#....",
    "....#..#....",
    "....#..#....",
    "....#..#....",
    "..########..",
    "..#.#..#.#..",
    ".....##.....",
    ".....##.....",
    "....####....",
    ".....##.....",
  ],
  flame: [
    ".....#......",
    ".....##.....",
    "....###.....",
    "....####....",
    "...##.##....",
    "...#..###...",
    "..##...##...",
    "..#..#..##..",
    "..#.###..#..",
    "..#.####.#..",
    "...#....#...",
    "....####....",
  ],
  sigil: [
    "..#..",
    ".#.#.",
    "#.#.#",
    ".#.#.",
    "..#..",
  ],
  chat: [
    "............",
    ".##########.",
    "#..........#",
    "#..#....#..#",
    "#..........#",
    "#...####...#",
    "#..........#",
    ".######..##.",
    ".......#.#..",
    "........##..",
    ".........#..",
    "............",
  ],
};

export function pixelIcon(name: keyof typeof ICONS | string, className = "px-icon"): string {
  const grid = ICONS[name];
  if (!grid) throw new Error(`Unknown icon ${name}`);
  const size = grid.length;
  let path = "";
  grid.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === "#") path += `M${x} ${y}h1v1h-1z`;
  });
  return `<svg class="${className}" viewBox="0 0 ${size} ${size}" aria-hidden="true" focusable="false" shape-rendering="crispEdges"><path fill="currentColor" d="${path}"/></svg>`;
}

// ── Sections ──────────────────────────────────────────────────────────────────

const PILLAR_ICONS = ["eye", "blade", "flame"];

export function renderHeroTitle(base: string): string {
  if (site.logo) {
    return `<h1 class="hero__title hero__title--logo"><img src="${escapeHtml(assetUrl(base, site.logo))}" alt="Hexenbane" /></h1>`;
  }
  return `<h1 class="hero__title" data-text="HEXENBANE">HEXENBANE</h1>`;
}

export function renderAbout(): string {
  return `
      <h2 class="section__title" id="about-title">${escapeHtml(about.heading)}</h2>
      <div class="about__copy">${about.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("")}</div>
      <ul class="pillars" role="list">
        ${about.pillars
          .map(
            (p, i) => `<li class="pillar">
          ${pixelIcon(PILLAR_ICONS[i % PILLAR_ICONS.length], "px-icon pillar__icon")}
          <h3 class="pillar__title">${escapeHtml(p.title)}</h3>
          <p>${escapeHtml(p.text)}</p>
        </li>`,
          )
          .join("")}
      </ul>`;
}

export function renderPlaytest(): string {
  return `
      <h2 class="section__title" id="playtest-title">${escapeHtml(playtest.heading)}</h2>
      <p class="section__lede">${escapeHtml(playtest.intro)}</p>
      <ul class="ledger" role="list">
        ${playtest.points
          .map(
            (p) => `<li class="ledger__item">${pixelIcon("sigil", "px-icon ledger__mark")}<div><strong>${escapeHtml(p.title)}</strong><span>${escapeHtml(p.text)}</span></div></li>`,
          )
          .join("")}
      </ul>`;
}

export function renderGallery(base: string): string {
  return `
      <h2 class="section__title" id="gallery-title">${escapeHtml(gallery.heading)}</h2>
      <p class="section__lede">${escapeHtml(gallery.note)}</p>
      <ul class="gallery" role="list">
        ${gallery.screenshots
          .map((s, i) => {
            const src = escapeHtml(assetUrl(base, s.src));
            return `<li class="gallery__item">
          <a class="gallery__link" href="${src}" data-gallery-index="${i}" data-caption="${escapeHtml(s.caption)}">
            <img src="${src}" alt="${escapeHtml(s.alt)}" loading="lazy" decoding="async" width="1920" height="1080" />
            <span class="gallery__caption">${escapeHtml(s.caption)}</span>
          </a>
        </li>`;
          })
          .join("")}
      </ul>`;
}

export function renderTesters(): string {
  return `
      <h2 class="section__title" id="testers-title">${escapeHtml(testers.heading)}</h2>
      <p class="section__lede">${escapeHtml(testers.intro)}</p>
      <ol class="asks" role="list">
        ${testers.asks
          .map(
            (a, i) => `<li class="ask"><span class="ask__num" aria-hidden="true">${String(i + 1).padStart(2, "0")}</span><h3>${escapeHtml(a.title)}</h3><p>${escapeHtml(a.text)}</p></li>`,
          )
          .join("")}
      </ol>`;
}

export function renderFaq(): string {
  return `
      <h2 class="section__title" id="faq-title">${escapeHtml(faq.heading)}</h2>
      <div class="faq">
        ${faq.items
          .map(
            (item) => `<details class="faq__item">
          <summary>${escapeHtml(item.q)}</summary>
          <p>${escapeHtml(item.a)}</p>
        </details>`,
          )
          .join("")}
      </div>`;
}

export function renderSocial(discordUrl: string): string {
  const links = [{ label: "Discord", url: discordUrl }, ...socialLinks].filter((l) => l.url);
  return links
    .map((l) => `<li><a href="${escapeHtml(l.url)}" rel="noopener noreferrer" target="_blank">${escapeHtml(l.label)}</a></li>`)
    .join("");
}

/** Replaces {{token}} markers in index.html. */
export function renderTokens(base: string, discordUrl: string, agreementHtml: string, agreementVersion: string): Record<string, string> {
  return {
    TITLE: escapeHtml(site.title),
    DESCRIPTION: escapeHtml(site.description),
    SOCIAL_IMAGE: escapeHtml(assetUrl(base, site.socialImage)),
    HERO_ART: escapeHtml(assetUrl(base, site.heroArt)),
    HERO_TITLE: renderHeroTitle(base),
    HERO_EYEBROW: escapeHtml(hero.eyebrow),
    HERO_TAGLINE: escapeHtml(hero.tagline),
    HERO_STATUS: escapeHtml(hero.status),
    ABOUT: renderAbout(),
    PLAYTEST: renderPlaytest(),
    GALLERY: renderGallery(base),
    TESTERS: renderTesters(),
    FAQ: renderFaq(),
    APPLY_HEADING: escapeHtml(apply.heading),
    APPLY_INTRO: escapeHtml(apply.intro),
    APPLY_PRIVACY: escapeHtml(apply.privacy),
    DISCORD_NOTE: escapeHtml(apply.discordNote),
    DISCORD_URL: escapeHtml(discordUrl || "#discord-invite-not-configured"),
    DISCORD_ICON: pixelIcon("chat", "px-icon btn__icon"),
    SIGIL: pixelIcon("sigil", "px-icon divider__sigil"),
    SOCIAL_LINKS: renderSocial(discordUrl),
    FOOTER_LEGAL: escapeHtml(footer.legal),
    AGREEMENT_HTML: agreementHtml,
    AGREEMENT_VERSION: escapeHtml(agreementVersion),
    BASE: escapeHtml(base),
  };
}
