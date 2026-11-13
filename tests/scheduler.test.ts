import { describe, expect, test } from 'bun:test'
import {
  ActiveSet,
  type Hex,
  HexLayer,
  PresenceTracker,
  TickScheduler,
  type SchedulerOptions,
  type TickerDef,
  hexCenter,
  hexKeyOf,
} from '../src'

const H = (q: number, r: number): Hex => ({ q, r })
const ORIGIN = H(0, 0)

/** Scheduler on a fake clock; `clock.t` only moves when a test (or a ticker) moves it. */
function rig(options: SchedulerOptions = {}) {
  const clock = { t: 0 }
  const s = new TickScheduler({ clock: () => clock.t, jitter: 0, ...options })
  return { clock, s }
}

/** Ticker that records `[id, q, r, now]` in `log`. */
function logger(
  log: string[],
  id: string,
  tiers: TickerDef['tiers'],
  cost = 0,
  clock?: { t: number },
): TickerDef {
  return {
    id,
    tiers,
    run(cell, ctx) {
      log.push(`${id}@${cell.q},${cell.r}@${ctx.now}`)
      if (clock) clock.t += cost
    },
  }
}

/** Step every `stepMs` from `from` to `to` inclusive. */
function drive(s: TickScheduler, from: number, to: number, stepMs: number) {
  for (let t = from; t <= to; t += stepMs) s.step(t)
}

const countOf = (log: string[], prefix: string) =>
  log.filter((l) => l.startsWith(prefix)).length

describe('registration', () => {
  test('rejects duplicates, empty ids and bad intervals', () => {
    const { s } = rig()
    s.register({ id: 'a', tiers: { hot: 100, warm: 200 }, run() {} })
    expect(() =>
      s.register({ id: 'a', tiers: { hot: 1, warm: 1 }, run() {} }),
    ).toThrow()
    expect(() =>
      s.register({ id: '', tiers: { hot: 1, warm: 1 }, run() {} }),
    ).toThrow()
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        s.register({ id: 'x', tiers: { hot: bad, warm: 1 }, run() {} }),
      ).toThrow(RangeError)
      expect(() =>
        s.register({ id: 'x', tiers: { hot: 1, warm: bad }, run() {} }),
      ).toThrow(RangeError)
      expect(() =>
        s.register({
          id: 'x',
          tiers: { hot: 1, warm: 1, cold: bad },
          run() {},
        }),
      ).toThrow(RangeError)
    }
    expect(s.tickerIds()).toEqual(['a'])
  })

  test('the returned function unregisters; unknown ids are a no-op', () => {
    const { s } = rig()
    const log: string[] = []
    const off = s.register(logger(log, 'a', { hot: 100, warm: 100 }))
    s.setTiers([ORIGIN], [])
    s.step(0)
    off()
    s.step(100)
    expect(log).toHaveLength(1)
    expect(s.tickerIds()).toEqual([])
    expect(s.unregister('a')).toBe(false)
    expect(s.metrics().entries).toBe(0)
  })

  test('a ticker registered after cells exist picks them up', () => {
    const { s } = rig()
    const log: string[] = []
    s.setTiers([H(1, 0)], [H(2, 0)])
    s.register(logger(log, 'late', { hot: 100, warm: 100 }))
    s.step(0)
    expect(log.sort()).toEqual(['late@1,0@0', 'late@2,0@0'])
  })
})

describe('tiers', () => {
  test('hot, warm and cold cells run at their own rate; cold does not run by default', () => {
    const { s } = rig()
    const log: string[] = []
    s.register(logger(log, 't', { hot: 100, warm: 500 }))
    s.setTiers([H(0, 0)], [H(1, 0)])
    s.setColdCells([H(5, 5)])
    drive(s, 0, 1000, 50)
    expect(countOf(log, 't@0,0@')).toBe(11) // 0, 100 … 1000
    expect(countOf(log, 't@1,0@')).toBe(3) // 0, 500, 1000
    expect(countOf(log, 't@5,5@')).toBe(0)
    expect(s.metrics().cells).toEqual({ hot: 1, warm: 1, cold: 1 })
    expect(s.metrics().entries).toBe(2) // no entry is kept for a cold cell nobody ticks
  })

  test('a ticker with a cold interval runs on cold cells', () => {
    const { s } = rig()
    const log: string[] = []
    s.register(logger(log, 'slow', { hot: 100, warm: 200, cold: 1000 }))
    s.register(logger(log, 'fast', { hot: 100, warm: 200 }))
    s.setColdCells([H(9, 9)])
    drive(s, 0, 3000, 100)
    expect(countOf(log, 'slow@9,9@')).toBe(4) // 0, 1000, 2000, 3000
    expect(countOf(log, 'fast@9,9@')).toBe(0)
  })

  test('hot beats warm beats cold when a cell is in several sets', () => {
    const { s } = rig()
    s.setColdCells([H(0, 0), H(1, 0), H(2, 0)])
    s.setTiers([H(0, 0)], [H(0, 0), H(1, 0)])
    expect(s.tierOf(H(0, 0))).toBe('hot')
    expect(s.tierOf(H(1, 0))).toBe('warm')
    expect(s.tierOf(H(2, 0))).toBe('cold')
    expect(s.tierOf(H(3, 0))).toBeUndefined()
    expect(s.cellsIn('warm')).toEqual([H(1, 0)])
  })

  test('context carries tier, now, dt and the tier-specific cell', () => {
    const { s } = rig()
    const seen: [string, number, number][] = []
    s.register({
      id: 'c',
      tiers: { hot: 100, warm: 400 },
      run(cell, ctx) {
        expect(ctx.cell).toBe(cell)
        expect(ctx.tickerId).toBe('c')
        expect(ctx.scheduler).toBe(s)
        seen.push([ctx.tier, ctx.now, ctx.dt])
      },
    })
    s.setTiers([ORIGIN], [])
    s.step(0)
    s.step(100)
    s.step(200)
    expect(seen).toEqual([
      ['hot', 0, 100], // first run: dt = interval
      ['hot', 100, 100],
      ['hot', 200, 100],
    ])
  })

  test('a cell turning hot pulls its next run in; turning cooler does not', () => {
    const { s } = rig()
    const log: string[] = []
    s.register(logger(log, 't', { hot: 100, warm: 1000 }))
    s.setTiers([], [ORIGIN])
    s.step(0) // warm, runs, next at 1000
    s.step(200)
    expect(log).toHaveLength(1)
    s.setTiers([ORIGIN], [])
    s.step(200) // hot now: due immediately (jitter 0)
    expect(log).toHaveLength(2)
    s.step(300)
    expect(log).toHaveLength(3)
    s.setTiers([], [ORIGIN]) // back to warm: the already scheduled 400 stays, then 1000 apart
    s.step(400)
    expect(log).toHaveLength(4)
    s.step(500)
    s.step(1399)
    expect(log).toHaveLength(4)
    s.step(1400)
    expect(log).toHaveLength(5)
  })

  test('ctx.get reads the cell in a named HexLayer', () => {
    const { s } = rig()
    const density = new HexLayer<number>(250)
    density.set(H(0, 0), 7)
    s.addLayer('npcDensity', density)
    expect(s.layer<number>('npcDensity')).toBe(density)
    expect(s.layer('nope')).toBeUndefined()
    const got: unknown[] = []
    s.register({
      id: 'zone',
      tiers: { hot: 100, warm: 100 },
      run(_cell, ctx) {
        got.push(ctx.get<number>('npcDensity'), ctx.get('missing'))
      },
    })
    s.setTiers([H(0, 0), H(1, 0)], [])
    s.step(0)
    expect(got.filter((v) => v !== undefined)).toEqual([7])
    density.set(H(0, 0), 9) // live: no snapshot
    got.length = 0
    s.step(100)
    expect(got.filter((v) => v !== undefined)).toEqual([9])
  })
})

describe('activation integration', () => {
  test('setPresence: player cell hot, active ring warm, diff returned', () => {
    const { s } = rig({ radius: 1, extra: 1 })
    const first = s.setPresence([ORIGIN])
    expect(first.activated).toHaveLength(7)
    expect(first.deactivated).toHaveLength(0)
    expect(s.cellsIn('hot')).toEqual([ORIGIN])
    expect(s.cellsIn('warm')).toHaveLength(6)
    expect(s.metrics().cells).toEqual({ hot: 1, warm: 6, cold: 0 })
  })

  test('two players in one cell make one hot cell; two apart make two', () => {
    const { s } = rig({ radius: 1 })
    s.setPresence([ORIGIN, ORIGIN])
    expect(s.cellsIn('hot')).toHaveLength(1)
    s.setPresence([ORIGIN, H(10, 0)])
    expect(s.cellsIn('hot')).toHaveLength(2)
    expect(s.cellsIn('warm')).toHaveLength(12)
  })

  test('hysteresis ring keeps a cell ticking (warm) after the player steps away', () => {
    const { s } = rig({ radius: 1, extra: 1 })
    const log: string[] = []
    s.register(logger(log, 't', { hot: 100, warm: 100 }))
    s.setPresence([ORIGIN])
    s.step(0)
    const diff = s.setPresence([H(2, 0)]) // two cells away
    expect(s.tierOf(ORIGIN)).toBe('warm') // inside radius+extra of the new cell: kept
    expect(diff.deactivated).toContainEqual(H(-1, 0)) // distance 3 > radius + extra
    expect(diff.deactivated).not.toContainEqual(ORIGIN)
    s.setPresence([H(6, 0)])
    expect(s.tierOf(ORIGIN)).toBeUndefined()
  })

  test('deactivated cells stop running at once and their entries are dropped', () => {
    const { s } = rig({ radius: 1, extra: 0 })
    const log: string[] = []
    s.register(logger(log, 't', { hot: 100, warm: 100 }))
    s.setPresence([ORIGIN])
    s.step(0)
    expect(log).toHaveLength(7)
    const diff = s.setPresence([H(10, 0)])
    expect(diff.deactivated).toHaveLength(7)
    log.length = 0
    s.step(100)
    expect(log.every((l) => l.startsWith('t@') && l.includes('@100'))).toBe(
      true,
    )
    expect(log.map((l) => l.split('@')[1]).some((c) => c === '0,0')).toBe(false)
    expect(s.metrics().entries).toBe(7)
  })

  test('re-entering a cell starts fresh (dt = interval, new entry)', () => {
    const { s } = rig({ radius: 0, extra: 0 })
    const dts: number[] = []
    s.register({
      id: 't',
      tiers: { hot: 100, warm: 100 },
      run: (_c, ctx) => void dts.push(ctx.dt),
    })
    s.setPresence([ORIGIN])
    s.step(0)
    s.step(100)
    s.setPresence([H(5, 5)])
    s.step(150)
    s.setPresence([ORIGIN])
    s.step(900)
    expect(dts).toEqual([100, 100, 100, 100]) // origin x2, (5,5), origin again
  })

  test('shares an ActiveSet with the caller', () => {
    const active = new ActiveSet(1, 1)
    const { s } = rig({ active })
    expect(s.active).toBe(active)
    s.setPresence([ORIGIN])
    expect(active.size).toBe(7)
  })

  test('clearCells empties the grid but keeps tickers', () => {
    const { s } = rig()
    s.register({ id: 't', tiers: { hot: 10, warm: 10 }, run() {} })
    s.setPresence([ORIGIN])
    s.clearCells()
    expect(s.metrics().cells).toEqual({ hot: 0, warm: 0, cold: 0 })
    expect(s.metrics().entries).toBe(0)
    expect(s.active.size).toBe(0)
    expect(s.tickerIds()).toEqual(['t'])
  })

  test('walking player across the map: hot cell always the player cell, bounded work', () => {
    const SIZE = 250
    const { s } = rig({ radius: 2, extra: 1, budget: { maxCalls: 10_000 } })
    const presence = new PresenceTracker(SIZE, 10)
    const hotSeen = new Set<number>()
    s.register({
      id: 'npcs',
      tiers: { hot: 250, warm: 1000 },
      run(cell, ctx) {
        if (ctx.tier === 'hot') hotSeen.add(hexKeyOf(cell))
      },
    })
    let x = 0
    for (let t = 0; t <= 60_000; t += 200) {
      x += 14 // ~70 m/s: sprinting a motorbike
      presence.update('p1', x, 0)
      const cell = presence.cellOf('p1')!
      s.setPresence([cell])
      expect(s.tierOf(cell)).toBe('hot')
      const r = s.step(t)
      expect(r.calls).toBeLessThanOrEqual(37) // never more than a radius-3 disk (active + hysteresis)
    }
    const m = s.metrics()
    expect(m.cells.hot).toBe(1)
    expect(m.cells.warm).toBeGreaterThanOrEqual(18) // radius 2: 19 cells, one hot
    expect(m.cells.warm).toBeLessThanOrEqual(36) // plus hysteresis leftovers
    expect(hotSeen.size).toBeGreaterThan(8) // crossed many cells
    expect(hexCenter(presence.cellOf('p1')!, SIZE)[0]).toBeGreaterThan(0)
  })
})

describe('budget', () => {
  test('maxCalls caps a step and reports what was deferred', () => {
    const { s } = rig({ budget: { maxCalls: 3 } })
    const log: string[] = []
    s.register(logger(log, 't', { hot: 1000, warm: 1000 }))
    s.setTiers(
      Array.from({ length: 10 }, (_, i) => H(i, 0)),
      [],
    )
    const r = s.step(0)
    expect(r.calls).toBe(3)
    expect(r.deferred).toBe(7)
    expect(s.step(0).deferred).toBe(4) // same instant: the leftovers go next
    expect(s.step(0).deferred).toBe(1)
    expect(s.step(0).deferred).toBe(0)
    expect(log).toHaveLength(10)
    expect(new Set(log).size).toBe(10) // each cell exactly once
  })

  test('maxMs stops when the measured time runs out; overrun is reported', () => {
    const { s, clock } = rig({ budget: { maxMs: 10 } })
    const log: string[] = []
    s.register(logger(log, 't', { hot: 1000, warm: 1000 }, 3, clock))
    s.setTiers(
      Array.from({ length: 10 }, (_, i) => H(i, 0)),
      [],
    )
    const r = s.step(0)
    // 3 ms each: checked before every call after the first; stops once 12 ms >= 10 ms
    expect(r.calls).toBe(4)
    expect(r.ms).toBe(12)
    expect(r.overrun).toBe(true)
    expect(r.deferred).toBe(6)
    expect(s.metrics().overruns).toBe(1)
  })

  test('within budget there is no overrun and nothing deferred', () => {
    const { s, clock } = rig({ budget: { maxMs: 100 } })
    s.register(logger([], 't', { hot: 1000, warm: 1000 }, 3, clock))
    s.setTiers([ORIGIN, H(1, 0)], [])
    const r = s.step(0)
    expect(r).toMatchObject({ calls: 2, ms: 6, overrun: false, deferred: 0 })
  })

  test('a zero budget still makes progress: one call per step', () => {
    const { s } = rig({ budget: { maxMs: 0, maxCalls: 0 } })
    const log: string[] = []
    s.register(logger(log, 't', { hot: 1000, warm: 1000 }))
    s.setTiers([H(0, 0), H(1, 0), H(2, 0)], [])
    s.step(0)
    s.step(0)
    s.step(0)
    expect(log).toHaveLength(3)
    expect(new Set(log).size).toBe(3)
  })

  test('budget is live: change it between steps', () => {
    const { s } = rig({ budget: { maxCalls: 1 } })
    const log: string[] = []
    s.register(logger(log, 't', { hot: 1000, warm: 1000 }))
    s.setTiers([H(0, 0), H(1, 0), H(2, 0)], [])
    s.step(0)
    expect(log).toHaveLength(1)
    s.budget.maxCalls = Infinity
    s.step(0)
    expect(log).toHaveLength(3)
  })

  test('an idle step is cheap and clean', () => {
    const { s } = rig()
    expect(s.step(0)).toMatchObject({
      calls: 0,
      errors: 0,
      deferred: 0,
      overrun: false,
    })
  })
})

describe('fairness', () => {
  test('under sustained overload every cell gets the same share (+/- 1 call)', () => {
    const { s } = rig({ budget: { maxCalls: 4 } })
    const counts = new Map<string, number>()
    s.register({
      id: 't',
      tiers: { hot: 100, warm: 100 },
      run: (c) =>
        void counts.set(
          `${c.q},${c.r}`,
          (counts.get(`${c.q},${c.r}`) ?? 0) + 1,
        ),
    })
    s.setTiers(
      Array.from({ length: 10 }, (_, i) => H(i, i % 3)),
      [],
    )
    // demand 10 calls per step, capacity 4
    drive(s, 0, 9900, 100)
    const values = [...counts.values()]
    expect(counts.size).toBe(10)
    expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1)
    expect(values.reduce((a, b) => a + b, 0)).toBe(400)
  })

  test('a cell with many due tickers does not crowd out a cell with one', () => {
    const { s } = rig({ budget: { maxCalls: 2 } })
    const log: string[] = []
    for (const id of ['a1', 'a2', 'a3'])
      s.register(logger(log, id, { hot: 1000, warm: 1000 }))
    s.setTiers([H(0, 0), H(1, 0)], [])
    // Every ticker runs on both cells: 6 due, 2 per step. Each step serves both cells.
    s.step(0)
    const cells = new Set(log.map((l) => l.split('@')[1]))
    expect(cells).toEqual(new Set(['0,0', '1,0']))
    s.step(0)
    s.step(0)
    expect(log).toHaveLength(6)
    expect(new Set(log).size).toBe(6)
  })

  test('within a cell the most overdue ticker (relative to its interval) goes first', () => {
    const { s } = rig({ budget: { maxCalls: 1 } })
    const order: string[] = []
    // registered slow first, so registration order cannot explain the result
    s.register({
      id: 'slow',
      tiers: { hot: 1000, warm: 1000 },
      run: () => void order.push('slow'),
    })
    s.register({
      id: 'fast',
      tiers: { hot: 100, warm: 100 },
      run: () => void order.push('fast'),
    })
    s.setTiers([ORIGIN], [])
    s.step(0)
    s.step(0)
    order.length = 0
    s.budget.maxCalls = 1
    // fast due 100 (late 1100 = 11 intervals), slow due 1000 (late 200 = 0.2 intervals)
    s.step(1200)
    s.step(1200)
    expect(order).toEqual(['fast', 'slow'])
  })

  test('nothing starves: skipped work is picked up before newer work', () => {
    const { s } = rig({ budget: { maxCalls: 1 } })
    const log: string[] = []
    s.register(logger(log, 't', { hot: 1000, warm: 1000 }))
    s.setTiers([H(0, 0), H(1, 0), H(2, 0)], [])
    s.step(0)
    s.step(0)
    s.step(0)
    expect(new Set(log.map((l) => l.split('@')[1]))).toEqual(
      new Set(['0,0', '1,0', '2,0']),
    )
  })
})

describe('time handling', () => {
  test('a long gap does not cause a burst: one run, missed intervals counted, phase kept', () => {
    const { s } = rig()
    const log: string[] = []
    s.register(logger(log, 't', { hot: 100, warm: 100 }))
    s.setTiers([ORIGIN], [])
    s.step(0)
    s.step(1000) // stalled for 1 s
    expect(log).toHaveLength(2)
    expect(s.metrics().skipped).toBe(9)
    expect(s.metrics().tickers.t?.skipped).toBe(9)
    s.step(1050)
    expect(log).toHaveLength(2)
    s.step(1100)
    expect(log).toHaveLength(3)
  })

  test('step rate caps granularity: a 100 ms ticker on a 250 ms loop runs every step', () => {
    const { s } = rig()
    const log: string[] = []
    s.register(logger(log, 't', { hot: 100, warm: 100 }))
    s.setTiers([ORIGIN], [])
    drive(s, 0, 1000, 250)
    expect(log).toHaveLength(5)
    expect(s.metrics().skipped).toBeGreaterThan(0)
  })

  test('an interval longer than the step is honoured exactly', () => {
    const { s } = rig()
    const log: string[] = []
    s.register(logger(log, 't', { hot: 1000, warm: 1000 }))
    s.setTiers([ORIGIN], [])
    drive(s, 0, 3999, 100)
    expect(log.map((l) => l.split('@')[2])).toEqual([
      '0',
      '1000',
      '2000',
      '3000',
    ])
  })
})

describe('jitter', () => {
  const cellsGrid = Array.from({ length: 60 }, (_, i) =>
    H(i % 10, Math.floor(i / 10)),
  )

  function timeline(options: SchedulerOptions, order: 'ab' | 'ba' = 'ab') {
    const { s } = rig(options)
    const log: string[] = []
    const defs = [
      logger(log, 'alpha', { hot: 200, warm: 200 }),
      logger(log, 'beta', { hot: 200, warm: 200 }),
    ]
    for (const d of order === 'ab' ? defs : [...defs].reverse()) s.register(d)
    s.setTiers(cellsGrid, [])
    drive(s, 0, 600, 10)
    return log
  }

  test('is deterministic: same seed, same timeline', () => {
    expect(timeline({ jitter: 1, seed: 7 })).toEqual(
      timeline({ jitter: 1, seed: 7 }),
    )
  })

  test('does not depend on registration order', () => {
    const a = timeline({ jitter: 1, seed: 3 }).sort()
    const b = timeline({ jitter: 1, seed: 3 }, 'ba').sort()
    expect(a).toEqual(b)
  })

  test('a different seed gives a different pattern', () => {
    expect(timeline({ jitter: 1, seed: 1 })).not.toEqual(
      timeline({ jitter: 1, seed: 2 }),
    )
  })

  test('spreads runs instead of aligning them on one frame', () => {
    const { s } = rig({ jitter: 1 })
    s.register({ id: 'a', tiers: { hot: 200, warm: 200 }, run() {} })
    s.register({ id: 'b', tiers: { hot: 200, warm: 200 }, run() {} })
    s.setTiers(cellsGrid, [])
    const perStep: number[] = []
    for (let t = 0; t < 1000; t += 10) perStep.push(s.step(t).calls)
    const steady = perStep.slice(30) // after every entry has had its first run
    const total = steady.reduce((a, b) => a + b, 0)
    expect(total).toBeGreaterThanOrEqual(120 * 3) // 700 ms window: 3 or 4 runs per pair
    expect(total).toBeLessThanOrEqual(120 * 4)
    expect(Math.max(...steady)).toBeLessThan(25) // not all 120 at once
    expect(Math.min(...steady)).toBeGreaterThan(0)
  })

  test('with jitter 0 everything is due on the first step', () => {
    const { s } = rig({ jitter: 0 })
    s.register({ id: 'a', tiers: { hot: 200, warm: 200 }, run() {} })
    s.setTiers(cellsGrid, [])
    expect(s.step(0).calls).toBe(60)
  })

  test('two tickers on the same cell are not phase-locked', () => {
    const { s } = rig({ jitter: 1 })
    const first = new Map<string, number>()
    for (const id of ['a', 'b', 'c', 'd']) {
      s.register({
        id,
        tiers: { hot: 1000, warm: 1000 },
        run: (cell, ctx) => {
          const k = `${id}@${cell.q},${cell.r}`
          if (!first.has(k)) first.set(k, ctx.now)
        },
      })
    }
    s.setTiers(cellsGrid, [])
    drive(s, 0, 999, 1)
    const perCell = cellsGrid.map(
      (c) =>
        new Set(
          ['a', 'b', 'c', 'd'].map((id) => first.get(`${id}@${c.q},${c.r}`)),
        ).size,
    )
    expect(perCell.filter((n) => n > 1).length).toBeGreaterThan(55)
  })
})

describe('errors', () => {
  test('a throwing ticker does not stop the others or the loop', () => {
    const errors: { id: string; msg: string; cell: Hex; tier: string }[] = []
    const { s } = rig({
      onError: (e, info) =>
        errors.push({
          id: info.tickerId,
          msg: (e as Error).message,
          cell: info.cell,
          tier: info.tier,
        }),
    })
    const log: string[] = []
    s.register({
      id: 'bad',
      tiers: { hot: 100, warm: 100 },
      run() {
        throw new Error('boom')
      },
    })
    s.register(logger(log, 'good', { hot: 100, warm: 100 }))
    s.setTiers([ORIGIN, H(1, 0)], [])
    const r = s.step(0)
    expect(r.calls).toBe(4)
    expect(r.errors).toBe(2)
    expect(log).toHaveLength(2)
    s.step(100)
    expect(log).toHaveLength(4) // keeps going
    expect(errors).toHaveLength(4)
    expect(errors[0]).toMatchObject({ id: 'bad', msg: 'boom', tier: 'hot' })
    const m = s.metrics()
    expect(m.errors).toBe(4)
    expect(m.tickers.bad).toMatchObject({ calls: 4, errors: 4 })
    expect(m.tickers.bad?.lastError).toMatchObject({ message: 'boom', at: 100 })
    expect(m.tickers.good).toMatchObject({ calls: 4, errors: 0 })
    expect(m.tickers.good?.lastError).toBeUndefined()
  })

  test('non-Error throws are reported as text', () => {
    const { s } = rig()
    s.register({
      id: 'x',
      tiers: { hot: 100, warm: 100 },
      run() {
        throw 'plain string'
      },
    })
    s.setTiers([ORIGIN], [])
    s.step(0)
    expect(s.metrics().tickers.x?.lastError?.message).toBe('plain string')
  })

  test('a throwing onError hook cannot take the loop down', () => {
    const { s } = rig({
      onError() {
        throw new Error('hook failed')
      },
    })
    const log: string[] = []
    s.register({
      id: 'bad',
      tiers: { hot: 100, warm: 100 },
      run() {
        throw new Error('boom')
      },
    })
    s.register(logger(log, 'good', { hot: 100, warm: 100 }))
    s.setTiers([ORIGIN], [])
    expect(() => s.step(0)).not.toThrow()
    expect(log).toHaveLength(1)
    expect(s.metrics().errors).toBe(1)
  })

  test('a failing run is still rescheduled (no hot loop on the same call)', () => {
    const { s } = rig()
    let n = 0
    s.register({
      id: 'x',
      tiers: { hot: 100, warm: 100 },
      run() {
        n += 1
        throw new Error('boom')
      },
    })
    s.setTiers([ORIGIN], [])
    s.step(0)
    s.step(0)
    s.step(50)
    expect(n).toBe(1)
    s.step(100)
    expect(n).toBe(2)
  })

  test('a rejected promise is counted too', async () => {
    const errors: unknown[] = []
    const { s } = rig({ onError: (e) => errors.push(e) })
    s.register({
      id: 'async',
      tiers: { hot: 100, warm: 100 },
      run: () => Promise.reject(new Error('late boom')),
    })
    s.setTiers([ORIGIN], [])
    s.step(0)
    await new Promise((r) => setTimeout(r, 0))
    expect(errors).toHaveLength(1)
    expect(s.metrics().tickers.async).toMatchObject({ errors: 1 })
    expect(s.metrics().tickers.async?.lastError?.message).toBe('late boom')
  })

  test('errors are included in time metrics', () => {
    const { s, clock } = rig()
    s.register({
      id: 'x',
      tiers: { hot: 100, warm: 100 },
      run() {
        clock.t += 5
        throw new Error('boom')
      },
    })
    s.setTiers([ORIGIN], [])
    s.step(0)
    expect(s.metrics().tickers.x).toMatchObject({
      calls: 1,
      errors: 1,
      totalMs: 5,
      maxMs: 5,
    })
  })
})

describe('re-entrancy', () => {
  test('a ticker can unregister another; the removed one does not run later in the step', () => {
    const { s } = rig()
    const log: string[] = []
    s.register({
      id: 'killer',
      tiers: { hot: 100, warm: 100 },
      run: () => void s.unregister('victim'),
    })
    s.register(logger(log, 'victim', { hot: 100, warm: 100 }))
    s.setTiers([ORIGIN], [H(1, 0)])
    s.step(0)
    expect(log).toHaveLength(0)
    expect(s.tickerIds()).toEqual(['killer'])
  })

  test('a ticker can move presence; cells that vanish mid-step are skipped', () => {
    const { s } = rig({ radius: 1, extra: 0 })
    const log: string[] = []
    s.register({
      id: 'mover',
      tiers: { hot: 100, warm: 100 },
      run(cell) {
        log.push(`m@${cell.q},${cell.r}`)
        s.setPresence([H(50, 50)])
      },
    })
    s.setPresence([ORIGIN])
    const r = s.step(0)
    expect(r.calls).toBe(1) // the other 6 cells no longer exist
    expect(r.deferred).toBe(0)
    expect(log).toHaveLength(1)
  })

  test('a ticker can register another ticker; it starts next step', () => {
    const { s } = rig()
    const log: string[] = []
    s.register({
      id: 'parent',
      tiers: { hot: 1000, warm: 1000 },
      run() {
        if (!s.tickerIds().includes('child'))
          s.register(logger(log, 'child', { hot: 100, warm: 100 }))
      },
    })
    s.setTiers([ORIGIN], [])
    s.step(0)
    expect(log).toHaveLength(0)
    s.step(10)
    expect(log).toHaveLength(1)
  })
})

describe('metrics', () => {
  test('counts calls, time, cells per tier and live entries; JSON-safe', () => {
    const { s, clock } = rig({ budget: { maxMs: 1000 } })
    s.register(logger([], 'a', { hot: 100, warm: 200 }, 2, clock))
    s.register(logger([], 'b', { hot: 100, warm: 200 }, 4, clock))
    s.setTiers([ORIGIN], [H(1, 0), H(2, 0)])
    s.step(0)
    s.step(100)
    const m = s.metrics()
    expect(m.steps).toBe(2)
    expect(m.calls).toBe(8) // a,b on 3 cells at t=0, a,b on the hot cell at t=100
    expect(m.cells).toEqual({ hot: 1, warm: 2, cold: 0 })
    expect(m.entries).toBe(6)
    expect(m.tickers.a).toMatchObject({
      calls: 4,
      totalMs: 8,
      maxMs: 2,
      errors: 0,
    })
    expect(m.tickers.b).toMatchObject({ calls: 4, totalMs: 16, maxMs: 4 })
    expect(m.lastStep).toMatchObject({ now: 100, calls: 2 })
    expect(JSON.parse(JSON.stringify(m))).toEqual(m)
  })

  test('snapshots do not alias internal state', () => {
    const { s } = rig()
    s.register({ id: 'a', tiers: { hot: 100, warm: 100 }, run() {} })
    s.setTiers([ORIGIN], [])
    s.step(0)
    const before = s.metrics()
    s.step(100)
    expect(before.calls).toBe(1)
    expect(before.tickers.a?.calls).toBe(1)
    expect(s.metrics().tickers.a?.calls).toBe(2)
  })

  test('resetMetrics zeroes counters but keeps scheduling state', () => {
    const { s } = rig()
    s.register({
      id: 'a',
      tiers: { hot: 100, warm: 100 },
      run() {
        throw new Error('x')
      },
    })
    s.setTiers([ORIGIN], [])
    s.step(0)
    s.resetMetrics()
    const m = s.metrics()
    expect(m).toMatchObject({
      steps: 0,
      calls: 0,
      errors: 0,
      overruns: 0,
      skipped: 0,
    })
    expect(m.tickers.a).toEqual({
      calls: 0,
      errors: 0,
      totalMs: 0,
      maxMs: 0,
      skipped: 0,
    })
    expect(m.lastStep).toBeUndefined()
    expect(m.cells.hot).toBe(1)
    s.step(100)
    expect(s.metrics().calls).toBe(1)
  })
})

describe('whole-system determinism', () => {
  function run(seed: number): string[] {
    const { s, clock } = rig({
      radius: 2,
      extra: 1,
      jitter: 1,
      seed,
      budget: { maxCalls: 12, maxMs: 6 },
    })
    const log: string[] = []
    s.register(
      logger(log, 'npc', { hot: 150, warm: 600, cold: 5000 }, 1, clock),
    )
    s.register(logger(log, 'econ', { hot: 1000, warm: 1000 }, 2, clock))
    s.setColdCells([H(20, 20), H(21, 20)])
    let q = 0
    for (let t = 0; t < 20_000; t += 100) {
      if (t % 1000 === 0) q += 1
      s.setPresence([H(q, 0), H(-q, 3)])
      s.step(t)
    }
    return log
  }

  test('same inputs, same call log', () => {
    expect(run(1)).toEqual(run(1))
    expect(run(1).length).toBeGreaterThan(100)
    expect(run(1)).not.toEqual(run(2))
  })
})
