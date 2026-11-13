import { type Hex, hexDisk, hexKeyOf, keyToHex, worldToHex } from './hex'

/**
 * Typed data attached to cells: zone type (`m_zona` of the economy), NPC
 * density, event tables, import region... One layer per concern.
 */
export class HexLayer<T> {
  private readonly cells = new Map<number, T>()
  constructor(readonly size: number) {}

  set(hex: Hex, value: T): void {
    this.cells.set(hexKeyOf(hex), value)
  }
  get(hex: Hex): T | undefined {
    return this.cells.get(hexKeyOf(hex))
  }
  at(x: number, y: number): T | undefined {
    return this.get(worldToHex(x, y, this.size))
  }
  delete(hex: Hex): boolean {
    return this.cells.delete(hexKeyOf(hex))
  }
  get count(): number {
    return this.cells.size
  }
  entries(): [Hex, T][] {
    return [...this.cells].map(([k, v]) => [keyToHex(k), v])
  }
  /** Fill every cell within `radius` of `center` that has no value yet. */
  fill(center: Hex, radius: number, value: T): void {
    for (const h of hexDisk(center, radius))
      if (!this.cells.has(hexKeyOf(h))) this.set(h, value)
  }
  toJSON(): { size: number; cells: [number, number, T][] } {
    return {
      size: this.size,
      cells: this.entries().map(([h, v]) => [h.q, h.r, v]),
    }
  }
  static fromJSON<T>(data: {
    size: number
    cells: [number, number, T][]
  }): HexLayer<T> {
    const l = new HexLayer<T>(data.size)
    for (const [q, r, v] of data.cells) l.set({ q, r }, v)
    return l
  }
}
