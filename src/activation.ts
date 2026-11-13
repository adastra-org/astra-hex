import { type Hex, hexDisk, hexKeyOf, keyToHex } from './hex'

export type ActivationDiff = {
  readonly activated: Hex[]
  readonly deactivated: Hex[]
}

/**
 * Which cells are "alive": every cell within `radius` rings of a source cell
 * (players). Use it to spawn/despawn NPCs, start/stop zone AI or arm event
 * triggers only where someone can see them. A cell stays active until it is
 * outside `radius + extra` rings of every source, so walking along a border
 * does not spawn and despawn the same cell over and over.
 */
export class ActiveSet {
  private active = new Set<number>()
  constructor(
    readonly radius: number,
    readonly extra = 1,
  ) {}

  has(hex: Hex): boolean {
    return this.active.has(hexKeyOf(hex))
  }
  get size(): number {
    return this.active.size
  }
  cells(): Hex[] {
    return [...this.active].map(keyToHex)
  }

  update(sources: readonly Hex[]): ActivationDiff {
    const want = new Set<number>()
    const keep = new Set<number>()
    for (const s of sources) {
      for (const h of hexDisk(s, this.radius)) want.add(hexKeyOf(h))
      for (const h of hexDisk(s, this.radius + this.extra))
        keep.add(hexKeyOf(h))
    }
    const next = new Set<number>()
    for (const k of this.active) if (keep.has(k)) next.add(k)
    for (const k of want) next.add(k)
    const activated: Hex[] = []
    const deactivated: Hex[] = []
    for (const k of next) if (!this.active.has(k)) activated.push(keyToHex(k))
    for (const k of this.active) if (!next.has(k)) deactivated.push(keyToHex(k))
    this.active = next
    return { activated, deactivated }
  }
}
