# Performance results — `perf/sync-and-editing-responsiveness`

All numbers were taken on the **same machine and the same fixtures** before
(`master` @ `dbbd178`, Kept v1.9.1) and after this branch. Nothing is claimed
from subjective impressions alone.

- Machine: AMD Ryzen 7 8845HS, 60 GB RAM, local Docker-less Node server
- Node v24.21.0, Playwright Chromium 156 (headless), local SQLite fixture server
- Fixtures: 80 and 600 notes with mixed rich text, checklists (5 rows every
  4th note), pinned notes and links (1 link every 3rd note)
- Harness: `scripts/perf-benchmark.mjs` (works on both revisions — it wraps
  IndexedDB request primitives and the network from an init script instead of
  relying on app internals) and the targeted suites under `scripts/`
- Application diagnostics: enable with `localStorage.setItem('kept_perf', '1')`
  or `?kept_perf=1`; inspect `window.__keptPerf.snapshot()`. Only durations,
  counts and trigger reasons are recorded (no note text, URLs or tokens).

## 1. Startup and reopen (no remote changes)

`IDB writes/reads` are IndexedDB `put/add/delete` and `get/getAll/openCursor`
invocations counted during the phase. `reopen` = reload with a warm cache and
an up-to-date cursor; the server has zero changes.

### 80 notes

| metric | before | after | change |
|---|---|---|---|
| cold start → first notes usable | 732 ms | 624 ms | −15 % |
| cold start IDB writes / reads | 410 / 101 | 167 / 251 | −59 % writes |
| cold start `GET /api/reminders` | **81** | **5** | −94 % |
| cold start `GET /api/sync/changes` | 2 | 1 | −50 % |
| **reopen → first notes usable** | 482 ms | 383 ms | −21 % |
| **reopen IDB writes** | **164** | **1** | **−99.4 %** |
| reopen IDB reads | 16 | 6 | −63 % |
| reopen `GET /api/sync/changes` | 2 | 1 | −50 % |

### 600 notes

| metric | before | after | change |
|---|---|---|---|
| cold start → first notes usable | 2262 ms | 1111 ms | **−51 %** |
| cold start IDB writes / reads | 3010 / 621 | 1207 / 1811 | −60 % writes |
| cold start `GET /api/reminders` | **297** | **8** | −97 % |
| **reopen → first notes usable** | 788 ms | 480 ms | −39 % |
| **reopen IDB writes** | **1204** | **1** | **−99.9 %** |
| reopen IDB reads | 16 | 6 | −63 % |

Reading the table:

- A reopen with a current cursor and zero server changes now performs exactly
  **one lightweight `GET /api/sync/changes`** and **one small IndexedDB write**
  (the server clock offset); before, every note was read, rewritten and
  re-hydrated (164 writes at 80 notes, 1204 at 600) and the pull triggered a
  second sync cycle. This was the "Syncing" that lingered on every open.
- The remaining single write is the durable `syncState` bookkeeping; it is
  skipped entirely when the server offset has not moved.
- Cold start writes are dominated by the one-time bootstrap snapshot (note
  rows + baselines). Reads rise slightly because reconciliation now verifies
  candidate rows instead of blindly rewriting all of them — reads replaced
  writes, which is the trade we want (write volume is what costs durability
  and time).
- `GET /api/reminders` used to be issued once per `notes-changed` realtime
  message during startup (one per note!), competing with the sync for
  connections. `ReminderService.load()` now coalesces concurrent reloads.

## 2. Sync cycles and cache invalidation (from app diagnostics)

- `syncNow()` cycles per open: **1** (was 2–3: auth, `NotesService.load()` and
  `ReminderService.load()` each triggered their own full cycle; duplicate
  triggers now coalesce into the running cycle and only new outbox work
  schedules a follow-up). Redundant triggers are counted in
  `perf.snapshot()['sync.trigger.coalesced']`.
- Empty pulls run the `sync.pull.noop` fast path: no `reconcile()` transaction,
  no `cacheChanged$` emission, no note-list rehydration
  (`notes.publishCachedNotes` after a no-op sync: **0**).
- `notes.publishCachedNotes` per cold start: 3 (coalesced from 5–6 separate
  full reads/hydrations of the library); per reopen: 3 (was 4).
- After one edit: exactly **1** `sync.commit` (~15 ms) and **1** scoped
  `notes.cacheChangeFanOut` (~20 ms) that touches only the edited note.

## 3. Saving and closing with a slow server

The server was artificially delayed 6 s for `PUT /api/notes/:id` and
`POST /api/sync/mutations`.

| metric | before | after |
|---|---|---|
| Close click → editor closed (list visible) | 1268 ms | 1117 ms |
| of which durable local save (`editor.save`) | n/a | **2–24 ms** |

- The remaining ~400 ms is the deliberate modal close animation plus input
  dispatch; the editor reacts to the click immediately (button switches to
  “Saving…”, becomes busy) and the local commit completes in ~20 ms.
- The edit survives a reload before the slow flush lands and reaches the
  server afterwards (journal-first: the outbox entry is committed in the same
  transaction as the note and replayed exactly once).
- Rapid successive edits + Back keep the final content with no duplicates.
- A failing IndexedDB write keeps the editor open with visible “Couldn’t
  save” feedback and intact text (regression-tested).

## 4. Desktop checklist drag-to-reorder

Real mouse drags (HTML5 DnD) moving row 0 past 12 rows, measured with an
`Element.prototype.getBoundingClientRect` counter and a `dragover` counter.

| list size | layout reads before | layout reads after | dragover events | drag time after | long tasks |
|---|---|---|---|---|---|
| 20 | 489 | **115** (−76 %) | 23 | 94 ms | 0 |
| 100 | 2409 | **816** (−66 %) | 19–24 | 148 ms | 0 |
| 250 | (est. ~6000) | **2016** | 23 | 166 ms | 0 |

- Dragover/touchmove handling is coalesced to at most one reorder computation
  per animation frame; row geometry is captured in one batch and cached until
  the layout actually changes; FLIP animations cover only the rows between
  the old and new position.
- The old code measured at least one row per event plus one full checklist
  scan per actual reorder; it is also measurably slower (the 20/100-row
  numbers above are the old implementation run with the same test).
- Correctness is preserved across 20/100/250 rows: exact cursor-to-row
  placement (including a drop that lands before the next frame — the drop
  flushes the pending reorder first), the new order is persisted exactly once
  and survives reopening; Android/touch behaviour is unchanged (same
  algorithm, verified by the existing mobile checklist suite).

## 5. Rich link previews

60 notes × 3 links (180 URLs), preview endpoint delayed 100 ms in the browser.

| metric | before | after |
|---|---|---|
| requests while disabled | 0 | 0 |
| initial requests (visible demand) | **180 / 180** | **~52 / 180** |
| max concurrent fetches | 6+ (unbounded queue) | **3** (bounded queue) |
| requests during idle time | continuous preload churn | 0 |
| duplicate requests | cached per URL | 0 (dedupe + failure backoff) |

- The mass preload (every link of every loaded note, 6 parallel scrapes) is
  gone; previews load when their card approaches the viewport and queued work
  is cancelled when the consumer navigates away or the setting is disabled.
- The shimmer animates only while a fetch is actually in flight and never
  under `prefers-reduced-motion`; cached previews render without a skeleton.

## 6. Protocol compatibility

- The flush response no longer carries the full library snapshot on every
  save for local-first clients (`snapshot: false`); each mutation result now
  echoes its canonical resource (including LWW-skipped results), so the client
  converges without the snapshot. Cold caches (cursor 0) still request it.
  Clients that do not send the flag (native apps) keep the old response shape.
- Protocol v1 is untouched in its negotiation; its note writes are now
  journaled durably before the HTTP write is attempted (same outbox replay
  mechanism its offline mode already used), so closing an editor never waits
  on the network.

## 7. Verification

Run on this branch (all passing):

```sh
npm run build
npm run test:workspaces        # 41 tests
npm run test:sync              # incl. new slim-flush/canonical cases
npm run test:note-html
npm run test:performance       # 16 new regression tests
node scripts/checklist-editing-test.mjs      # desktop + mobile, incl. drag
node scripts/editor-autosave-test.mjs        # web + android + ios
node scripts/editor-responsiveness-test.mjs  # new
node scripts/link-preview-load-test.mjs      # new
node scripts/checklist-drag-perf-test.mjs    # new
```

Also green: `test:uuid`, `test:integration-requests`, `test:managed-hosting`,
`test:invite`, `test:reminders`, `test:offline-sync-status`,
`note-history-test.mjs`.

**Pre-existing failures** (verified to fail identically on pristine
`master`@`dbbd178` — stale suites, not regressions): `note-html-ui-test.mjs`,
`reminder-navigation-test.mjs`, `theme-preferences-test.mjs`. The
`editor-autosave-test.mjs` failure on master was caused by the suite waiting
for legacy `/api/notes` writes that protocol v2 never issues; the suite was
made protocol-agnostic in this branch and now passes on all three platforms.

## 8. Remaining bottlenecks / honest caveats

- The desktop modal close animation (~400 ms) dominates “Close → list
  visible”. It is intentional UX, not storage work; if snappier closing is
  wanted, shorten the animation rather than the save path.
- First-ever sync (bootstrap) still rewrites the whole snapshot into
  IndexedDB; it is one-time per device and no longer repeated per open.
- A label catalog rename re-materializes every note that applies labels
  (rare operation, kept simple for correctness).
- `sync.cycle` wall time includes the single `GET /api/sync/changes`
  round-trip; on a LAN it is ~50 ms at 80 notes. The end-to-end numbers above
  are hardware/network dependent and were measured, not extrapolated.
- Duplicate/stale browser suites (see §7) could not be stabilized within this
  change; they fail on master in the same way and deserve a separate cleanup.
