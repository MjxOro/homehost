# @homehost/bench

`hh-bench` exercises the shipped `@homehost/sites` generation pipeline. It is a
local, deterministic-grader harness, not a separate generator or a browser test.
The corpus contains 30 invented Canadian small-business briefs across more than
12 niches, including terse/rambling copy, typos, French-Canadian names, no-phone
and six-page cases. Model candidates are starting points, not recommendations.

## Smoke findings (2026-09-30)

### Before the provider-schema fix

The original cheap stack used Gemini 2.5 Flash Lite to plan. A planner-only
diagnostic on the updated generator returned Google HTTP 400 / `INVALID_ARGUMENT`.
The redacted OpenRouter body included this provider error (no key/account IDs):

```json
{
  "message": "The specified schema produces a constraint that has too many states for serving.",
  "status": "INVALID_ARGUMENT"
}
```

Google's longer explanation cites large text/enum names, nested array bounds and
complex value matchers as typical causes. This is the planner's structured-output
schema constraint budget, not an invalid customer brief or a missing API key.
The diagnostic reported zero billed cost. The `cheap` candidate therefore uses
`openai/gpt-oss-120b` for planning, `google/gemini-2.5-flash-lite` for page filling,
and `qwen/qwen3-235b-a22b-2507` for escalation, as in the working generation smoke.
Fill schemas are page-specific and smaller. This is an observed compatibility
limit of this request/model/provider combination, not a claim that all Gemini
structured-output requests fail. Those harness-only runs did not change generator
schemas.

The follow-up three-task bench smoke on the reviewed generator still had Google
HTTP 400 / `INVALID_ARGUMENT` on its page-fill schemas; Qwen's escalations returned
objects missing page fields. Consequently its quality score was **0/3**, not a
successful-site claim. Record spent **$0.002226**; replay reproduced all grades,
errors, calls, tokens, original latencies and recorded cost for **$0**, with 10/10
cache hits. Those fill errors were truncated by the shipped client's redacted
error formatter, so the exact fill-schema constraint is not confirmed. These
models worked on the earlier smaller generation smoke but were not a reliable
stack for this corpus.

### After the provider-schema fix

Generator commit `814ef91` derives structural provider schemas from the same Zod
schemas, removing length/count/pattern/format/numeric constraints while retaining
types, properties, required fields, closed objects, literals and section unions.
Prompts state the strict limits; Zod and section-order/grounding checks still
reject violations and provide concrete escalation issues. The existing
`provider.require_parameters: true` routing remains tested. No fenced/wrapped
JSON unwrapping was added. Prompt version is `b2700abe2c4f`.

Both candidates ran the same first five sorted tasks, one repeat each:
`autorepair-brampton`, `autorepair-lethbridge`, `bakery-montreal`, `bakery-regina`,
and `barber-saskatoon`. Recorded headlines:

| Candidate | Pass + Wilson 95% CI      | Mean $/task | Escalation |  Wall p50 | Live spend |
| --------- | ------------------------- | ----------: | ---------: | --------: | ---------: |
| cheap     | 3/5, 60.0% (23.1–88.2%)   |   $0.000780 |      40.0% | 28,657 ms |  $0.003901 |
| mid       | 5/5, 100.0% (56.6–100.0%) |   $0.023030 |       0.0% | 22,493 ms |  $0.115152 |

Records are in ignored local directories
`bench-runs/2026-09-30T04-54-03-857Z-cheap-c2f921fe` (revision `357d57e`) and
`bench-runs/2026-09-30T04-58-26-476Z-mid-154215fb` (revision `ce81ed2`).
Each contains `run.json`, `results.jsonl` and `report.md`. Total reported live
spend for this schema-compatibility task was **$0.119053**, below its $0.25 budget;
the earlier smokes above are separate runs, not part of that total.

There were **no HTTP 400s** in either new run. Cheap's remaining failures were
an omitted supplied `$35` haircut price and incorrect section order after Qwen
escalation on the Regina bakery. That bakery's initial fill also exceeded the
320-character description limit: strict validation correctly rejected it rather
than weakening the enforced schema. Two GPT-OSS planner calls timed out at 60 s;
Qwen recovered one of those tasks. These are model omissions/noncompliance and
provider latency, not evidence for an unwrapping workaround or another schema
compatibility change. Mid had no observed failures; its Sonnet escalation model
was not exercised, so this smoke does not establish that model's compatibility.

Both final records replayed with identical grades, errors, call metadata, tokens,
original model-call latencies and recorded costs. Cheap had **13/13** cache hits
and mid **10/10**; each replay spent **$0**. Replay wall p50 was 24 ms / 6 ms,
respectively; it is not live inference latency. Replay directories are
`bench-runs/2026-09-30T04-58-27-646Z-cheap-9a89b2de` and
`bench-runs/2026-09-30T05-01-05-287Z-mid-9a5906e7`.

`compare` reports mid +40 percentage points passing, +$0.022250/task, -6,164 ms
wall p50 and -40 percentage points escalation. The pass intervals overlap;
five single-repeat tasks do not establish general superiority. Cheap used three
simultaneous tasks and the generator's default four page workers. Mid used one
task and one page worker to limit in-flight spend, with a $0.14 stop threshold;
its candidate now pins page concurrency to one. This scheduling difference
confounds latency comparisons, and neither run needed a spend-cap stop.

Commands used after rebasing the harness onto the generator fix:

```sh
bun run bench run --candidate cheap --limit 5 --repeats 1 --cache record --max-usd 0.15
bun run bench run --candidate mid --limit 5 --repeats 1 --cache record --concurrency 1 --max-usd 0.14
bun run bench run --candidate cheap --limit 5 --repeats 1 --cache replay --max-usd 0
bun run bench run --candidate mid --limit 5 --repeats 1 --cache replay --concurrency 1 --max-usd 0
bun run bench compare bench-runs/2026-09-30T04-54-03-857Z-cheap-c2f921fe bench-runs/2026-09-30T04-58-26-476Z-mid-154215fb
```

## Run

From the repository root, with `OPENROUTER_API_KEY` in the environment:

```sh
bun run bench run --candidate cheap --limit 3 --repeats 1 --cache record --max-usd 0.10
bun run bench run --candidate cheap --limit 3 --repeats 1 --cache replay
bun run bench report bench-runs/<run-directory>
bun run bench compare bench-runs/<record-directory> bench-runs/<replay-directory>
```

Defaults: suite `site-build`, three repeats per task, three simultaneous tasks,
cache `record`, spend cap $1.00. Use `--tasks id1,id2`, `--limit N`, `--repeats N`,
`--concurrency N`, `--cache live|record|replay`, and `--max-usd USD` to control the
run. `--cache-dir PATH` selects a fresh cache for independent experiments.
Live/record refuse to start without the API key. Replay never constructs a live
client and needs no key. Unit tests use scripted clients and never contact models.

## Methodology and artifacts

- Run the code that ships: only `src/pipeline.ts` imports generation entry points;
  hashing is the real pipeline hash, never a second implementation.
- Pin git SHA/dirty state, prompt version, candidate models, task snapshots,
  run arguments and actual model request parameters in `run.json`.
- Repeat each task (default N=3); separate `repeat-N` cache namespaces keep
  independent repetitions from sharing one model response. `record` reuses
  existing cache entries; choose `live` or a fresh cache directory for new samples.
- Full response caches preserve provider, model, tokens, integer micro-dollar
  cost and original latency. Replay matches results and original model-call
  metrics; elapsed wall time and spent-this-run deliberately differ.
  Provider errors also preserve their redacted message, error code and telemetry:
  changing a failure message would change the pipeline's escalation request hash.
  Old response-only caches cannot reproduce previously unrecorded provider errors.
- Wrap live calls below the cache in the shared spend guard. No new live call
  starts once known billed spend reaches the cap. The last call and calls already
  in flight can overshoot: unknown future provider cost cannot be reserved exactly.
  This is a known-spend stop threshold, not a provider-side hard dollar limit.
  Missing provider usage cost stops the run explicitly as unknown spend and
  blocks subsequent live calls; reported numeric totals then cover known costs
  only, not a claim that the incomplete run was free.
- Save completed attempts in deterministic task/repeat order to `results.jsonl`,
  checkpoint after each completion, and stop cleanly with partial results on a
  spend cap or replay miss (CLI exit 2). Other failed attempts do not stop the suite.
- Save HTML/CSS and failure metadata under `failed/<task>/repeat-N/` only when
  generation/grading fails. Caches and run directories are gitignored, and may
  contain business details; do not publish them without review. No Postgres writes.

## Read the report

`report` writes `report.md` and prints the same Markdown. Pass means generation
succeeded **and every grader passed**: valid schema, renders, required facts in
visible text, no placeholders, no forbidden claims, page count, home HTML+CSS
under 100 KB (100,000 bytes), and exact business title/header with no invented
Canadian phone/email contacts. Facts include supplied name, city, contacts,
address parts, service areas, opening days/times and task-specific expectations.
HTML entities, whitespace and Canadian phone formatting are normalized; hidden
metadata cannot satisfy a visible fact. These string/regex checks are not a DOM
or semantic truth judge and may need tuning as the corpus grows.

Reports show pass rate and Wilson 95% confidence interval, per-grader rates,
recorded cost per task×repeat (mean/p50/p95/total) separately from live spend,
tokens and provider cached-token ratio, elapsed latency p50/p95, sum of original
model-call latency, escalation and calls/task. Per-task mean pass rate, SD and
Wilson interval expose repeat spread. Trials of the same brief are correlated;
these intervals are descriptive, not proof of a model's population performance.
`compare` shows deltas and flags disjoint pass-rate intervals, warns on mismatched
task snapshots/repeats, and does not claim a paired significance test. Review
failed artifacts before interpreting an aggregate score.

## Not built yet

Screenshot graders, a vision judge, pairwise comparison, a benchmark CI gate,
and Postgres `llm_calls` recording await separate work (ledger integration after
that PR lands). CI runs offline harness tests, not paid benchmarks. No browser,
Playwright, Lighthouse, axe or additional dependencies were added.

```sh
bun test packages/bench
bun run --filter '@homehost/bench' typecheck
```
