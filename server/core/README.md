# Authoritative game core

This package implements the single-player `design_preview` profile. Its policy is
still a review profile; starting `approved_play` is deliberately rejected. The
browser receives public projections, never a world snapshot or the selected case.

## Entry points and ownership

- `service.ts` is the HTTP/AI integration contract. `execute()` and `read()` are
  synchronous; model calls run asynchronously outside database transactions.
- `implementation.ts` owns command authorization, state transitions, scheduler,
  projections, replay, and terminal sealing.
- `world.ts` loads and hashes the frozen authored content. It resolves the server's
  route plans, including partial routes, holds, refusal, and recovery.
- `store.ts` opens SQLite and applies the frozen design DDL plus additive runtime
  tables. `state.ts` describes the private working snapshot.
- `server/ai` owns provider communication, input allowlists, result validation,
  and conservative behavior-fact rules. The core owns durable jobs, attempts,
  resource accounting, cancellation, and publication eligibility.

Create the service with `createGameService({ dbPath, agents, autoTick: true })`.
The launcher supplies the database path and the configured AI gateway. Unit tests
can supply an in-memory database, a `Clock`, and an internal case selector. HTTP
does not accept a case selector. Without an injected gateway the core uses the
explicit offline template gateway, which makes no network calls.

## Command and time rules

1. Launch access is checked before reading session data.
2. A successful idempotency receipt is looked up before current state checks.
   The same key and different command content returns `IDEMPOTENCY_KEY_REUSED`.
3. Due system events catch up in a separate committed transaction. A later
   rejected stale command cannot undo them.
4. Ordinary commands require the current run epoch, state version, and scene.
   Display receipts instead validate their observed version and public record;
   they do not increment state version or claim the player understood a card.
5. Accepted commands, their ledger entries, state, public events, and success
   receipt commit together. Network requests never hold a SQLite transaction.

The scheduler samples a monotonic clock every 100 ms. Costs determine completion
times; accepting an action does not subtract the duration a second time. WAIT
allows investigation and AI work to continue. A route locks further route choices
and cancels unfinished investigations with their report reservations released;
spent investigation resources remain spent. Due events use a stable order, and
arrival exactly at 600,000 ms wins over the deadline at the same instant.

The public clock sample is persisted at most once per observed second. It advances
only the view cursor. SSE cursors are `<runEpoch>:<viewSequence>`; HTTP polls the
durable view outbox and may request the next page of up to 250 events.

## Persistence and migrations

The database uses foreign keys, WAL, `synchronous=FULL`, and `busy_timeout=500`.
The frozen `database/001_initial.sql` is loaded for a new database. Existing
databases must have its supported `user_version=1`; unknown versions fail closed.
The runtime applies an additive version recorded in `runtime_schema_migrations`:

| Runtime table              | Purpose                                                           |
| -------------------------- | ----------------------------------------------------------------- |
| `runtime_session_meta`     | Locale, preview mode, and wall-clock start metadata.              |
| `runtime_display_bindings` | Maps a public rendering key to its immutable public record.       |
| `runtime_export_artifacts` | Stores the completed review JSON artifact, scoped to its session. |

`sessions.world_state_json` is a private working snapshot for fast reconstruction.
Normalized design tables also retain immutable evidence, reports, uploads,
decisions, ledger entries, events, manifests, jobs, attempts, and terminal seals.
The snapshot is never returned by a public endpoint or passed to either model.
The content hash is internal; the public content version is its registered opaque
UUID from `content_versions.content_version_id`.

Review exports are stored as JSON in SQLite rather than as a filesystem cache.
Their internal relative path is a logical artifact locator, not a file the browser
may read. The API returns the artifact itself and accepts no user-supplied path.

Use a separate test database when changing content or runtime code. Back up a
production database through SQLite's backup mechanism, or stop the process before
copying it; do not copy only an active WAL database's main file. No destructive
migration or automatic downgrade is provided.

## Agent boundary and evaluation

Advisor inputs contain only public task/map/background information, explicitly
uploaded card versions, and player statements labeled as unverified. Report
arrival alone does not upload it. A changed authorized context supersedes pending
work; a late result cannot overwrite a newer context.

Before a real provider request, the core durably inserts an attempt in `sending`.
Database constraints enforce at most two attempts per job and 30 Advisor attempts
per session. Offline templates consume no request attempt. The gateway reports
attempt completion even if its result became stale; publication checks current
eligibility separately.

Evaluator inputs are built after an immutable terminal seal, from decision-time
snapshots and received display receipts. They exclude private case, route truth,
and Outcome. The core freezes resource availability and the current displayed
advice at the decision cutoff. A later upload, result, or final balance cannot be
used as if it was known earlier. Unknown oral discussion, omitted reasons, and
missing display receipts remain limitations, not invented evidence of misconduct.

## End and recovery

The reference campaign ends at destination arrival. If administrative work remains,
the outcome can say `awaiting_transfer` while still reporting successful arrival.
No actual handoff stage is implemented, so `handoffCompletedAtMissionMs` remains
null. A timeout preserves the actual partial-route location.

A graceful close first commits events already due at its sampled mission time,
then technically seals sessions still active. It does not start new model work.
On startup after an unclean stop, unresolved sent attempts become `unknown` without reclaiming budget.
Previously active sessions are sealed as `technical_interruption` using their
persisted state; a new process never resumes an old monotonic clock. An explicit
`resumeSessionIds` option grants a new launch read/evaluation/export access to
terminal history. It does not restore gameplay authority. Postgame evaluation and
export records do not append gameplay events or change the immutable outcome.

## Verification

Run from the repository with Node 24 or later:

```sh
pnpm exec tsc --noEmit
pnpm exec vitest run tests/core tests/http tests/ai
```

Core tests cover both cases across all 16 route combinations, bridge refusal and
recovery, partial routes, parallel tasks and WAIT, global budgets, correction
charges, atomic upload batches, stale commands and idempotency, deadline ordering,
terminal history, and crash recovery. HTTP tests validate actual wire responses
and SSE resume behavior. AI integration tests exercise input isolation and the
behavior-fact rules through real core events. These tests do not claim that a live
external model provider was contacted or that the policy has team approval.
