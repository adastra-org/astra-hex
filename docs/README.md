# @adastra/hex

One hex grid for everything spatial in Ad Astra. Same convention as AstraMapper (`src/lib/world/hex.ts`): pointy-top, axial `(q, r)`, `size` = metres from centre to corner, X/Y plane. A test file pins the shared fixtures.

```bash
bun run check   # typecheck + tests
bun run build   # dist/astra_hex.js (node target) to load from a FiveM resource
```

## Pieces

| Piece                                                                     | Use                                                                                                                                             |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `worldToHex`, `hexCenter`, `hexDisk`, `hexRing`, `hexNeighbors`, `hexKey` | maths                                                                                                                                           |
| `HexLayer<T>`                                                             | typed data per cell: economy zone (`m_zona`), NPC density, event tables, import region. JSON in/out so the dev site and AstraMapper can draw it |
| `PresenceTracker`                                                         | which cell each player/vehicle is in, `enter`/`leave` events, dead band against border flapping                                                 |
| `ActiveSet`                                                               | cells that are "alive" around players (radius + hysteresis ring): spawn/despawn NPCs, arm/disarm event triggers                                 |

## Server loop (sketch, untested in FiveM yet)

```ts
const SIZE = 250 // metres
const presence = new PresenceTracker(SIZE, 10)
const active = new ActiveSet(2, 1) // 19 cells around each player

setInterval(() => {
  const cells: Hex[] = []
  for (const id of getPlayers()) {
    const [x, y] = GetEntityCoords(GetPlayerPed(id))
    for (const e of presence.update(id, x, y))
      emit(`astra:hex:${e.type}`, e.id, e.cell)
    const c = presence.cellOf(id)
    if (c) cells.push(c)
  }
  const { activated, deactivated } = active.update(cells)
  // activated -> spawn NPC population / arm triggers; deactivated -> despawn
}, 500)
```

## Open decisions

- Cell size: 250 m is a placeholder. Measure NPC and event density before fixing it (AstraMapper uses adaptive sizes for streaming; this grid is uniform on purpose, so a cell id is stable).
- Where layers live at runtime: JSON files in the server repo, or the database.
