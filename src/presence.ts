import { type Hex, hexCenter, hexDistance, sameHex, worldToHex } from './hex'

export type PresenceEvent = {
  readonly type: 'enter' | 'leave'
  readonly id: string
  readonly cell: Hex
}

/**
 * Tracks which cell each entity (player, vehicle, NPC) is in and reports
 * enter/leave. A dead band (`margin` metres) stops an entity that stands on a
 * border from flapping between two cells: it only changes cell once it is
 * `margin` metres closer to the new centre than to the old one.
 */
export class PresenceTracker {
  private readonly cells = new Map<string, Hex>()
  constructor(
    readonly size: number,
    readonly margin = 10,
  ) {}

  cellOf(id: string): Hex | undefined {
    return this.cells.get(id)
  }

  update(id: string, x: number, y: number): PresenceEvent[] {
    const next = worldToHex(x, y, this.size)
    const prev = this.cells.get(id)
    if (!prev) {
      this.cells.set(id, next)
      return [{ type: 'enter', id, cell: next }]
    }
    if (sameHex(prev, next)) return []
    // Only neighbours get the dead band; a teleport switches at once.
    if (hexDistance(prev, next) === 1) {
      const [px, py] = hexCenter(prev, this.size)
      const [nx, ny] = hexCenter(next, this.size)
      if (
        Math.hypot(x - nx, y - ny) + this.margin >=
        Math.hypot(x - px, y - py)
      )
        return []
    }
    this.cells.set(id, next)
    return [
      { type: 'leave', id, cell: prev },
      { type: 'enter', id, cell: next },
    ]
  }

  remove(id: string): PresenceEvent[] {
    const prev = this.cells.get(id)
    if (!prev) return []
    this.cells.delete(id)
    return [{ type: 'leave', id, cell: prev }]
  }

  /** Every tracked id, to drop the ones that disconnected. */
  ids(): string[] {
    return [...this.cells.keys()]
  }

  /** Ids currently in a cell. */
  occupants(cell: Hex): string[] {
    const out: string[] = []
    for (const [id, c] of this.cells) if (sameHex(c, cell)) out.push(id)
    return out
  }
}
