# packages/sites (`@homehost/sites`)

## OVERVIEW
Bounded JSON site spec + pure deterministic static renderer + optional LLM generation pipeline for small-business sites. "AI fills the spec; code renders the website." Earned its file: distinct domain, 32 files, own CLI and README (read `README.md` for spec details).

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Spec schema / validation | `src/schema.ts` | `SiteSpec`, `Section`, `validateSpec`, `siteSpecJsonSchema` (Zod `z.strictObject`) |
| Themes / fonts | `src/themes.ts` | `THEME_PRESETS`, `FONT_PAIRINGS`, `contrastRatio` |
| Rendering | `src/render.ts`, `src/styles.ts` | `renderSite`, `specFacts`, `findPlaceholders` |
| JSON patches | `src/patch.ts` | `applySpecPatch` (RFC 6902), `SpecPatchError` |
| LLM generation | `src/generate/generate.ts` | `generateSite` (plan -> fill -> escalate) |
| Provider client | `src/generate/openrouter.ts` | `createOpenRouterClient`, redacted errors |
| Provider schemas | `src/generate/provider-schema.ts` | structural schemas derived from the Zod schemas |
| Prompts | `src/generate/prompts.ts` | `PROMPT_VERSION` is derived from a hash of `PROMPT_DEFINITION`, so any prompt/schema change re-keys bench caches |
| Request hashing | `src/generate/hash.ts` | `hashLlmRequest` (cache keys for bench replay) |
| CLI | `src/cli.ts` | `render <spec.json> <outDir> --base-url ...` |
| Example specs | `examples/` | plumber, hair salon, cafe |

## CONVENTIONS
- Relative imports are extensionless (`./schema`), unlike `packages/shared`.
- Library only: not part of root `build`; tests via `bun test packages/sites`.
- Every free-text field and array in the spec is bounded; JSON Schema carries `meta({ maxLength })` for structured output.
- Provider schemas strip length/count/pattern/format constraints (provider constraint budgets); full validation still runs through `validateSpec` afterwards.
- LLM access only through the `LlmClient` interface so tests and `packages/bench` can inject/replay.
- Test fixtures shared via `src/fixtures.test-helper.ts`.

## INVARIANTS
- Rendering makes no AI calls and accepts no user-supplied HTML, CSS, scripts, fonts or map URLs.
- Render output is deterministic for a given spec + base URL (pages, `styles.css`, `sitemap.xml`, `robots.txt`).
- Exactly one home page (slug `""`), <=8 pages, <=12 sections/page, 13 catalog section ids.

## ANTI-PATTERNS
- Adding a raw-HTML/escape-hatch section type.
- Hand-writing a provider schema instead of deriving it from Zod.
- Real network calls in tests (`generate.test.ts` is ~720 lines of fake-client coverage).
