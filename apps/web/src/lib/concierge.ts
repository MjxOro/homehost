import {
  RECIPES,
  USE_CASES,
  type NotOfferedReason,
  type OfferedUseCaseId,
  type RecipeId,
  type ServerRequest,
  type SetupErrorCode,
  type WarningCode,
} from "@homehost/shared";
import { isApiError } from "./api";

/**
 * Copy and naming for the concierge helper. The API returns stable ids and
 * codes; the UI owns every word shown for them. Lookups take plain strings and
 * return undefined for ids a newer API might send, so callers can render a
 * neutral fallback instead of crashing.
 */

function lookup<T>(table: Readonly<Record<string, T>>, id: string) {
  return Object.hasOwn(table, id) ? table[id] : undefined;
}

export function useCaseLabel(id: string): string {
  return lookup(USE_CASES, id)?.label ?? id;
}

export function recipeLabel(id: string): string {
  return lookup(RECIPES, id)?.label ?? id;
}

export const DOCKER_SETUP_COPY =
  "Ready for your app or bot. Once it's running, go to your servers list to get started.";
export const DOCKER_READY_COPY =
  "Docker is ready for your app or bot. Go to your servers list to get started.";

const WARNING_COPY: Record<WarningCode, string> = {
  console_not_supported:
    "Game consoles (Switch, Xbox, PlayStation) can't join custom servers. Players need a PC, Mac or phone.",
  needs_review: "An operator will take a closer look before approving.",
  upgraded_for_recipe: "We picked a VM because this setup needs one.",
};

/** Copy for each warning code; unknown codes are dropped. */
export function warningCopy(codes: readonly string[]): string[] {
  return codes.flatMap((code) => lookup(WARNING_COPY, code) ?? []);
}

// "Not offered here: GPU …, crypto mining" → "GPU …, crypto mining".
const notOfferedDescription = USE_CASES.not_offered.description;
const notOfferedList = notOfferedDescription
  .slice(notOfferedDescription.indexOf(":") + 1)
  .trim();

const NOT_OFFERED_COPY: Record<NotOfferedReason, string> = {
  unsupported_use_case: `That's not something Homehost offers: ${notOfferedList}.`,
  no_fitting_plan:
    "None of our server sizes is a good fit for that. You can still pick the closest one yourself.",
  tier_locked:
    "That needs a bigger plan than your account has. Ask the operator for technical access.",
};

export function notOfferedCopy(reason: string): string {
  return (
    lookup(NOT_OFFERED_COPY, reason) ??
    "We can't suggest a setup for that. You can still pick a plan yourself."
  );
}

export const REFUSED_COPY =
  "We can't host that. It's against the acceptable use rules.";

const RECIPE_SLUG: Record<Exclude<RecipeId, "none">, string> = {
  node: "node-app",
  python: "python-app",
  docker: "docker-box",
  code_server: "code-box",
  minecraft_java: "minecraft",
  minecraft_bedrock: "minecraft",
  valheim: "valheim",
};

const USE_CASE_SLUG: Record<OfferedUseCaseId, string> = {
  game_server: "game-server",
  dev_box: "dev-box",
  always_on: "always-on",
  remote_desktop: "desktop",
  learn_linux: "linux-lab",
  website: "website",
};

/** Short server name for a suggestion: the recipe when there is one, else the use case. */
export function setupSlug(useCase: string, recipeId: string): string {
  return (
    lookup(RECIPE_SLUG, recipeId) ?? lookup(USE_CASE_SLUG, useCase) ?? "server"
  );
}

/**
 * Helper error copy. `retry` marks failures a second attempt can fix; 503 is
 * not handled here (it hides the helper).
 */
export function suggestErrorCopy(error: unknown): {
  message: string;
  retry: boolean;
} {
  if (isApiError(error)) {
    if (error.status === 429)
      return {
        message:
          "You've used today's suggestions. You can still pick a plan yourself.",
        retry: false,
      };
    if (error.status === 403)
      return {
        message:
          "Suggestions open up once your account is approved. You can still pick a plan yourself.",
        retry: false,
      };
    if (error.status === 400)
      return {
        message:
          "We couldn't use that description. Try rewording it, or pick a plan yourself.",
        retry: false,
      };
  }
  return {
    message: "We couldn't get a suggestion just now.",
    retry: true,
  };
}

const SETUP_ERROR_COPY: Record<SetupErrorCode, string> = {
  apt_failed:
    "Installing the system packages failed. That is usually a short hiccup at the package mirror, and trying again normally fixes it.",
  java_unavailable:
    "Ubuntu doesn't offer the Java version this Minecraft release needs yet, so it couldn't be installed. Trying again only helps once that Java version is available.",
  download_failed:
    "We couldn't download the software. The download site may be busy or unreachable; try again in a minute.",
  checksum_mismatch:
    "The download didn't match the official copy, so we threw it away to keep your server safe. Trying again fetches a fresh copy.",
  service_failed: "It installed, but its background service wouldn't start.",
  not_ready:
    "It installed and started, but it didn't answer in time. Trying again checks it once more.",
  timeout: "One of the steps took longer than its time limit.",
  unknown: "Something unexpected went wrong during setup.",
};

/** Plain explanation of a setup failure code; unknown codes get a neutral line. */
export function setupErrorCopy(code: string | null): string {
  return (
    (code === null ? undefined : lookup(SETUP_ERROR_COPY, code)) ??
    SETUP_ERROR_COPY.unknown
  );
}

/** Short setup state for a request with a recipe, e.g. "Minecraft Java ready". */
export function setupChip(
  request: Pick<ServerRequest, "recipeId" | "setupStatus">,
): { label: string; tone: "busy" | "ok" | "bad" } | null {
  if (request.recipeId === null || request.recipeId === "none") return null;
  const label = recipeLabel(request.recipeId);
  switch (request.setupStatus) {
    case "pending":
    case "running":
      return { label: `Setting up ${label}…`, tone: "busy" };
    case "done":
      return { label: `${label} ready`, tone: "ok" };
    case "failed":
      return { label: "Setup failed", tone: "bad" };
    default:
      return null;
  }
}
