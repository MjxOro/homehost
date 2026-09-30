/**
 * The only module that touches the site generation pipeline: the bench runs
 * the code that ships. Everything else in the bench imports from "./pipeline".
 */
export {
  PROMPT_VERSION,
  createOpenRouterClient,
  generateSite,
  hashLlmRequest,
} from "@homehost/sites";

// Preserve the shipped error class when replaying provider failures. It is not
// yet exported from the package root; keep this internal import centralized.
export { LlmClientError } from "@homehost/sites/src/generate/openrouter";
