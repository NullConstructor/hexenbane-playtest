// ─────────────────────────────────────────────────────────────────────────────
//  HEXENBANE PLAYTEST SITE: EDITABLE CONTENT
// ─────────────────────────────────────────────────────────────────────────────
//  Almost every word on the page lives here. Edit, save, and `npm run dev`
//  shows it at once. The text is rendered into static HTML at build time.
//
//  Images: put files in site/public/media/ and point to them here with a path
//  relative to that folder's parent, e.g. "media/screenshot-01.png".
//  The Discord invite URL is NOT here: it is VITE_DISCORD_INVITE_URL (see
//  site/.env.example and the README), so it lives in one place.
//  The agreement text is NOT here: it is legal/playtest-agreement-v1.md.
// ─────────────────────────────────────────────────────────────────────────────

export interface Screenshot {
  /** Path under site/public, e.g. "media/screenshot-01.png". 16:9 images look best (1920×1080). */
  src: string;
  /** Describe the image for screen readers. */
  alt: string;
  caption: string;
}

export interface SocialLink {
  label: string;
  url: string;
}

export const site = {
  title: "Hexenbane — Private Playtest",
  description:
    "Hexenbane is a gothic-horror roguelike deckbuilder about investigating your prey, preparing the right tools and surviving the hunt. Apply for the private playtest.",
  /** Shown when the page is shared on Discord, social media etc. 1200×630 PNG or JPG. */
  socialImage: "media/social-card.png",
  /** Optional logo image for the hero, e.g. "media/logo.png". Leave null to use the HEXENBANE wordmark. */
  logo: null as string | null,
  /** Hero background art. Wide image, dark at the bottom (the title sits there). */
  heroArt: "media/hero-keyart.svg",
};

export const hero = {
  eyebrow: "A gothic-horror roguelike deckbuilder",
  tagline: "The hunt begins before the monster knows your name.",
  status: "Private playtest · Applications open",
};

export const about = {
  heading: "Know her before she knows you",
  paragraphs: [
    "Hexenbane is a gothic-horror roguelike deckbuilder about hunting witches who know you are coming. Take a Writ from the Chapterhouse, choose the tools you will carry, and walk the Trail for three Nights.",
    "Every Clue you uncover is an edge in the fight to come. Every Hour you spend brings Midnight closer, and at Midnight she comes for you.",
  ],
  pillars: [
    {
      title: "Investigate",
      text: "Follow Leads through haunted Scenes. Learn your quarry's Traits and Banes before you ever face her.",
    },
    {
      title: "Prepare",
      text: "Choose two Implements, from revolver and iron knife to stake and witchfire lantern, and hunt with the deck they make.",
    },
    {
      title: "Survive",
      text: "Duels unfold in Beats. Read her intent, build Momentum, and strike when the moment turns. Wounds carry from one fight to the next.",
    },
  ],
};

export const playtest = {
  heading: "The private playtest",
  intro:
    "Hexenbane is in active development, and a small group of testers plays it before anyone else. If you join, you will be playing something unfinished.",
  points: [
    { title: "Actively in development", text: "The game changes from build to build." },
    { title: "Builds are unfinished", text: "Expect placeholder art, missing content, rough edges and bugs." },
    { title: "Everything may change", text: "Art, content and balance are all subject to change, sometimes drastically." },
    { title: "Feedback is the point", text: "Testers are expected to play and tell us, honestly and specifically, what they find." },
    { title: "Access is limited", text: "Places are few and handed out in small waves." },
    { title: "No guarantee", text: "Applying does not guarantee acceptance. Every application is read by hand." },
    { title: "Contact is through Discord", text: "Approved testers are contacted on the Hexenbane Discord server." },
  ],
};

export const gallery = {
  heading: "From the Trail",
  note: "Work-in-progress footage. Everything shown is subject to change.",
  // Replace these placeholders with real screenshots (PNG/JPG/WebP, ideally 1920×1080).
  screenshots: [
    { src: "media/screenshot-01.svg", alt: "Placeholder for a screenshot of the main menu", caption: "The Chapterhouse awaits" },
    { src: "media/screenshot-02.svg", alt: "Placeholder for a screenshot of a duel", caption: "A duel in Beats and Momentum" },
    { src: "media/screenshot-03.svg", alt: "Placeholder for a screenshot of the Trail map", caption: "Three Nights on the Trail" },
    { src: "media/screenshot-04.svg", alt: "Placeholder for a screenshot of a Scene", caption: "Following a Lead" },
    { src: "media/screenshot-05.svg", alt: "Placeholder for a screenshot of a Reckoning", caption: "The Reckoning" },
    { src: "media/screenshot-06.svg", alt: "Placeholder for a screenshot of the Writ board", caption: "Choosing your Implements" },
  ] satisfies Screenshot[],
};

export const testers = {
  heading: "What we need from testers",
  intro: "Good feedback is specific. Tell us what happened, what you expected, and how it felt.",
  asks: [
    { title: "First impressions", text: "What drew you in, what confused you, when you wanted to stop or keep going." },
    { title: "Deckbuilding", text: "Which cards and Implement pairs feel strong, weak, dull or broken." },
    { title: "Momentum and combat", text: "Whether Beats and Momentum read clearly and make for tense, fair duels." },
    { title: "Difficulty and balance", text: "Where a Hunt felt unfair, too easy, or decided by luck." },
    { title: "Bugs", text: "Crashes, soft-locks and anything odd, with steps to make it happen again." },
    { title: "UI and UX", text: "Anything hard to read, find or understand, at any screen size." },
    { title: "Hardware and performance", text: "Frame rate, loading times and stutter, with the machine you played on." },
  ],
};

export const apply = {
  heading: "Request playtest access",
  intro:
    "Tell us a little about yourself. It takes about five minutes. We only ask for what we need to choose testers and reach you.",
  privacy:
    "Your answers are stored privately and are only used to run the Hexenbane playtest. We never sell them or add you to a mailing list. To have your application deleted, message us on Discord.",
  discordNote:
    "Please remain in the server and make sure you can receive direct messages. Approved applicants will initially be contacted through Discord.",
};

export const faq = {
  heading: "Questions",
  items: [
    {
      q: "Does the playtest cost anything?",
      a: "No. Playtest access is free.",
    },
    {
      q: "What platform is the playtest on?",
      a: "Windows PC for now. Hardware details in your application help us cover a range of machines.",
    },
    {
      q: "How will I know if I've been accepted?",
      a: "We will contact you on Discord. Stay in the Hexenbane server and allow direct messages from server members, or we may not be able to reach you.",
    },
    {
      q: "Can I stream, record or post screenshots?",
      a: "Not without permission. The build is confidential; the Private Playtest Agreement explains what you can and can't share. If you want to share something, ask us first.",
    },
    {
      q: "Why do you ask about my hardware?",
      a: "So we can reproduce performance problems and make sure the game runs well on more than one kind of machine.",
    },
    {
      q: "I made a mistake in my application. Can I apply again?",
      a: "One open application per Discord username is kept. Message us on Discord with your application ID and we will update it.",
    },
  ],
};

/** Shown in the footer. Leave url empty ("") to hide a link. The Discord link is added automatically. */
export const socialLinks: SocialLink[] = [
  { label: "Bluesky", url: "" },
  { label: "YouTube", url: "" },
  { label: "Steam", url: "" },
];

export const footer = {
  legal: "© Hexenbane. All rights reserved.",
};
