export {
  SiteSpec,
  Section,
  validateSpec,
  siteSpecJsonSchema,
  type SpecIssue,
} from "./schema";
export { THEME_PRESETS, FONT_PAIRINGS, contrastRatio } from "./themes";
export {
  applySpecPatch,
  SpecPatchError,
  type SpecPatchOperation,
  type JsonValue,
} from "./patch";
export {
  renderSite,
  specFacts,
  findPlaceholders,
  type PlaceholderMatch,
} from "./render";
export {
  SiteBrief,
  type GenerateModels,
  type GenerateOptions,
  type GenerateResult,
  type LlmCallRecord,
  type LlmClient,
  type LlmMessage,
  type LlmRequest,
  type LlmResponse,
  type LlmUsage,
} from "./generate/types";
