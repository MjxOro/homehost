// Concierge catalogs and plain constants. Deliberately zod-free so the web
// can import labels and codes without bundling the contract schemas.

export const OFFERED_USE_CASE_IDS = [
  "game_server",
  "dev_box",
  "always_on",
  "remote_desktop",
  "learn_linux",
  "website",
] as const;
export type OfferedUseCaseId = (typeof OFFERED_USE_CASE_IDS)[number];
export const USE_CASE_IDS = [...OFFERED_USE_CASE_IDS, "not_offered"] as const;
export type UseCaseId = (typeof USE_CASE_IDS)[number];

/** `description` doubles as the Jev criterion for the option. */
export const USE_CASES: Record<
  UseCaseId,
  { label: string; description: string }
> = {
  game_server: {
    label: "Game server",
    description:
      "Host a multiplayer game server (Minecraft, Valheim, ...) to play with friends",
  },
  dev_box: {
    label: "Dev box",
    description: "A remote Linux machine to write, build and test code",
  },
  always_on: {
    label: "Always-on app",
    description:
      "Keep a bot, script, scheduled job or small service running 24/7",
  },
  remote_desktop: {
    label: "Remote desktop",
    description: "A graphical Linux desktop used from the browser",
  },
  learn_linux: {
    label: "Learn Linux",
    description: "Learn Linux and the command line on a safe machine",
  },
  website: {
    label: "Website",
    description: "Host a website, blog or web app",
  },
  not_offered: {
    label: "Not offered",
    description:
      "Not offered here: GPU or AI model hosting, email servers, VPNs or proxies for other people, Windows, crypto mining",
  },
};

export const RECIPE_IDS = [
  "none",
  "node",
  "python",
  "docker",
  "code_server",
  "minecraft_java",
  "minecraft_bedrock",
  "valheim",
] as const;
export type RecipeId = (typeof RECIPE_IDS)[number];

/**
 * Setups suggested for first boot. `requiresVm`: cannot run in a container
 * plan. `game`: players connect to it directly (drives connection warnings).
 */
export const RECIPES: Record<
  RecipeId,
  { label: string; description: string; requiresVm: boolean; game: boolean }
> = {
  none: {
    label: "Plain Ubuntu",
    description: "Plain Ubuntu, nothing extra installed",
    requiresVm: false,
    game: false,
  },
  node: {
    label: "Node.js",
    description: "Node.js runtime for JavaScript or TypeScript apps and bots",
    requiresVm: false,
    game: false,
  },
  python: {
    label: "Python",
    description: "Python runtime for scripts, bots and web apps",
    requiresVm: false,
    game: false,
  },
  docker: {
    label: "Docker",
    description: "Docker engine to run containerized apps",
    requiresVm: true,
    game: false,
  },
  code_server: {
    label: "VS Code in the browser",
    description: "VS Code in the browser (code-server) for coding",
    requiresVm: false,
    game: false,
  },
  minecraft_java: {
    label: "Minecraft Java",
    description: "Minecraft Java Edition server (PC and Mac players)",
    requiresVm: false,
    game: true,
  },
  minecraft_bedrock: {
    label: "Minecraft Bedrock",
    description: "Minecraft Bedrock server (console, phone, Windows players)",
    requiresVm: false,
    game: true,
  },
  valheim: {
    label: "Valheim",
    description: "Valheim dedicated server",
    requiresVm: false,
    game: true,
  },
};

export const WARNING_CODES = [
  "needs_review",
  "upgraded_for_recipe",
  "players_need_ipv6",
  "console_not_supported",
] as const;
export type WarningCode = (typeof WARNING_CODES)[number];

export const NOT_OFFERED_REASONS = [
  "unsupported_use_case",
  "no_fitting_plan",
  "tier_locked",
] as const;
export type NotOfferedReason = (typeof NOT_OFFERED_REASONS)[number];

export const CHOICE_SLOTS = ["use_case", "plan", "recipe"] as const;
export type ChoiceSlot = (typeof CHOICE_SLOTS)[number];

export const SUGGEST_TEXT_MAX = 500;
