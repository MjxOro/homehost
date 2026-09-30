# Usage ledger

Storage and domain layer for prepaid credits and AI-call accounting (migration
`0012_usage_ledger.sql`, code in `apps/api/src/domain/ledger.ts`). Every AI call
and every credit movement must be provable in a payment dispute. There are no
HTTP routes, UI, Stripe or AI calls here; later work consumes this layer.

## Tables

### `agent_runs`

One row per agent job. `user_id` is nullable (bench runs have no user).

| column                      | notes                                                          |
| --------------------------- | -------------------------------------------------------------- |
| `id`                        | uuid                                                           |
| `user_id`                   | nullable FK `users`                                            |
| `kind`                      | `site_build`, `site_edit`, `site_import`, `concierge`, `bench` |
| `purpose`                   | `prod`, `bench`, `dev`                                         |
| `ref_type`, `ref_id`        | nullable text pointer to the thing the run acted on            |
| `status`                    | `running` (default), `succeeded`, `failed`, `cancelled`        |
| `started_at`, `finished_at` | `finished_at` null while running                               |
| `metadata`                  | jsonb, default `{}`                                            |

Index: `(user_id, started_at)`.

### `llm_calls`

One row per provider call; benchmark runs use `purpose = 'bench'`.

| column                                                                       | notes                                              |
| ---------------------------------------------------------------------------- | -------------------------------------------------- |
| `id`                                                                         | uuid                                               |
| `agent_run_id`, `user_id`                                                    | nullable FKs                                       |
| `purpose`                                                                    | as above                                           |
| `provider`, `model`, `provider_request_id`                                   | request id nullable                                |
| `prompt_hash`                                                                | 64 lowercase hex (check)                           |
| `input_tokens`, `output_tokens`, `cached_input_tokens`, `cache_write_tokens` | int, `>= 0`                                        |
| `cost_micro_usd`                                                             | bigint `>= 0`; integer micro-dollars, never floats |
| `price_table_version`                                                        | which price table produced the cost                |
| `latency_ms`                                                                 | int `>= 0`                                         |
| `status`, `error_code`                                                       | `ok` or `error`; code nullable                     |
| `created_at`                                                                 | timestamptz                                        |

Indexes: `(user_id, created_at)`, `(agent_run_id)`, and a unique partial index on
`(provider, provider_request_id)` where the request id is not null, so a retried
webhook or callback cannot double-record a call.

### `credit_ledger`

Single global, append-only, hash-chained table.

| column               | notes                                                      |
| -------------------- | ---------------------------------------------------------- |
| `id`                 | `bigint generated always as identity`; chain order         |
| `user_id`            | NOT NULL FK `users` (no cascade: history outlives nothing) |
| `delta`              | bigint, `<> 0`                                             |
| `balance_after`      | bigint, `>= 0`; the user's balance after this row          |
| `reason`             | `purchase`, `usage`, `refund`, `grant`, `adjustment`       |
| `ref_type`, `ref_id` | nullable text                                              |
| `confirm_id`         | nullable uuid, no FK yet (`confirmations` comes later)     |
| `created_at`         | set by the app at millisecond precision; part of the hash  |
| `prev_hash`          | `char(64)`; hash of the previous row, genesis is 64 `'0'`  |
| `hash`               | `char(64)`, unique                                         |

## Hash formula

```
canonical = JSON.stringify([
  user_id, delta_decimal_string, balance_after_decimal_string, reason,
  ref_type ?? null, ref_id ?? null, confirm_id ?? null, created_at.toISOString()
])
hash = sha256_hex(prev_hash + "\n" + canonical)
```

The array has a fixed order, so there is no key-order ambiguity. `created_at` is
generated in the app with millisecond precision and written as that same
instant, so the stored value round-trips exactly. Hashing uses `node:crypto` in
the API only; `@homehost/shared` carries just the vocabularies (`LEDGER_REASONS`,
`AGENT_RUN_KINDS`, `USAGE_PURPOSES`, `LLM_CALL_STATUSES`) because the web bundle
imports it.

## Appending

`appendCredit` (or `appendCreditInTx` inside a caller-owned transaction) does,
in one transaction:

1. `pg_advisory_xact_lock(721914)`, which serializes every append (distinct from
   `migrate.ts`'s 721913); it is released on commit or rollback.
2. Read the latest row's `hash` and the user's latest `balance_after`.
3. Compute `balance_after = balance + delta`. A negative result returns
   `InsufficientCredits` and writes nothing.
4. Insert the row with its `prev_hash` and `hash`.

Because the lock is transactional, a future "spend credits for this action"
flow can call `appendCreditInTx` in the same transaction as the action and both
commit or roll back together.

## Append-only enforcement

A row trigger raises `credit_ledger is append-only` on `UPDATE` and `DELETE`,
and a statement trigger raises the same on `TRUNCATE`. Corrections are new
`adjustment` rows. Only the table owner can disable the triggers, and doing so
is detectable: `verifyLedger` reports the altered row.

## Verifying

`verifyLedger()` walks rows by `id` ascending and recomputes everything. It
returns `{ ok: true, rows, head }`, or `{ ok: false, rows, brokenAtId, reason }`
with the first failing row and one of:

- `prev_hash`: the row does not link to the previous row's hash (row removed or reordered),
- `hash`: the stored hash does not match the recomputed canonical row (row edited),
- `balance`: `balance_after` is not the user's running balance plus `delta`.

## Planned: daily anchor

Not implemented here. A daily job will publish the current `head` hash (with row
count and timestamp) somewhere outside the database's control, so that rewriting
history, including recomputing the whole chain, can be shown against an earlier
public head.
