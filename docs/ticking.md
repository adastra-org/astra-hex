# Per-cell ticking

`TickScheduler` (`src/scheduler.ts`). Usage and API: root `README.md`. This file records how it works and why.

## Model

- Tier per cell: `hot` (a player is in it) > `warm` (rest of the `ActiveSet`: radius plus hysteresis ring) > `cold` (listed with `setColdCells`, not active). A cell not in any set has no entries and costs nothing.
- Entry = one (ticker, cell) pair with its own `due` time. Entries exist only where the ticker has an interval for the cell's tier, so a ticker without `cold` creates nothing for cold cells.
- `setPresence(sources)` = `ActiveSet.update(sources)` + tier assignment. It re-tiers only cells whose tier changed. Entering a cell creates entries; leaving drops them (state is not kept: re-entering starts a fresh phase and `dt` = interval).
- A cell that gets hotter pulls its `due` in (`min(due, now + phase(new interval))`); a cell that cools keeps its already scheduled run, then uses the longer interval.

## Step

1. Collect due entries (`due <= now`), grouped by cell. First sight of an entry sets `due = now + phase`.
2. Order cells by key, rotated to start after the last cell served (persisted cursor). Inside a cell, order by lateness over interval (most overdue relative to its own rate), then by registration order.
3. Pass 1 takes the first entry of each cell, pass 2 the second, and so on, until the budget is spent. The first call of a step is always allowed.
4. After a call: `due += (missed + 1) * interval`, where `missed = floor((now - due) / interval)`. Missed intervals are counted in `skipped`; nothing runs twice to catch up.
5. Entries removed during the step (unregister, cell left the active set) are skipped.

Time: `step(nowMs)` takes scheduling time from the caller (any monotonic ms). Run cost is measured with `options.clock` (default `performance.now`, falls back to `Date.now`). They are separate on purpose, so tests drive both with fake clocks.

## Jitter

`phase = floor(unit(hash(tickerId, seed), cellKey) * jitter * interval)`, where `unit` is a murmur3-style mix in `[0, 1)`. Pure function of ticker id, cell, seed and interval, so identical runs produce identical call logs and registration order does not matter.

## Decisions

- No timer inside the scheduler. The server owns the loop (`setInterval`); the scheduler is a pure state machine, testable with a fake clock.
- Budget is checked between calls only. A single slow `run` cannot be interrupted; it shows up as `overrun` and `maxMs` for that ticker.
- Fairness is per cell, not per ticker, so a cell with many tickers cannot crowd out a cell with one. There is no tier priority: under overload a hot and a warm cell get equal service. Revisit if the dev panel shows hot cells starving.
- `run` may return a promise; only rejections are observed (counted as errors), its duration is not measured.
- Layers are read through `ctx.get(name)` live (no snapshot), keyed by the cell being ticked.

## Open

- Cell size (250 m is a placeholder) and the hot/warm/cold intervals per system: measure NPC and event density first.
- Where layers live at runtime (JSON in the server repo, or the database).
- No circuit breaker: a ticker that throws every call is reported every call. Add backoff or auto-disable if the logs get noisy.
- Tier priority under overload (see Decisions).
- Untested in game: the FiveM example in `README.md`.
- `package.json` has no `license` or `repository` yet (no GitHub repo exists).
