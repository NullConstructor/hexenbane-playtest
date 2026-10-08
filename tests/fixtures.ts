// A complete, valid application as the website sends it.
export const validInput = () => ({
  preferredName: "Wren",
  discordUsername: "wren.hunter",
  email: "",
  interestReason: "Gothic horror and deckbuilders are my favourite things.",
  similarGames: "Slay the Spire, Inscryption",
  testingExperience: "Lots of hours, no formal testing.",
  cpu: "Ryzen 5 5600",
  gpu: "RTX 3060",
  ram: "16 GB",
  operatingSystem: "Windows 11",
  additionalNotes: "",
  joinedDiscord: true,
  agreementAccepted: true,
});


// The game's endpoints.
export const INSTALL_ID = "3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";
export const SESSION_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

export const telemetryBody = (overrides: Record<string, unknown> = {}) => ({
  install_id: INSTALL_ID,
  session_id: SESSION_ID,
  version: "0.8.0",
  events: [
    { name: "session_start", seq: 0, at: "2026-10-08T12:00:00Z", data: { os: "Windows" } },
    {
      name: "fight_end",
      seq: 1,
      at: "2026-10-08T12:05:00.250Z",
      data: { quarry: "hag", night: 1, result: "win", beats: 9, vitality_start: 30, vitality_end: 22, mode: "hunt" },
    },
  ],
  ...overrides,
});

export const crashBody = (overrides: Record<string, unknown> = {}) => ({
  install_id: INSTALL_ID,
  session_id: SESSION_ID,
  version: "0.8.0",
  kind: "crash",
  message: "Invalid get index 'hp' (on base: 'Nil') at 0x7ff612345678",
  stack: "res://hunt/fight.gd:123 - in function _on_beat\nres://hunt/hunt.gd:45 - in function _process",
  log_tail: "line one\nline two\n",
  occurred_at: "2026-10-08T12:10:00Z",
  context: { os: "Windows 11", gpu: "RTX 3060", window: "1920x1080", scene: "Fight", coven: "Ash", night: 2, hours: 3, quarry: "hag" },
  ...overrides,
});

/** A tiny but genuine JPEG header followed by filler bytes, base64-encoded. */
export const jpegBase64 = (size = 64) => {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return Buffer.from(bytes).toString("base64");
};

export const feedbackBody = (overrides: Record<string, unknown> = {}) => ({
  install_id: INSTALL_ID,
  version: "0.8.0",
  kind: "Bug",
  title: "Card art overlaps the beat counter",
  details: "On Night 2 the card art covers the counter.\nHappens every time.",
  context: {
    version: "0.8.0",
    scene: "Fight",
    os: "Windows 11",
    gpu: "RTX 3060",
    window: "1920x1080",
    time_utc: "2026-10-08T12:00:00Z",
    coven: "Ash",
    implements: ["censer", "nails"],
    night: 2,
    hours: 3,
    vitality: 18,
    quarry: "hag",
  },
  ...overrides,
});
