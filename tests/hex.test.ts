import { describe, expect, test } from 'bun:test'
import {
  ActiveSet,
  HexLayer,
  PresenceTracker,
  hexCenter,
  hexCorners,
  hexDisk,
  hexDiskSize,
  hexDistance,
  hexKey,
  hexNeighbors,
  hexRing,
  keyToHex,
  worldToHex,
} from '../src'

describe('maths (same fixtures as AstraMapper hex.test.ts)', () => {
  test('centre maps back to its cell', () => {
    for (const hex of [
      { q: 0, r: 0 },
      { q: 3, r: -2 },
      { q: -5, r: 7 },
    ]) {
      const [x, y] = hexCenter(hex, 250)
      expect(worldToHex(x, y, 250)).toEqual(hex)
    }
  })
  test('corners are one radius from the centre', () => {
    const hex = { q: 2, r: -1 }
    const [cx, cy] = hexCenter(hex, 80)
    for (const [x, y] of hexCorners(hex, 80))
      expect(Math.hypot(x - cx, y - cy)).toBeCloseTo(80, 6)
  })
  test('distance', () => {
    expect(hexDistance({ q: 0, r: 0 }, { q: 2, r: -1 })).toBe(2)
    expect(hexDistance({ q: -2, r: 3 }, { q: 3, r: -1 })).toBe(5)
  })
  test('disk sizes 1, 7, 19, 37, 61', () => {
    for (let r = 0; r <= 4; r += 1)
      expect(hexDisk({ q: 4, r: -3 }, r)).toHaveLength(hexDiskSize(r))
  })
  test('key round trip', () => {
    expect(keyToHex(hexKey(-12, 300))).toEqual({ q: -12, r: 300 })
  })
  test('six neighbours at distance 1, ring of radius 2 has 12', () => {
    const c = { q: 1, r: 1 }
    expect(hexNeighbors(c).every((n) => hexDistance(n, c) === 1)).toBe(true)
    expect(hexRing(c, 2)).toHaveLength(12)
  })
})

describe('HexLayer', () => {
  test('lookup by world position, json round trip', () => {
    const l = new HexLayer<string>(250)
    const [x, y] = hexCenter({ q: 2, r: 3 }, 250)
    l.set({ q: 2, r: 3 }, 'ciudad')
    expect(l.at(x + 5, y - 5)).toBe('ciudad')
    expect(l.at(x + 5000, y)).toBeUndefined()
    const back = HexLayer.fromJSON<string>(JSON.parse(JSON.stringify(l)))
    expect(back.get({ q: 2, r: 3 })).toBe('ciudad')
  })
  test('fill does not overwrite', () => {
    const l = new HexLayer<string>(100)
    l.set({ q: 0, r: 0 }, 'centro')
    l.fill({ q: 0, r: 0 }, 1, 'periferia')
    expect(l.get({ q: 0, r: 0 })).toBe('centro')
    expect(l.count).toBe(7)
  })
})

describe('PresenceTracker', () => {
  test('enter, leave and dead band at a border', () => {
    const t = new PresenceTracker(100, 10)
    expect(t.update('a', 0, 0)).toEqual([
      { type: 'enter', id: 'a', cell: { q: 0, r: 0 } },
    ])
    // cross the border between (0,0) and (1,0) by 3 m: inside the dead band, no event
    const border = (Math.sqrt(3) * 100) / 2
    expect(t.update('a', border + 3, 0)).toEqual([])
    expect(t.cellOf('a')).toEqual({ q: 0, r: 0 })
    // 30 m past: leaves
    const ev = t.update('a', border + 30, 0)
    expect(ev.map((e) => e.type)).toEqual(['leave', 'enter'])
    expect(t.cellOf('a')).toEqual({ q: 1, r: 0 })
  })
  test('teleport switches at once; remove emits leave', () => {
    const t = new PresenceTracker(100)
    t.update('a', 0, 0)
    expect(t.update('a', 5000, 5000).map((e) => e.type)).toEqual([
      'leave',
      'enter',
    ])
    expect(t.remove('a').map((e) => e.type)).toEqual(['leave'])
    expect(t.remove('a')).toEqual([])
  })
  test('occupants', () => {
    const t = new PresenceTracker(100)
    t.update('a', 0, 0)
    t.update('b', 10, 10)
    expect(t.occupants({ q: 0, r: 0 }).sort()).toEqual(['a', 'b'])
  })
})

describe('ActiveSet', () => {
  test('activates a disk, keeps one extra ring, then releases', () => {
    const s = new ActiveSet(1, 1)
    let d = s.update([{ q: 0, r: 0 }])
    expect(d.activated).toHaveLength(7)
    // moving one cell east: new cells activate, nothing deactivates yet (inside radius+extra)
    d = s.update([{ q: 1, r: 0 }])
    expect(d.activated.length).toBeGreaterThan(0)
    expect(d.deactivated).toHaveLength(0)
    // far away: the old area is released
    d = s.update([{ q: 10, r: 0 }])
    expect(d.deactivated.length).toBeGreaterThan(0)
    expect(s.has({ q: 0, r: 0 })).toBe(false)
    expect(s.has({ q: 10, r: 0 })).toBe(true)
  })
  test('two sources share cells without duplicates', () => {
    const s = new ActiveSet(1, 0)
    s.update([
      { q: 0, r: 0 },
      { q: 1, r: 0 },
    ])
    expect(s.size).toBe(10)
  })
})

describe('PresenceTracker.ids', () => {
  test('lists tracked ids and forgets removed ones', () => {
    const p = new PresenceTracker(250)
    p.update('a', 0, 0)
    p.update('b', 1000, 0)
    expect(p.ids().sort()).toEqual(['a', 'b'])
    p.remove('a')
    expect(p.ids()).toEqual(['b'])
  })
})
