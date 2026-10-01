import { z } from "zod";
import {
  PLANS,
  RECIPE_IDS,
  SSH_KEY_MAX,
  isValidSshPublicKey,
  recipeRequestProblem,
  type TrustTier,
} from "@homehost/shared";

const requestFields = {
  name: z.string().trim().min(1).max(48),
  planId: z.string().min(1),
  recipeId: z.enum(RECIPE_IDS).optional(),
};
export const ProposalBody = z
  .object({ ...requestFields, recipeId: z.enum(RECIPE_IDS) })
  .strict();
export const CreateRequestBody = z
  .object({
    ...requestFields,
    desktopEnv: z.enum(["ubuntu-xfce", "omarchy"]).optional(),
    sshPubkey: z.string().trim().max(SSH_KEY_MAX).optional(),
    eulaAccepted: z.boolean().optional(),
    agentProposalId: z.string().uuid().optional(),
  })
  .strict()
  .refine(
    (b) => b.sshPubkey === undefined || isValidSshPublicKey(b.sshPubkey),
    {
      message: "sshPubkey must be a single-line <type> <base64> [comment] key",
    },
  );

/** Both proposal previews and create use the same plan/recipe gates. A preview
 * checks EULA capability; it never records the user's acceptance. */
export function validateServerSetup(
  body: z.infer<typeof CreateRequestBody>,
  tier: TrustTier,
  preview = false,
) {
  const plan = PLANS.find((p) => p.id === body.planId);
  if (!plan)
    return {
      ok: false as const,
      status: 404,
      code: "not_found",
      message: "unknown plan",
    };
  if (plan.technicalOnly && tier !== "technical")
    return {
      ok: false as const,
      status: 403,
      code: "forbidden",
      message: "plan requires technical tier",
    };
  if (!plan.available)
    return {
      ok: false as const,
      status: 400,
      code: "invalid",
      message: "plan is not available yet",
    };
  if (
    (plan.desktop &&
      body.desktopEnv !== undefined &&
      body.desktopEnv !== plan.desktop.env) ||
    (!plan.desktop && body.desktopEnv !== undefined)
  )
    return {
      ok: false as const,
      status: 403,
      code: "forbidden",
      message: "desktop env does not match plan",
    };
  const problem = recipeRequestProblem(
    plan,
    body.recipeId,
    preview ? true : body.eulaAccepted,
  );
  if (problem)
    return {
      ok: false as const,
      status: 400,
      code: "invalid",
      message: problem,
    };
  return { ok: true as const, plan };
}
