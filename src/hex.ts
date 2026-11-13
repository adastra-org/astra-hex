/**
 * Hex maths. Same convention as AstraMapper (`src/lib/world/hex.ts`) so a cell
 * means the same thing in the map editor, the dev site and the game server:
 * pointy-top, axial `(q, r)`, `size` = metres from a cell's centre to a corner,
 * X/Y ground plane (height never picks a cell).
 */
export type Hex = { readonly q: number; readonly r: number }

const SQRT3 = Math.sqrt(3)

export function worldToHex(x: number, y: number, size: number): Hex {
  const q = ((SQRT3 / 3) * x - y / 3) / size
  const r = ((2 / 3) * y) / size
  return roundHex(q, r)
}

function roundHex(q: number, r: number): Hex {
  const s = -q - r
  let rq = Math.round(q)
  let rr = Math.round(r)
  const rs = Math.round(s)
  const dq = Math.abs(rq - q)
  const dr = Math.abs(rr - r)
  const ds = Math.abs(rs - s)
  if (dq > dr && dq > ds) rq = -rr - rs
  else if (dr > ds) rr = -rq - rs
  return { q: rq + 0, r: rr + 0 }
}

export function hexCenter(hex: Hex, size: number): [number, number] {
  return [size * SQRT3 * (hex.q + hex.r / 2), size * 1.5 * hex.r]
}

export function hexCorners(hex: Hex, size: number): [number, number][] {
  const [cx, cy] = hexCenter(hex, size)
  const out: [number, number][] = []
  for (let i = 0; i < 6; i += 1) {
    const a = (Math.PI / 180) * (60 * i - 30)
    out.push([cx + size * Math.cos(a), cy + size * Math.sin(a)])
  }
  return out
}

export function hexDistance(a: Hex, b: Hex): number {
  const dq = a.q - b.q
  const dr = a.r - b.r
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2
}

export function hexDisk(center: Hex, radius: number): Hex[] {
  const cells: Hex[] = []
  for (let dq = -radius; dq <= radius; dq += 1) {
    const from = Math.max(-radius, -dq - radius)
    const to = Math.min(radius, -dq + radius)
    for (let dr = from; dr <= to; dr += 1)
      cells.push({ q: center.q + dq, r: center.r + dr })
  }
  return cells
}

export const hexDiskSize = (radius: number): number =>
  1 + 3 * radius * (radius + 1)

/** The six adjacent cells, east first, counter-clockwise. */
export function hexNeighbors(h: Hex): Hex[] {
  return [
    { q: h.q + 1, r: h.r },
    { q: h.q + 1, r: h.r - 1 },
    { q: h.q, r: h.r - 1 },
    { q: h.q - 1, r: h.r },
    { q: h.q - 1, r: h.r + 1 },
    { q: h.q, r: h.r + 1 },
  ]
}

/** Cells exactly `radius` steps away. */
export function hexRing(center: Hex, radius: number): Hex[] {
  if (radius === 0) return [center]
  return hexDisk(center, radius).filter(
    (c) => hexDistance(c, center) === radius,
  )
}

/** Number key, identical to AstraMapper's `hexKey` (|q|, |r| < 32768). */
export const hexKey = (q: number, r: number): number =>
  (q + 32768) * 65536 + (r + 32768)

export const keyToHex = (key: number): Hex => ({
  q: Math.floor(key / 65536) - 32768,
  r: (key % 65536) - 32768,
})

export const hexKeyOf = (h: Hex): number => hexKey(h.q, h.r)
export const sameHex = (a: Hex, b: Hex): boolean => a.q === b.q && a.r === b.r
