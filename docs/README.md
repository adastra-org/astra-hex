# @adastrarp/hex docs

Overview, API and the recommended FiveM server loop: root `README.md`.

| Doc          | What                                                                 |
| ------------ | -------------------------------------------------------------------- |
| `ticking.md` | `TickScheduler` model, step algorithm, jitter, decisions, open items |

## Pieces

| Piece                                                                     | Use                                                                                                 |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `worldToHex`, `hexCenter`, `hexDisk`, `hexRing`, `hexNeighbors`, `hexKey` | maths, same convention as AstraMapper (`src/lib/world/hex.ts`)                                      |
| `HexLayer<T>`                                                             | typed data per cell: economy zone (`m_zona`), NPC density, event tables, import region. JSON in/out |
| `PresenceTracker`                                                         | which cell each player/vehicle is in, `enter`/`leave` events, dead band against border flapping     |
| `ActiveSet`                                                               | cells that are alive around players (radius + hysteresis ring)                                      |
| `TickScheduler`                                                           | per-cell tickers by tier (hot/warm/cold), budgeted, fair, with metrics                              |

## Open decisions

- Cell size: 250 m is a placeholder. Measure NPC and event density before fixing it (AstraMapper uses adaptive sizes for streaming; this grid is uniform on purpose, so a cell id is stable).
- Where layers live at runtime: JSON files in the server repo, or the database.
