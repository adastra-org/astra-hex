# @adastrarp/hex

One hex grid for everything spatial in Ad Astra, plus the per-cell ticking
that runs on it. Pointy-top, axial `(q, r)`, `size` = metres from a cell's
centre to a corner, X/Y ground plane. Same convention as AstraMapper
(`src/lib/world/hex.ts`); a test file pins the shared fixtures.

Runs inside FiveM's server JS runtime (V8): `src/` uses no Bun or Node API.
Bun is for tests, tooling and the optional bundle.

```bash
bun add @adastrarp/hex
bun run check   # typecheck + lint + format:check + test
bun run build   # dist/astra_hex.js, one file to drop in a FiveM resource
```

## Pieces

| Piece                                                                     | Use                                                                                        |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `worldToHex`, `hexCenter`, `hexDisk`, `hexRing`, `hexNeighbors`, `hexKey` | maths                                                                                      |
| `HexLayer<T>`                                                             | typed data per cell (economy zone, NPC density, event tables). JSON in/out                 |
| `PresenceTracker`                                                         | which cell each player/vehicle is in; `enter`/`leave` events with a dead band              |
| `ActiveSet`                                                               | cells that are alive around players (radius + hysteresis ring); activated/deactivated diff |
| `TickScheduler`                                                           | runs registered tickers per cell at a rate that depends on the cell's tier                 |

## TickScheduler

Systems register tickers. Each cell has a tier and each ticker has an
interval per tier:

| Tier   | Cell                                        | Default                                        |
| ------ | ------------------------------------------- | ---------------------------------------------- |
| `hot`  | a player is in it                           | runs                                           |
| `warm` | active (radius + hysteresis ring) but empty | runs                                           |
| `cold` | known but inactive                          | does **not** run unless the ticker sets `cold` |

```ts
import { HexLayer, TickScheduler } from '@adastrarp/hex'

const scheduler = new TickScheduler({
  radius: 2, // ActiveSet: 19 cells around each player
  extra: 1, // hysteresis ring
  budget: { maxMs: 8 }, // per step; maxCalls too if you want
  onError: (err, info) =>
    console.error(`[hex] ${info.tickerId}`, info.cell, err),
})

const density = new HexLayer<number>(250)
scheduler.addLayer('npcDensity', density)

const off = scheduler.register({
  id: 'npc-population',
  tiers: { hot: 250, warm: 2000 }, // ms; add `cold: 30000` to also tick inactive cells
  run(cell, ctx) {
    const target = ctx.get<number>('npcDensity') ?? 0 // this cell's value in the layer
    // ctx.tier, ctx.now, ctx.dt (ms since last run on this cell)
  },
})

// once per server loop:
const { activated, deactivated } = scheduler.setPresence(playerCells) // also returns the ActiveSet diff
const result = scheduler.step(nowMs)
```

API:

- `register(def)` returns an unregister function. `unregister(id)`, `tickerIds()`.
- `setPresence(sources)`: sources' cells become `hot`, the rest of the active set `warm`, the rest stop. Returns the `ActiveSet` diff, so the same call can spawn/despawn. Pass `{ active }` to share your own `ActiveSet`.
- `setTiers(hot, warm)`: same, when activation is computed elsewhere. `setColdCells(cells)`: inactive cells that cold tickers should reach. `tierOf`, `cellsIn`, `clearCells`.
- `step(nowMs)` runs what is due. Returns `{ calls, errors, ms, deferred, overrun }`.
- `metrics()` / `resetMetrics()`: per ticker `calls, errors, totalMs, maxMs, skipped, lastError`; global `steps, calls, errors, overruns, skipped, deferred`; `cells` per tier; live `entries`; `lastStep`. JSON-safe, for a dev panel.
- `scheduler.budget` is live: change `maxMs` / `maxCalls` at runtime.

Behaviour:

- **Budget**: `step` stops calling when `maxMs` (measured with the scheduler's clock) or `maxCalls` is spent; what is left is `deferred` and goes first next step. At least one call runs per step, so a tiny budget slows the world down, never freezes it. The budget is checked between calls, not inside one.
- **Fairness**: round-robin across cells (resumes after the last cell served), then the most overdue ticker inside a cell. Under overload every cell gets the same share.
- **No bursts**: after a stall a ticker runs once and the missed intervals are counted in `skipped`; its phase is kept.
- **Jitter**: the first run of each (ticker, cell) is offset by a hash of the ticker id, cell and `seed` inside `[0, interval)`. Deterministic, independent of registration order, and tickers do not all fire in the same frame. `jitter: 0` disables it.
- **Errors**: a throwing ticker is counted, reported to `onError`, and the loop goes on. Same for a rejected promise returned by `run`. A throwing `onError` is swallowed.
- **Granularity**: the step rate is the floor. A 100 ms interval on a 250 ms loop runs every step.

## Server loop (recommended)

One loop, 100 to 250 ms, with `setInterval`. Not `Wait(0)`, not `setTick`:
`setTick` fires every server tick, which is far more often than any ticker
here needs (the shortest `hot` interval is the useful limit; below the loop
period it cannot run faster anyway).

```js
// server/main.js, bundled from @adastrarp/hex (bun run build -> dist/astra_hex.js).
// NOT TESTED IN GAME. Natives checked against astra-dev/content/generated/natives
// (cfx/server.json): GetPlayerPed, GetEntityCoords, DoesEntityExist, GetGameTimer.
// getPlayers() is the JS runtime function (docs: scripting-reference/runtimes/javascript).
// Server-side GetEntityCoords needs OneSync.
import { PresenceTracker, TickScheduler } from './astra_hex.js'

const SIZE = 250 // metres, placeholder (see docs/ticking.md)
const LOOP_MS = 200

const presence = new PresenceTracker(SIZE, 10)
const scheduler = new TickScheduler({
  radius: 2,
  extra: 1,
  budget: { maxMs: 8 },
  onError: (err, info) => console.error(`[astra-hex] ${info.tickerId}`, err),
})

scheduler.register({
  id: 'example',
  tiers: { hot: 200, warm: 2000 },
  run(cell, ctx) {
    // your system's per-cell work here
  },
})

setInterval(() => {
  const playerCells = []
  const online = new Set()
  for (const id of getPlayers()) {
    // ids are strings
    online.add(id)
    const ped = GetPlayerPed(id) // 0 when the player has no ped yet
    if (!ped || !DoesEntityExist(ped)) continue
    const [x, y] = GetEntityCoords(ped) // JS runtime returns vector3 as [x, y, z]
    presence.update(id, x, y)
    const cell = presence.cellOf(id)
    if (cell) playerCells.push(cell)
  }
  for (const gone of [...presence.ids()].filter((id) => !online.has(id)))
    presence.remove(gone)

  const { activated, deactivated } = scheduler.setPresence(playerCells)
  // activated -> spawn population / arm triggers; deactivated -> despawn
  scheduler.step(GetGameTimer())
}, LOOP_MS)
```

Metrics for a dev panel: `scheduler.metrics()` is plain JSON.

## Release

Bump `version` in `package.json` and merge to `main`: `publish.yml` runs `bun run check` and `bun run release`, which publishes `@adastrarp/hex` if that version is not on the registry. Auth is npm Trusted Publishing (OIDC, no token); the package must list `adastra-org/astra-hex` + `publish.yml` as trusted publisher in its npmjs.com settings. The very first release must be done by hand once from a logged-in shell (`bun run release`, 2FA on the terminal), because Trusted Publishing needs the package to exist.

## Docs

`docs/README.md` is the index. Design notes and open decisions: `docs/ticking.md`.
