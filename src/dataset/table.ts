/**
 * Every token with a pool, by address, in typed arrays: about 30 bytes a token where a Map of strings takes ten times that,
 * so the chain's million-odd tokens fit the guard's memory. An address is kept as its first 13 hex digits, a whole number
 * a double holds exactly, and checked against its last 8, so two tokens are taken for one only when both agree.
 */
export class TokenTable {
  private keys: Float64Array;
  private checks: Uint32Array;
  private blocks: Uint32Array;
  /** Bit 1: a v3 pool, bit 2: a v4 pool, bit 4: its symbol is written. */
  private flags: Uint8Array;
  private mask: number;
  size = 0;

  constructor(capacity = 1 << 16) {
    const slots = 2 ** Math.ceil(Math.log2(Math.max(16, capacity)));
    this.keys = new Float64Array(slots);
    this.checks = new Uint32Array(slots);
    this.blocks = new Uint32Array(slots);
    this.flags = new Uint8Array(slots);
    this.mask = slots - 1;
  }

  private static parts(address: string): [number, number] {
    // The key is never 0, which marks an empty slot.
    return [parseInt(address.slice(2, 15), 16) + 1, parseInt(address.slice(34, 42), 16) >>> 0];
  }

  private find(key: number, check: number): number {
    let slot = (key % (this.mask + 1)) & this.mask;
    while (this.keys[slot] !== 0 && (this.keys[slot] !== key || this.checks[slot] !== check)) slot = (slot + 1) & this.mask;
    return slot;
  }

  private grow(): void {
    const { keys, checks, blocks, flags } = this;
    const slots = keys.length * 2;
    [this.keys, this.checks, this.blocks, this.flags, this.mask] = [new Float64Array(slots), new Uint32Array(slots), new Uint32Array(slots), new Uint8Array(slots), slots - 1];
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] === 0) continue;
      const slot = this.find(keys[i]!, checks[i]!);
      [this.keys[slot], this.checks[slot], this.blocks[slot], this.flags[slot]] = [keys[i]!, checks[i]!, blocks[i]!, flags[i]!];
    }
  }

  /** The token's flags, or undefined for one not in the table. */
  get(address: string): number | undefined {
    const [key, check] = TokenTable.parts(address.toLowerCase());
    const slot = this.find(key, check);
    return this.keys[slot] === 0 ? undefined : this.flags[slot];
  }

  /** Notes a pool on `venue` (1 for v3, 2 for v4) at `block`; true when the token had no pool on that venue before. */
  addPool(address: string, venue: 1 | 2, block: number): boolean {
    if (this.size * 10 >= (this.mask + 1) * 6) this.grow();
    const [key, check] = TokenTable.parts(address.toLowerCase());
    const slot = this.find(key, check);
    if (this.keys[slot] === 0) {
      [this.keys[slot], this.checks[slot], this.blocks[slot], this.flags[slot]] = [key, check, block, venue];
      this.size++;
      return true;
    }
    if (block < this.blocks[slot]!) this.blocks[slot] = block;
    if (this.flags[slot]! & venue) return false;
    this.flags[slot]! |= venue;
    return true;
  }

  /** Marks the token's symbol as written; false when it was already, or the token is not in the table. */
  markNamed(address: string): boolean {
    const [key, check] = TokenTable.parts(address.toLowerCase());
    const slot = this.find(key, check);
    if (this.keys[slot] === 0 || this.flags[slot]! & 4) return false;
    this.flags[slot]! |= 4;
    return true;
  }

  /** How many tokens had their first pool in each stretch of `piece` blocks, up to and including the one holding `last`. */
  firstPools(piece: number, last: number): number[] {
    const counts = new Array<number>(Math.floor(last / piece) + 1).fill(0);
    for (let i = 0; i < this.keys.length; i++) if (this.keys[i] !== 0 && this.blocks[i]! <= last) counts[Math.floor(this.blocks[i]! / piece)]! += 1;
    return counts;
  }
}
