// Setup recipe rules shared by the API (create validation, request mapping)
// and the worker (step planning, failure codes). Zod-free like the catalog so
// the web can import the error codes.
import {
  RECIPES,
  type RecipeId,
  type SetupStepId,
} from "./concierge-catalog.js";
import type { Plan } from "./plans.js";

/** Stable `setupError` values on a request whose setup failed. */
export const SETUP_ERROR_CODES = [
  "apt_failed",
  "download_failed",
  "checksum_mismatch",
  // The Java the chosen Minecraft release needs isn't in the guest's apt sources.
  "java_unavailable",
  "service_failed",
  "not_ready",
  "timeout",
  "unknown",
] as const;
export type SetupErrorCode = (typeof SETUP_ERROR_CODES)[number];

/** Catalog entry for a stored id; null for anything not in the catalog. */
function recipeOf(id: string): (typeof RECIPES)[RecipeId] | null {
  return Object.hasOwn(RECIPES, id) ? RECIPES[id as RecipeId] : null;
}

/** A recipe that is actually stored on a request (`none` is stored as null). */
export type StoredRecipeId = Exclude<RecipeId, "none">;

/**
 * Why this recipe cannot be requested on this plan, or null when it can.
 * `undefined` and `none` mean plain Ubuntu and are always fine.
 */
export function recipeRequestProblem(
  plan: Plan,
  recipeId: RecipeId | undefined,
  eulaAccepted: boolean | undefined,
): string | null {
  if (recipeId === undefined || recipeId === "none") return null;
  const recipe = RECIPES[recipeId];
  if (!recipe.installable) return `${recipe.label} can't be installed yet`;
  if (recipe.requiresVm && plan.kind !== "vm")
    return `${recipe.label} needs a VM plan`;
  if (recipe.eula !== null && eulaAccepted !== true)
    return `${recipe.label} requires accepting its EULA`;
  return null;
}

/** Players' address: the box hostname, once a game recipe finished setup. */
export function gameAddressOf(row: {
  recipeId: string | null;
  setupStatus: string;
  subdomain: string;
}): string | null {
  if (row.setupStatus !== "done" || row.recipeId === null) return null;
  return recipeOf(row.recipeId)?.game ? row.subdomain : null;
}

/** Memory left to the OS outside the Minecraft JVM heap. */
export const MINECRAFT_OS_RESERVE_MB = 512;
export const MINECRAFT_MIN_HEAP_MB = 1024;

/** JVM -Xmx for the plan: memory minus the OS reserve, at least 1024 MB. */
export function minecraftHeapMb(memoryMb: number): number {
  return Math.max(
    MINECRAFT_MIN_HEAP_MB,
    Math.floor(memoryMb) - MINECRAFT_OS_RESERVE_MB,
  );
}

/** Minecraft Java's default port; players type the hostname alone. */
export const MINECRAFT_PORT = 25565;

const MINUTE = 60_000;

/**
 * Per-step wall clock. Package steps include waiting for cloud-init and apt
 * locks; wait_ready covers the in-box 5 minute world generation wait.
 */
export const SETUP_STEP_TIMEOUT_MS: Record<SetupStepId, number> = {
  update_packages: 20 * MINUTE,
  install_java: 15 * MINUTE,
  download_minecraft: 10 * MINUTE,
  configure_minecraft: 2 * MINUTE,
  install_node: 15 * MINUTE,
  install_python: 15 * MINUTE,
  install_docker: 15 * MINUTE,
  start_service: 3 * MINUTE,
  wait_ready: 7 * MINUTE,
};

/** Runs of one step when its output shows a transient failure. */
export const SETUP_STEP_ATTEMPTS = 3;

/**
 * Exit codes the step scripts use to name their own failure. Anything else
 * (bash errors, signals) falls back to the step's default code.
 */
export const SETUP_EXIT_CODES = {
  apt_failed: 10,
  download_failed: 11,
  checksum_mismatch: 12,
  service_failed: 13,
  not_ready: 14,
  java_unavailable: 15,
} as const satisfies Partial<Record<SetupErrorCode, number>>;

const STEP_DEFAULT_ERROR: Record<SetupStepId, SetupErrorCode> = {
  update_packages: "apt_failed",
  install_java: "apt_failed",
  download_minecraft: "download_failed",
  configure_minecraft: "unknown",
  install_node: "apt_failed",
  install_python: "apt_failed",
  install_docker: "apt_failed",
  start_service: "service_failed",
  wait_ready: "not_ready",
};

/** Stable error code for a failed step run. */
export function setupErrorOf(
  step: SetupStepId,
  result: { exitCode: number | null; timedOut: boolean },
): SetupErrorCode {
  if (result.timedOut) return "timeout";
  for (const [code, exit] of Object.entries(SETUP_EXIT_CODES)) {
    if (result.exitCode === exit) return code as SetupErrorCode;
  }
  return STEP_DEFAULT_ERROR[step];
}

const TRANSIENT_OUTPUT = [
  /Could not get lock/i,
  /Unable to acquire the dpkg frontend lock/i,
  /Temporary failure resolving/i,
  /Could not resolve host/i,
  /Failed to fetch/i,
  /Hash Sum mismatch/i,
  /Connection timed out/i,
  /Network is unreachable/i,
  /Connection reset by peer/i,
  /curl: \((6|7|18|28|35|52|56)\)/,
];

/**
 * Failures worth re-running the same step for: apt/dpkg locks and network
 * blips. Timeouts and checksum mismatches are never transient here.
 */
export function isTransientSetupFailure(
  error: SetupErrorCode,
  output: string,
): boolean {
  if (error !== "apt_failed" && error !== "download_failed") return false;
  return TRANSIENT_OUTPUT.some((pattern) => pattern.test(output));
}

export interface SetupPlanStep {
  id: SetupStepId;
  timeoutMs: number;
}

export interface SetupPlan {
  steps: SetupPlanStep[];
  /** JVM heap for Minecraft recipes; null for recipes without a JVM. */
  heapMb: number | null;
}

/**
 * What the worker runs for a stored recipe on a box with `memoryMb`. Null
 * when the recipe has nothing to install (not installable or unknown).
 */
export function planSetup(
  recipeId: string,
  memoryMb: number,
): SetupPlan | null {
  const recipe = recipeOf(recipeId);
  if (!recipe || !recipe.installable || recipe.steps.length === 0) return null;
  return {
    steps: recipe.steps.map((id) => ({
      id,
      timeoutMs: SETUP_STEP_TIMEOUT_MS[id],
    })),
    heapMb: recipe.steps.includes("install_java")
      ? minecraftHeapMb(memoryMb)
      : null,
  };
}
