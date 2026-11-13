import { type ActivationDiff, ActiveSet } from './activation'
import { type Hex, hexKeyOf, keyToHex } from './hex'
import type { HexLayer } from './layer'

/**
 * Per-cell ticking. Systems register tickers; each ticker runs once per cell
 * at a rate that depends on how "close" the cell is to players:
 *
 * - `hot`:  a player is in the cell.
 * - `warm`: the cell is active (inside the activation radius or its hysteresis
 *           ring) but nobody is in it.
 * - `cold`: known but inactive. Only runs if the ticker defines `cold`.
 *
 * One external loop calls `step(nowMs)`; the scheduler decides which
 * (ticker, cell) pairs are due and runs as many as the budget allows. It does
 * not own a timer and never touches a runtime API, so it runs in FiveM's V8
 * as well as in tests with a fake clock.
 */

export type Tier = 'hot' | 'warm' | 'cold'

/** Milliseconds between runs per tier. A missing `cold` means "never run on cold cells". */
export type TickIntervals = {
  readonly hot: number
  readonly warm: number
  readonly cold?: number
}

export type TickerDef = {
  readonly id: string
  readonly tiers: TickIntervals
  /**
   * Called once per due (ticker, cell). Keep it short: the budget is checked
   * between calls, never inside one. A returned promise is observed only for
   * rejections (counted as errors); its duration is not measured.
   */
  run(cell: Hex, ctx: TickContext): void | PromiseLike<unknown>
}

export type ErrorInfo = {
  readonly tickerId: string
  readonly cell: Hex
  readonly tier: Tier
  readonly now: number
}

export type SchedulerOptions = {
  /** Share an `ActiveSet` with the code that spawns/despawns. Default: a new one. */
  active?: ActiveSet
  /** Used only when `active` is not given. Default 1. */
  radius?: number
  /** Used only when `active` is not given: hysteresis rings. Default 1. */
  extra?: number
  /** Per-step budget. `maxMs` default 8, `maxCalls` default unlimited. */
  budget?: { maxMs?: number; maxCalls?: number }
  /** 0..1: fraction of a ticker's interval its first run is spread over. Default 1. */
  jitter?: number
  /** Changes the deterministic jitter pattern. Default 0. */
  seed?: number
  /** Monotonic ms used to measure run cost against the budget. Default `performance.now`. */
  clock?: () => number
  /** Called for every ticker error (sync throw or promise rejection). Must not throw. */
  onError?: (error: unknown, info: ErrorInfo) => void
}

export type StepResult = {
  readonly now: number
  /** Ticker calls made this step. */
  readonly calls: number
  readonly errors: number
  /** Time spent in this step, by the scheduler's clock. */
  readonly ms: number
  /** Due (ticker, cell) pairs left for the next step because the budget ran out. */
  readonly deferred: number
  /** The step took longer than `budget.maxMs`. */
  readonly overrun: boolean
}

export type TickerMetrics = {
  calls: number
  errors: number
  totalMs: number
  maxMs: number
  /** Intervals that elapsed without a run (step rate too low, or deferred by the budget). */
  skipped: number
  lastError?: { message: string; at: number; cell: Hex }
}

export type SchedulerMetrics = {
  steps: number
  calls: number
  errors: number
  /** Steps that took longer than `budget.maxMs`. */
  overruns: number
  skipped: number
  /** Sum of `deferred` over all steps. */
  deferred: number
  cells: { hot: number; warm: number; cold: number }
  /** Live (ticker, cell) pairs. */
  entries: number
  lastStep?: StepResult
  tickers: Record<string, TickerMetrics>
}

/** What a ticker sees besides the cell. */
export class TickContext {
  constructor(
    readonly scheduler: TickScheduler,
    readonly tickerId: string,
    readonly cell: Hex,
    readonly tier: Tier,
    /** The `nowMs` of the step that runs this call. */
    readonly now: number,
    /** Ms since this ticker last ran on this cell (its interval, on the first run). */
    readonly dt: number,
  ) {}

  /** This cell's value in a named `HexLayer` (see `TickScheduler.addLayer`). */
  get<T>(layer: string): T | undefined {
    return this.scheduler.layer<T>(layer)?.get(this.cell)
  }
}

type Ticker = {
  readonly def: TickerDef
  readonly order: number
  readonly hash: number
  readonly metrics: TickerMetrics
}

type Entry = {
  readonly ticker: Ticker
  readonly key: number
  readonly cell: Hex
  tier: Tier
  interval: number
  /** Next due time; `null` until the first step sees the entry. */
  due: number | null
  /** Interval shrank (cell got hotter): pull `due` in at the next step. */
  retime: boolean
  last: number | null
  alive: boolean
}

function defaultClock(): number {
  const p = (globalThis as { performance?: { now(): number } }).performance
  return p ? p.now() : Date.now()
}

/** FNV-1a over UTF-16 code units. */
function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Murmur3-style finaliser of two 32-bit words. */
function mix(a: number, b: number): number {
  let h = (a ^ Math.imul(b, 0x9e3779b1)) >>> 0
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b) >>> 0
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35) >>> 0
  h ^= h >>> 16
  return h >>> 0
}

function checkInterval(name: string, v: unknown): void {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    throw new RangeError(`tier "${name}" must be a finite number of ms > 0`)
  }
}

export class TickScheduler {
  /** Live budget: change it at any time (dev panel, adaptive load shedding). */
  readonly budget: { maxMs: number; maxCalls: number }
  readonly active: ActiveSet

  private readonly tickers = new Map<string, Ticker>()
  private readonly layers = new Map<string, HexLayer<unknown>>()
  /** Entries grouped by cell, so fairness is per cell. */
  private readonly byCell = new Map<number, Map<string, Entry>>()
  private hot = new Set<number>()
  private warm = new Set<number>()
  private cold = new Set<number>()
  private tiers = new Map<number, Tier>()
  private nextOrder = 0
  private cursor = -1
  private readonly jitter: number
  private readonly seed: number
  private readonly clock: () => number
  private readonly onError?: (error: unknown, info: ErrorInfo) => void
  private now = 0
  private counters = TickScheduler.freshCounters()
  private lastStep?: StepResult

  constructor(options: SchedulerOptions = {}) {
    this.active =
      options.active ?? new ActiveSet(options.radius ?? 1, options.extra ?? 1)
    this.budget = {
      maxMs: options.budget?.maxMs ?? 8,
      maxCalls: options.budget?.maxCalls ?? Infinity,
    }
    this.jitter = Math.min(1, Math.max(0, options.jitter ?? 1))
    this.seed = (options.seed ?? 0) >>> 0
    this.clock = options.clock ?? defaultClock
    this.onError = options.onError
  }

  // --- tickers and layers -------------------------------------------------

  /** Register a ticker. Returns the function that unregisters it. */
  register(def: TickerDef): () => void {
    if (!def.id) throw new RangeError('ticker id must not be empty')
    if (this.tickers.has(def.id))
      throw new Error(`ticker "${def.id}" is already registered`)
    checkInterval('hot', def.tiers.hot)
    checkInterval('warm', def.tiers.warm)
    if (def.tiers.cold !== undefined) checkInterval('cold', def.tiers.cold)
    const ticker: Ticker = {
      def,
      order: this.nextOrder++,
      hash: mix(hashString(def.id), this.seed),
      metrics: { calls: 0, errors: 0, totalMs: 0, maxMs: 0, skipped: 0 },
    }
    this.tickers.set(def.id, ticker)
    for (const [key, tier] of this.tiers) this.attach(ticker, key, tier)
    return () => this.unregister(def.id)
  }

  unregister(id: string): boolean {
    const ticker = this.tickers.get(id)
    if (!ticker) return false
    this.tickers.delete(id)
    for (const [key, m] of this.byCell) {
      const e = m.get(id)
      if (!e) continue
      e.alive = false
      m.delete(id)
      if (m.size === 0) this.byCell.delete(key)
    }
    return true
  }

  tickerIds(): string[] {
    return [...this.tickers.keys()]
  }

  /** Expose a layer to tickers through `ctx.get(name)`. */
  addLayer<T>(name: string, layer: HexLayer<T>): this {
    this.layers.set(name, layer as HexLayer<unknown>)
    return this
  }

  layer<T>(name: string): HexLayer<T> | undefined {
    return this.layers.get(name) as HexLayer<T> | undefined
  }

  // --- cells --------------------------------------------------------------

  /**
   * One call per server loop: cells holding a source (player) become hot, the
   * rest of the active set (radius + hysteresis ring) becomes warm, everything
   * that leaves the active set stops. Returns the `ActiveSet` diff so the same
   * call can drive spawn/despawn.
   */
  setPresence(sources: readonly Hex[]): ActivationDiff {
    const diff = this.active.update(sources)
    this.setTiers(sources, this.active.cells())
    return diff
  }

  /**
   * Lower level than `setPresence`: replace the hot and warm cell sets directly
   * (a cell in both is hot). Use it when activation is computed elsewhere.
   */
  setTiers(hot: Iterable<Hex>, warm: Iterable<Hex>): void {
    this.hot = new Set([...hot].map(hexKeyOf))
    this.warm = new Set([...warm].map(hexKeyOf))
    this.rebuild()
  }

  /**
   * Cells that exist but are inactive (a cell that is hot or warm is not cold).
   * Only matters for tickers that define a `cold` interval.
   */
  setColdCells(cells: Iterable<Hex>): void {
    this.cold = new Set([...cells].map(hexKeyOf))
    this.rebuild()
  }

  tierOf(hex: Hex): Tier | undefined {
    return this.tiers.get(hexKeyOf(hex))
  }

  cellsIn(tier: Tier): Hex[] {
    const out: Hex[] = []
    for (const [key, t] of this.tiers) if (t === tier) out.push(keyToHex(key))
    return out
  }

  /** Forget every cell. Tickers stay registered. */
  clearCells(): void {
    this.active.update([])
    this.hot = new Set()
    this.warm = new Set()
    this.cold = new Set()
    this.rebuild()
  }

  // --- the loop -----------------------------------------------------------

  /**
   * Run what is due at `nowMs` (any monotonic ms: `Date.now()`, `GetGameTimer()`).
   * Always runs at least one call when something is due, so a tiny budget
   * slows the world down instead of freezing it.
   */
  step(nowMs: number): StepResult {
    const t0 = this.clock()
    this.now = nowMs

    const dueByCell = new Map<number, Entry[]>()
    let dueCount = 0
    for (const [key, m] of this.byCell) {
      let list: Entry[] | undefined
      for (const e of m.values()) {
        if (e.due === null) e.due = nowMs + this.phase(e)
        else if (e.retime) e.due = Math.min(e.due, nowMs + this.phase(e))
        e.retime = false
        if (e.due > nowMs) continue
        if (!list) {
          list = []
          dueByCell.set(key, list)
        }
        list.push(e)
        dueCount += 1
      }
    }

    // Round-robin over cells, resuming after the last cell served; inside a
    // cell, the most overdue (relative to its interval) goes first.
    const keys = [...dueByCell.keys()].sort((a, b) => a - b)
    const start = keys.findIndex((k) => k > this.cursor)
    const order =
      start <= 0 ? keys : [...keys.slice(start), ...keys.slice(0, start)]
    for (const k of order) {
      dueByCell
        .get(k)!
        .sort(
          (a, b) =>
            (nowMs - b.due!) / b.interval - (nowMs - a.due!) / a.interval ||
            a.ticker.order - b.ticker.order,
        )
    }

    let calls = 0
    let errors = 0
    let attempted = 0
    let lastKey = this.cursor
    const { maxMs, maxCalls } = this.budget
    passes: for (let pass = 0; ; pass += 1) {
      let any = false
      for (const key of order) {
        const e = dueByCell.get(key)![pass]
        if (!e) continue
        any = true
        if (!e.alive) {
          attempted += 1
          continue
        }
        if (calls > 0 && (calls >= maxCalls || this.clock() - t0 >= maxMs))
          break passes
        attempted += 1
        calls += 1
        if (!this.runEntry(e, nowMs)) errors += 1
        lastKey = key
      }
      if (!any) break
    }
    this.cursor = lastKey

    const ms = this.clock() - t0
    const result: StepResult = {
      now: nowMs,
      calls,
      errors,
      ms,
      deferred: dueCount - attempted,
      overrun: ms > maxMs,
    }
    const c = this.counters
    c.steps += 1
    c.calls += calls
    c.overruns += result.overrun ? 1 : 0
    c.deferred += result.deferred
    this.lastStep = result
    return result
  }

  // --- metrics ------------------------------------------------------------

  /** A JSON-safe snapshot, for a dev panel. */
  metrics(): SchedulerMetrics {
    const cells = { hot: 0, warm: 0, cold: 0 }
    for (const t of this.tiers.values()) cells[t] += 1
    let entries = 0
    for (const m of this.byCell.values()) entries += m.size
    const tickers: Record<string, TickerMetrics> = {}
    for (const [id, t] of this.tickers) {
      const { lastError, ...rest } = t.metrics
      tickers[id] = lastError
        ? { ...rest, lastError: { ...lastError, cell: { ...lastError.cell } } }
        : { ...rest }
    }
    const c = this.counters
    return {
      steps: c.steps,
      calls: c.calls,
      errors: c.errors,
      overruns: c.overruns,
      skipped: c.skipped,
      deferred: c.deferred,
      cells,
      entries,
      lastStep: this.lastStep ? { ...this.lastStep } : undefined,
      tickers,
    }
  }

  resetMetrics(): void {
    this.counters = TickScheduler.freshCounters()
    this.lastStep = undefined
    for (const t of this.tickers.values()) {
      t.metrics.calls = 0
      t.metrics.errors = 0
      t.metrics.totalMs = 0
      t.metrics.maxMs = 0
      t.metrics.skipped = 0
      delete t.metrics.lastError
    }
  }

  // --- internals ----------------------------------------------------------

  private static freshCounters() {
    return {
      steps: 0,
      calls: 0,
      errors: 0,
      overruns: 0,
      skipped: 0,
      deferred: 0,
    }
  }

  private phase(e: Entry): number {
    const unit = mix(e.ticker.hash, e.key) / 0x100000000
    return Math.floor(unit * this.jitter * e.interval)
  }

  /** Returns false when the call threw. */
  private runEntry(e: Entry, nowMs: number): boolean {
    const ctx = new TickContext(
      this,
      e.ticker.def.id,
      e.cell,
      e.tier,
      nowMs,
      e.last === null ? e.interval : nowMs - e.last,
    )
    const m = e.ticker.metrics
    const tier = e.tier
    const started = this.clock()
    let ok = true
    try {
      const out = e.ticker.def.run(e.cell, ctx)
      if (out && typeof (out as PromiseLike<unknown>).then === 'function') {
        ;(out as PromiseLike<unknown>).then(undefined, (err: unknown) =>
          this.fail(e.ticker, e.cell, tier, nowMs, err),
        )
      }
    } catch (err) {
      ok = false
      this.fail(e.ticker, e.cell, tier, nowMs, err)
    }
    const ms = this.clock() - started
    m.calls += 1
    m.totalMs += ms
    if (ms > m.maxMs) m.maxMs = ms

    if (e.alive && e.due !== null) {
      // Keep the phase: skip the intervals that were missed instead of bursting.
      const missed = Math.floor((nowMs - e.due) / e.interval)
      if (missed > 0) {
        m.skipped += missed
        this.counters.skipped += missed
      }
      e.due += (missed + 1) * e.interval
      e.last = nowMs
    }
    return ok
  }

  private fail(
    ticker: Ticker,
    cell: Hex,
    tier: Tier,
    now: number,
    err: unknown,
  ): void {
    ticker.metrics.errors += 1
    this.counters.errors += 1
    ticker.metrics.lastError = {
      message: err instanceof Error ? err.message : String(err),
      at: now,
      cell: { q: cell.q, r: cell.r },
    }
    if (!this.onError) return
    try {
      this.onError(err, { tickerId: ticker.def.id, cell, tier, now })
    } catch {
      // A broken error hook must not take the loop down either.
    }
  }

  /** Recompute the effective tier of every cell and re-tier only what changed. */
  private rebuild(): void {
    const next = new Map<number, Tier>()
    for (const k of this.cold) next.set(k, 'cold')
    for (const k of this.warm) next.set(k, 'warm')
    for (const k of this.hot) next.set(k, 'hot')
    for (const [key, tier] of next) {
      if (this.tiers.get(key) !== tier) this.retier(key, tier)
    }
    for (const key of this.tiers.keys()) {
      if (!next.has(key)) this.retier(key, undefined)
    }
    this.tiers = next
  }

  private retier(key: number, tier: Tier | undefined): void {
    if (tier === undefined) {
      const m = this.byCell.get(key)
      if (m) for (const e of m.values()) e.alive = false
      this.byCell.delete(key)
      return
    }
    for (const ticker of this.tickers.values()) this.attach(ticker, key, tier)
  }

  /** Make `ticker`'s entry on cell `key` match `tier` (create, update or drop it). */
  private attach(ticker: Ticker, key: number, tier: Tier): void {
    const id = ticker.def.id
    const interval = ticker.def.tiers[tier]
    let m = this.byCell.get(key)
    const existing = m?.get(id)
    if (interval === undefined) {
      if (existing && m) {
        existing.alive = false
        m.delete(id)
        if (m.size === 0) this.byCell.delete(key)
      }
      return
    }
    if (existing) {
      if (interval < existing.interval) existing.retime = true
      existing.interval = interval
      existing.tier = tier
      return
    }
    if (!m) {
      m = new Map()
      this.byCell.set(key, m)
    }
    m.set(id, {
      ticker,
      key,
      cell: keyToHex(key),
      tier,
      interval,
      due: null,
      retime: false,
      last: null,
      alive: true,
    })
  }
}
