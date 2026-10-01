import {
  EULAS,
  RECIPES,
  isValidSshPublicKey,
  type Plan,
  type RecipeId,
} from "@homehost/shared";
import { isApiError } from "./api";

/**
 * Validation and copy shared by every place that creates a request (the
 * dashboard search box and the New request form), so both accept and refuse
 * exactly the same input.
 */

export const NAME_MAX = 48;

export function nameError(name: string): string | null {
  if (name.trim().length === 0) return "Enter a server name.";
  if (name.length > NAME_MAX)
    return `Name is limited to ${NAME_MAX} characters.`;
  return null;
}

export function sshKeyError(trimmedKey: string): string | null {
  return trimmedKey.length > 0 && !isValidSshPublicKey(trimmedKey)
    ? "Paste a single-line public key: <type> <base64> [comment]."
    : null;
}

function recipeOf(recipeId: string) {
  return Object.hasOwn(RECIPES, recipeId)
    ? RECIPES[recipeId as RecipeId]
    : undefined;
}

/** Recipe to send with the request: undefined for plain Ubuntu or "coming soon" setups. */
export function requestableRecipe(
  recipeId: RecipeId | null,
): RecipeId | undefined {
  if (recipeId === null || recipeId === "none") return undefined;
  return recipeOf(recipeId)?.installable ? recipeId : undefined;
}

/** True when a suggested recipe can't be installed yet (the box comes as plain Ubuntu). */
export function recipeComingSoon(recipeId: RecipeId | null): boolean {
  return (
    recipeId !== null &&
    recipeId !== "none" &&
    requestableRecipe(recipeId) === undefined
  );
}

/** License the user must accept for a recipe, if any. */
export function recipeEula(recipeId: RecipeId | undefined) {
  if (recipeId === undefined) return null;
  const eula = recipeOf(recipeId)?.eula;
  return eula ? EULAS[eula] : null;
}

/** A VM-only setup on a container plan; the API refuses it, so say so first. */
export function recipePlanError(
  recipeId: RecipeId | undefined,
  plan: Plan | null,
): string | null {
  if (recipeId === undefined || !plan) return null;
  if (recipeOf(recipeId)?.requiresVm && plan.kind !== "vm")
    return `${RECIPES[recipeId].label} needs a VM plan. Pick a VM, or use plain Ubuntu.`;
  return null;
}

/** Plain copy for a failed create (quota, pending account, validation). */
export function createErrorCopy(error: unknown): string {
  if (isApiError(error)) {
    if (error.status === 429)
      return "This would go over your server quota. Delete a server you no longer need, or ask the operator for more room.";
    if (error.status === 403)
      return error.code === "AccountPending"
        ? "Your account is still waiting for approval. You can create servers once an operator approves it."
        : "That plan isn't open to your account. Pick another one, or ask the operator for technical access.";
    if (error.status === 400)
      return `Something in the request wasn't accepted (${error.message}). Check the details and try again.`;
    if (error.status === 0)
      return "We couldn't reach Homehost. Check your connection and try again.";
    return error.message;
  }
  return "Something went wrong while creating it. Try again.";
}
