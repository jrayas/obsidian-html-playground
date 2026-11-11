/** Rate and size limits (pure). Message size can only be checked after receipt; these cap what we do with it. */

const MB = 1024 * 1024;

export interface Limits {
  readTextBytes: number;
  readBinaryBytes: number;
  /** Largest text a single write may carry. */
  writeTextBytes: number;
  /** Largest front matter patch. */
  frontmatterBytes: number;
  parseTextBytes: number;
  yamlBytes: number;
  storageBytes: number;
  listEntries: number;
  searchResults: number;
  searchFiles: number;
  searchMs: number;
  searchContentBytes: number;
  maxInFlight: number;
  /** Touching more files than this asks the user first. */
  bulkConfirmFiles: number;
  /** Hard cap on files one operation may touch. */
  bulkCapFiles: number;
  /** Entries examined when walking a folder. */
  subtreeEntries: number;
  /** Opening notes and showing dialogs. */
  uiRate: { capacity: number; perSec: number };
  /** Live file events delivered per second. */
  eventRate: { capacity: number; perSec: number };
  maxSubscriptions: number;
  /** Backlinks or outgoing links returned. */
  linkResults: number;
  readRate: { capacity: number; perSec: number };
  writeRate: { capacity: number; perSec: number };
}

const BASE: Limits = {
  readTextBytes: 5 * MB,
  readBinaryBytes: 10 * MB,
  writeTextBytes: 5 * MB,
  frontmatterBytes: 64 * 1024,
  parseTextBytes: 1 * MB,
  yamlBytes: 256 * 1024,
  storageBytes: 1 * MB,
  listEntries: 5000,
  searchResults: 200,
  searchFiles: 5000,
  searchMs: 2000,
  searchContentBytes: 1 * MB,
  maxInFlight: 20,
  bulkConfirmFiles: 10,
  bulkCapFiles: 50,
  subtreeEntries: 1000,
  uiRate: { capacity: 5, perSec: 0.2 },
  eventRate: { capacity: 100, perSec: 50 },
  maxSubscriptions: 20,
  linkResults: 1000,
  readRate: { capacity: 100, perSec: 50 },
  writeRate: { capacity: 20, perSec: 10 },
};

/** Trusted apps get higher rates, a larger write size and a higher bulk cap (200 files) only (see docs/phases/phase-2-bridge.md, Q18). */
export function limitsFor(trusted: boolean): Limits {
  if (!trusted) return BASE;
  return {
    ...BASE,
    writeTextBytes: BASE.writeTextBytes * 5,
    bulkCapFiles: 200,
    readRate: { capacity: BASE.readRate.capacity * 5, perSec: BASE.readRate.perSec * 5 },
    writeRate: { capacity: BASE.writeRate.capacity * 5, perSec: BASE.writeRate.perSec * 5 },
  };
}

export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly perSec: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  /** Takes one token. Returns false when the bucket is empty. */
  take(): boolean {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.perSec);
    this.last = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
