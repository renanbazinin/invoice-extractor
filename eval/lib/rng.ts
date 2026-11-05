/**
 * Seeded pseudo-random numbers for the corpus generator. Every document gets its own stream,
 * derived from a label such as `he-classic:7`, so adding a draw to one family (or one document)
 * never reshuffles every other document. That keeps the corpus stable across edits, which matters
 * because ground truth and extractor regressions are compared document by document.
 */

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number
  /** Integer in [min, max], both inclusive. */
  int(min: number, max: number): number
  pick<T>(items: readonly T[]): T
  chance(p: number): boolean
  /** Picks by relative weight. */
  weighted<T>(items: readonly (readonly [T, number])[]): T
  shuffle<T>(items: readonly T[]): T[]
  /** `n` distinct items (fewer when the list is shorter). */
  sample<T>(items: readonly T[], n: number): T[]
  /** Roughly standard-normal (Box-Muller). */
  normal(): number
  /** An independent stream for a sub-task, stable regardless of how many draws came before. */
  fork(label: string): Rng
}

/** 32-bit FNV-1a; good enough to spread string labels over seeds. */
export function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** mulberry32: tiny, fast, and identical on every platform (no Math.random). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function createRng(seed: number | string): Rng {
  const base = typeof seed === 'number' ? seed >>> 0 : hashString(seed)
  const next = mulberry32(base)
  const rng: Rng = {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => {
      if (!items.length) throw new Error('pick from an empty list')
      return items[Math.floor(next() * items.length)]
    },
    chance: (p) => next() < p,
    weighted: (items) => {
      const total = items.reduce((s, [, w]) => s + w, 0)
      let r = next() * total
      for (const [item, w] of items) {
        r -= w
        if (r < 0) return item
      }
      return items[items.length - 1][0]
    },
    shuffle: (items) => {
      const out = [...items]
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1))
        ;[out[i], out[j]] = [out[j], out[i]]
      }
      return out
    },
    sample: (items, n) => rng.shuffle(items).slice(0, n),
    normal: () => {
      const u = 1 - next()
      const v = next()
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
    },
    fork: (label) => createRng((base ^ hashString(label)) >>> 0),
  }
  return rng
}
