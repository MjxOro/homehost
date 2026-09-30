# @homehost/bench

`hh-bench` exercises the shipped `@homehost/sites` generation pipeline. It is a
local, deterministic-grader harness, not a separate generator or a browser test.
The corpus contains 30 invented Canadian small-business briefs across more than
12 niches, including terse/rambling copy, typos, French-Canadian names, no-phone
and six-page cases. Model candidates are starting points, not recommendations.

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
- Wrap live calls below the cache in the shared spend guard. No new live call
  starts once known billed spend reaches the cap. The last call and calls already
  in flight can overshoot: unknown future provider cost cannot be reserved exactly.
  This is a known-spend stop threshold, not a provider-side hard dollar limit.
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
