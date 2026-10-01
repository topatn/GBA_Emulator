/**
 * GBA cheat code parsing.
 *
 * Homebrew GBA titles (Pokémon Unbound and friends) circulate their cheat codes
 * in the two retail cheat-device formats, and code lists are published in
 * whichever form the list author had to hand. All three shapes have to be
 * understood, because a code list is useless if the wrong one is chosen:
 *
 *   raw          "32001234 0064"        already decrypted
 *   GameShark    encrypted, TEA with the stock GSA seeds
 *   CodeBreaker  encrypted, seeded by a leading "9..." master line
 *
 * The ciphers and type tables are ported from mGBA's own GBA cheat engine
 * (src/gba/cheats/gameshark.c, codebreaker.c), which is the reference
 * implementation.
 */

// ── GBA address space, as the cheat engine needs to see it ────────────────
// EWRAM is 256 KB mirrored across 0x02000000-0x02FFFFFF, IWRAM is 32 KB
// mirrored across 0x03000000-0x03FFFFFF. Masking with the region size turns
// any address a code list happens to use back into a real offset.
export const EWRAM_BASE = 0x02000000;
export const EWRAM_SIZE = 0x40000;
export const IWRAM_BASE = 0x03000000;
export const IWRAM_SIZE = 0x8000;
const EWRAM_MIRROR_END = 0x03000000;   // 0x02000000..0x02FFFFFF
const IWRAM_MIRROR_END = 0x04000000;   // 0x03000000..0x03FFFFFF
export const EWRAM_MASK = EWRAM_SIZE - 1;
export const IWRAM_MASK = IWRAM_SIZE - 1;

/**
 * Classifies a GBA address for cheat purposes.
 * @param {number} address
 * @returns {'ewram'|'iwram'|null} null when the region is not RAM we can patch
 */
export function cheatRegionFor(address) {
  if (address >= EWRAM_BASE && address < EWRAM_MIRROR_END) return 'ewram';
  if (address >= IWRAM_BASE && address < IWRAM_MIRROR_END) return 'iwram';
  return null;
}

// ── GameShark Advance cipher (TEA, 32 rounds) ──────────────────────────────
const GS_SEEDS = [0x09F4FBBD, 0x9681884A, 0x352027E9, 0xF3DEE5A7];

function gsDecrypt(op1, op2, seeds = GS_SEEDS) {
  let a = op1 >>> 0, b = op2 >>> 0, sum = 0xC6EF3720;
  for (let i = 0; i < 32; i++) {
    const t1 = ((((a << 4) >>> 0) + seeds[2]) >>> 0 ^ (a + sum) >>> 0 ^ (((a >>> 5) + seeds[3]) >>> 0)) >>> 0;
    b = (b - t1) >>> 0;
    const t2 = ((((b << 4) >>> 0) + seeds[0]) >>> 0 ^ (b + sum) >>> 0 ^ (((b >>> 5) + seeds[1]) >>> 0)) >>> 0;
    a = (a - t2) >>> 0;
    sum = (sum - 0x9E3779B9) >>> 0;
  }
  return [a >>> 0, b >>> 0];
}

// ── CodeBreaker cipher ─────────────────────────────────────────────────────
const CB_TABLE_SIZE = 0x30;
const ror = (v, n) => (n === 0 ? v >>> 0 : ((v >>> n) | (v << (32 - n))) >>> 0);

function cbRand(state) {
  const roll = (Math.imul(state, 0x41C64E6D) + 0x3039) >>> 0;
  const roll2 = (Math.imul(roll, 0x41C64E6D) + 0x3039) >>> 0;
  const roll3 = (Math.imul(roll2, 0x41C64E6D) + 0x3039) >>> 0;
  let mix = (roll << 14) & 0xC0000000;
  mix |= (roll2 >>> 1) & 0x3FFF8000;
  mix |= (roll3 >>> 16) & 0x7FFF;
  return { state: roll3, value: mix >>> 0 };
}

function cbSwapIndex(ctx) {
  let roll = cbRand(ctx.rngState).value;
  let count = CB_TABLE_SIZE;
  if (roll === count) roll = 0;
  if (roll < count) return roll;

  let bit = 1;
  while (count < 0x10000000 && count < roll) { count = (count << 4) >>> 0; bit = (bit << 4) >>> 0; }
  while (count < 0x80000000 && count < roll) { count = (count << 1) >>> 0; bit = (bit << 1) >>> 0; }

  let mask;
  for (;;) {
    mask = 0;
    if (roll >= count) roll -= count;
    if (roll >= (count >>> 1)) { roll -= (count >>> 1); mask |= ror(bit, 1); }
    if (roll >= (count >>> 2)) { roll -= (count >>> 2); mask |= ror(bit, 2); }
    if (roll >= (count >>> 3)) { roll -= (count >>> 3); mask |= ror(bit, 3); }
    if (!roll || !(bit >>> 4)) break;
    bit >>>= 4;
    count >>>= 4;
  }

  mask &= 0xE0000000;
  if (!mask || !(bit & 7)) return roll;
  if (mask & ror(bit, 3)) roll += count >>> 3;
  if (mask & ror(bit, 2)) roll += count >>> 2;
  if (mask & ror(bit, 1)) roll += count >>> 1;
  return roll;
}

function cbReseed(op1, op2) {
  const ctx = {
    rngState: ((op2 & 0xFF) ^ 0x1111) >>> 0,
    table: new Uint8Array(CB_TABLE_SIZE),
    seeds: new Uint32Array(4),
    master: op1 >>> 0,
  };
  for (let i = 0; i < CB_TABLE_SIZE; i++) ctx.table[i] = i;
  for (let i = 0; i < 0x50; i++) {
    const x = cbSwapIndex(ctx);
    const y = cbSwapIndex(ctx);
    const swap = ctx.table[x];
    ctx.table[x] = ctx.table[y];
    ctx.table[y] = swap;
  }

  // _cbRand both advances the RNG and yields a value; seeds take the value,
  // the discard loops only advance it.
  const spin = (n) => { for (let i = 0; i < n; i++) ctx.rngState = cbRand(ctx.rngState).state; };
  const draw = () => { const r = cbRand(ctx.rngState); ctx.rngState = r.state; return r.value; };

  ctx.rngState = 0x4EFAD1C3;
  spin((op1 >>> 24) & 0xF);
  ctx.seeds[2] = draw();
  ctx.seeds[3] = draw();

  ctx.rngState = ((op2 >>> 8) ^ 0xF254) >>> 0;
  spin(op2 >>> 8);
  ctx.seeds[0] = draw();
  ctx.seeds[1] = draw();
  return ctx;
}

function cbDecrypt(ctx, op1, op2) {
  const buf = new Uint8Array(6);
  const load = (a, b) => {
    buf[0] = a >>> 24; buf[1] = (a >>> 16) & 0xFF; buf[2] = (a >>> 8) & 0xFF; buf[3] = a & 0xFF;
    buf[4] = (b >>> 8) & 0xFF; buf[5] = b & 0xFF;
  };
  const store = () => [
    ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) >>> 0,
    ((buf[4] << 8) | buf[5]) & 0xFFFF,
  ];

  load(op1, op2);
  for (let i = CB_TABLE_SIZE - 1; i >= 0; i--) {
    const offsetX = i >> 3;
    const offsetY = ctx.table[i] >> 3;
    const bitX = i & 7;
    const bitY = ctx.table[i] & 7;
    const x = (buf[offsetX] >> bitX) & 1;
    const y = (buf[offsetY] >> bitY) & 1;
    buf[offsetX] = (y ? buf[offsetX] | (1 << bitX) : buf[offsetX] & ~(1 << bitX)) & 0xFF;
    buf[offsetY] = (x ? buf[offsetY] | (1 << bitY) : buf[offsetY] & ~(1 << bitY)) & 0xFF;
  }
  let [o1, o2] = store();

  o1 = (o1 ^ ctx.seeds[0]) >>> 0;
  o2 = (o2 ^ ctx.seeds[1]) & 0xFFFF;
  load(o1, o2);

  const master = ctx.master;
  for (let i = 0; i < 5; i++) buf[i] = (buf[i] ^ ((master >>> 8) ^ buf[i + 1])) & 0xFF;
  buf[5] = (buf[5] ^ (master >>> 8)) & 0xFF;
  for (let i = 5; i > 0; i--) buf[i] = (buf[i] ^ ((master ^ buf[i - 1]) & 0xFF)) & 0xFF;
  buf[0] = (buf[0] ^ (master & 0xFF)) & 0xFF;

  [o1, o2] = store();
  o1 = (o1 ^ ctx.seeds[2]) >>> 0;
  o2 = (o2 ^ ctx.seeds[3]) & 0xFFFF;
  return [o1, o2];
}

// ── Code type tables (mGBA's enums) ────────────────────────────────────────
const GSA_ASSIGN_1 = 0x0, GSA_ASSIGN_2 = 0x1, GSA_ASSIGN_4 = 0x2, GSA_ASSIGN_LIST = 0x3;
const GSA_PATCH = 0x6, GSA_BUTTON = 0x8, GSA_IF = 0xD, GSA_IF_RANGE = 0xE, GSA_HOOK = 0xF;
const GSA_IF_EQ = 0, GSA_IF_NE = 1, GSA_IF_LE = 2, GSA_IF_GE = 3;

const CB_GAME_ID = 0x0, CB_HOOK = 0x1, CB_OR_2 = 0x2, CB_ASSIGN_1 = 0x3, CB_FILL = 0x4;
const CB_FILL_LIST = 0x5, CB_AND_2 = 0x6, CB_IF_EQ = 0x7, CB_ASSIGN_2 = 0x8, CB_ENCRYPT = 0x9;
const CB_IF_NE = 0xA, CB_IF_GT = 0xB, CB_IF_LT = 0xC, CB_IF_SPECIAL = 0xD, CB_ADD_2 = 0xE;
const CB_IF_AND = 0xF;

const GSA_IF_COMPARE = {
  [GSA_IF_EQ]: 'eq', [GSA_IF_NE]: 'ne', [GSA_IF_LE]: 'le', [GSA_IF_GE]: 'ge',
};

/** Human-readable reasons for the code types we recognise but cannot run. */
const UNSUPPORTED_GSA = {
  [GSA_ASSIGN_LIST]: 'multi-address write (type 3)',
  [GSA_PATCH]: 'ROM patch (type 6)',
  [GSA_BUTTON]: 'cheat-button write (type 8)',
  [GSA_HOOK]: 'code handler hook (type F)',
};
const UNSUPPORTED_CB = {
  [CB_GAME_ID]: 'game ID (type 0)',
  [CB_HOOK]: 'code handler hook (type 1)',
  [CB_FILL]: 'slide/fill code (type 4)',
  [CB_FILL_LIST]: 'fill list (type 5)',
  [CB_IF_SPECIAL]: 'button check (type D)',
};

// ── Line splitting ─────────────────────────────────────────────────────────
function readCodeLines(codeText) {
  const lines = [];
  if (typeof codeText !== 'string') return lines;
  for (const raw of codeText.split(/[\r\n]+/)) {
    const clean = raw.replace(/[;#].*$/, '').replace(/\/\/.*$/, '').trim();
    if (!clean) continue;
    const parts = clean.split(/[\s,]+/).filter(Boolean);
    if (parts.length < 2) continue;
    const addrHex = parts[0].replace(/^0x/i, '');
    const valHex = parts[1].replace(/^0x/i, '');
    if (!/^[0-9a-f]{1,8}$/i.test(addrHex)) continue;
    if (!/^[0-9a-f]{1,8}$/i.test(valHex)) continue;
    lines.push({
      addrHex,
      valHex,
      op1: parseInt(addrHex, 16) >>> 0,
      op2: parseInt(valHex, 16) >>> 0,
      bits: parts[2] ? parseInt(parts[2], 10) : NaN,
      text: clean,
    });
  }
  return lines;
}

/** Digits left once leading zeros are dropped, minimum 1. */
function significantDigits(hex) {
  return Math.max(1, hex.replace(/^0+/, '').length);
}

/** Write width for a RAW line, where the leading digit is a device code type. */
function rawSize(type, valHex) {
  if (type === CB_ASSIGN_1) return 1;
  if (type === CB_ASSIGN_2) return 2;
  if (valHex.length === 8) {
    const sig = significantDigits(valHex);
    if (type === GSA_ASSIGN_1 && sig <= 2) return 1;
    if (type === GSA_ASSIGN_2 && sig <= 4) return 2;
    if (type === GSA_ASSIGN_4) return 4;
  }
  return valHex.length <= 2 ? 1 : valHex.length <= 4 ? 2 : 4;
}

/** Bit mask covering `size` bytes. `1 << 32` wraps in JS, so size 4 is special. */
function maskFor(size) {
  return size === 4 ? 0xFFFFFFFF : (1 << (size * 8)) - 1;
}

/** Address for a line whose first token is a 7-or-8 digit device code. */
function deviceAddress(op1) {
  return op1 & 0x0FFFFFFF;
}

// ── Decoders: each turns one line into an op, or null if not believable ────

/** Believable = a known code type writing to real GBA RAM. */
function isRamAddress(address) {
  return address >= EWRAM_BASE && address < IWRAM_MIRROR_END;
}

/**
 * Decodes a line that is already in plaintext.
 *
 * The leading digit of an 8-digit address is a cheat-device code type, and
 * GameShark and CodeBreaker assign *different* meanings to the same digits --
 * 0 is an 8-bit write to GameShark but a game ID to CodeBreaker, 6 is a ROM
 * patch to one and a bitwise AND to the other. GameShark pads its value to 8
 * digits and CodeBreaker keeps 4, which separates most types; the few that
 * collide (D, E, F, 8) carry their own structure and are matched directly.
 * A value that fits none of that is treated as a hand-written address/value
 * pair, where the value's own width picks the write size.
 */
function decodeRaw(line) {
  const op1 = line.op1;
  const type = line.addrHex.length === 8 ? op1 >>> 28 : null;
  const address = line.addrHex.length >= 7
    ? deviceAddress(op1)
    : (op1 < IWRAM_SIZE ? IWRAM_BASE + op1 : EWRAM_BASE + op1);
  const value = line.op2 >>> 0;
  const longValue = line.valHex.length === 8;

  const explicitBits = line.bits === 8 || line.bits === 16 || line.bits === 32;
  if (explicitBits) {
    if (!isRamAddress(address)) return { op: 'skip', reason: 'address outside GBA RAM' };
    const size = line.bits / 8;
    return { op: 'write', address, value: (value & maskFor(size)) >>> 0, size };
  }

  const plain = () => {
    if (!isRamAddress(address)) return { op: 'skip', reason: 'address outside GBA RAM' };
    const size = rawSize(type, line.valHex);
    return { op: 'write', address, value: (value & maskFor(size)) >>> 0, size };
  };
  const gated = (op) => (isRamAddress(address) ? op : { op: 'skip', reason: 'address outside GBA RAM' });
  const sig = significantDigits(line.valHex);

  if (type === null) return plain();

  // Types where both devices define something, decided by the code's own shape.
  switch (type) {
    case GSA_IF:
      // CodeBreaker only defines a button check at D0000020; anywhere else this
      // is GameShark's "if the halfword equals, run the next code".
      if (address === 0x00000020) return { op: 'skip', reason: 'button check' };
      return gated({ op: 'if', address, value: value & 0xFFFF, size: 2, compare: 'eq', count: 1 });
    case GSA_IF_RANGE:
      // GameShark's multi-line form always has 0 in the second digit and keeps
      // the address in the value field; CodeBreaker's type E is a 16-bit add.
      if ((op1 >>> 24) & 0xF === 0) {
        return gated({
          op: 'if', address: value & 0x0FFFFFFF, value: op1 & 0xFFFF, size: 2,
          compare: 'eq', count: (op1 >>> 16) & 0xFF,
        });
      }
      return gated({ op: 'add', address, value: value & 0xFFFF, size: 2 });
    case GSA_HOOK:
      return { op: 'unsupported', reason: UNSUPPORTED_GSA[GSA_HOOK] };
    case GSA_BUTTON:
      // GameShark's button writes carry a 1 or 2 in the second digit; without
      // one this is CodeBreaker's ordinary 16-bit write.
      if ((op1 & 0x00F00000) === 0x00100000 || (op1 & 0x00F00000) === 0x00200000) {
        return { op: 'unsupported', reason: UNSUPPORTED_GSA[GSA_BUTTON] };
      }
      return gated({ op: 'write', address, value: value & 0xFFFF, size: 2 });
    default:
      break;
  }

  // --- GameShark family: value padded to 8 digits -------------------------
  if (longValue) {
    switch (type) {
      case GSA_ASSIGN_1:
        return sig <= 2 ? gated({ op: 'write', address, value: value & 0xFF, size: 1 }) : plain();
      case GSA_ASSIGN_2:
        return sig <= 4 ? gated({ op: 'write', address, value: value & 0xFFFF, size: 2 }) : plain();
      case GSA_ASSIGN_4:
        return gated({ op: 'write', address, value, size: 4 });
      case GSA_ASSIGN_LIST:
      case GSA_PATCH:
        return { op: 'unsupported', reason: UNSUPPORTED_GSA[type] };
      default:
        break;
    }
    if (op1 === 0xDEADFACE) return { op: 'skip', reason: 'encryption seed' };
    if (line.op2 === 0x001DC0DE) return { op: 'skip', reason: 'ID code' };
    return plain();
  }

  // --- CodeBreaker family: 4-digit value ----------------------------------
  switch (type) {
    case CB_ASSIGN_1: return gated({ op: 'write', address, value: value & 0xFF, size: 1 });
    case CB_AND_2: return gated({ op: 'and', address, value: value & 0xFFFF, size: 2 });
    case CB_OR_2: return gated({ op: 'or', address, value: value & 0xFFFF, size: 2 });
    case CB_IF_EQ:
    case CB_IF_NE:
    case CB_IF_GT:
    case CB_IF_LT: {
      const compare = { 0x7: 'eq', 0xA: 'ne', 0xB: 'gt', 0xC: 'lt' }[type];
      return gated({ op: 'if', address, value: value & 0xFFFF, size: 2, compare, count: 1 });
    }
    case CB_FILL:
    case CB_FILL_LIST:
      return { op: 'unsupported', reason: UNSUPPORTED_CB[type] };
    case CB_ENCRYPT:
      return { op: 'skip', reason: 'encryption seed' };
    case CB_GAME_ID:
    case CB_HOOK:
    case CB_ASSIGN_2:
      // Digits 0, 1 and 8 are GameShark write types in an 8-digit value field,
      // so a short value here is a hand-written pair rather than metadata.
      return isRamAddress(address) ? plain() : { op: 'skip', reason: 'master/enable code' };
    default:
      break;
  }
  return plain();
}

function decodeGameShark(line) {
  const [op1, op2] = gsDecrypt(line.op1, line.op2);
  const type = op1 >>> 28;
  const address = op1 & 0x0FFFFFFF;
  if (type === GSA_ASSIGN_1) return { op: 'write', address, value: op2 & 0xFF, size: 1 };
  if (type === GSA_ASSIGN_2) return { op: 'write', address, value: op2 & 0xFFFF, size: 2 };
  if (type === GSA_ASSIGN_4) return { op: 'write', address, value: op2 >>> 0, size: 4 };
  if (type === GSA_IF) {
    const compare = GSA_IF_COMPARE[op2 >>> 20];
    if (compare) return { op: 'if', address, value: op2 & 0xFFFF, size: 2, compare, count: 1 };
  }
  if (type === GSA_IF_RANGE) {
    return {
      op: 'if', address: op2 & 0x0FFFFFFF, value: op1 & 0xFFFF, size: 2,
      compare: 'eq', count: (op1 >>> 16) & 0xFF,
    };
  }
  if (UNSUPPORTED_GSA[type]) return { op: 'unsupported', reason: UNSUPPORTED_GSA[type] };
  if (op1 === 0xDEADFACE) return { op: 'skip', reason: 'encryption seed' };
  if (op2 === 0x001DC0DE) return { op: 'skip', reason: 'ID code' };
  return null;
}

function decodeCodeBreaker(line, ctx) {
  let op1 = line.op1;
  let op2 = line.op2 & 0xFFFF;
  if (ctx) [op1, op2] = cbDecrypt(ctx, op1, op2);

  const type = op1 >>> 28;
  const address = op1 & 0x0FFFFFFF;
  if (type === CB_ASSIGN_1) return { op: 'write', address, value: op2 & 0xFF, size: 1 };
  if (type === CB_ASSIGN_2) return { op: 'write', address, value: op2 & 0xFFFF, size: 2 };
  if (type === CB_AND_2) return { op: 'and', address, value: op2 & 0xFFFF, size: 2 };
  if (type === CB_OR_2) return { op: 'or', address, value: op2 & 0xFFFF, size: 2 };
  if (type === CB_ADD_2) return { op: 'add', address, value: op2 & 0xFFFF, size: 2 };
  if (type === CB_IF_EQ || type === CB_IF_NE || type === CB_IF_GT || type === CB_IF_LT) {
    const compare = { 0x7: 'eq', 0xA: 'ne', 0xB: 'gt', 0xC: 'lt' }[type];
    return { op: 'if', address, value: op2 & 0xFFFF, size: 2, compare, count: 1 };
  }
  if (UNSUPPORTED_CB[type]) return { op: 'unsupported', reason: UNSUPPORTED_CB[type] };
  return null;
}

/** Does this op actually change memory the emulator can reach? */
function isActionable(op) {
  if (!op) return false;
  if (op.op === 'write' || op.op === 'and' || op.op === 'or' || op.op === 'add') {
    return isRamAddress(op.address);
  }
  if (op.op === 'if') return isRamAddress(op.address);
  return false;
}

// ── Public entry point ─────────────────────────────────────────────────────

/**
 * Parses a cheat code list, auto-detecting whether it is raw, GameShark
 * encrypted or CodeBreaker encrypted.
 *
 * Detection is per-list, not per-line: a list is one format throughout, and a
 * single line is far too short to tell a ciphertext from a plaintext (a wrong
 * guess reads as plausible roughly 4% of the time). Every candidate format is
 * run over the whole list and the one that explains the most lines wins; raw is
 * preferred on a tie because it is the common case.
 *
 * @param {string} codeText
 * @returns {{ops: Array<object>, format: string, notes: string[], lineCount: number}}
 */
export function parseCheatCodeList(codeText) {
  const lines = readCodeLines(codeText);
  const empty = { ops: [], format: 'none', notes: [], lineCount: lines.length };
  if (!lines.length) return empty;

  // A CodeBreaker list is encrypted only if it carries a seed ("9...") line,
  // and the seed must be applied to the lines that follow it.
  const cbContextFor = () => {
    let ctx = null;
    const ops = [];
    for (const line of lines) {
      if (ctx === null && (line.op1 >>> 28) === CB_ENCRYPT) {
        ctx = cbReseed(line.op1, line.op2 & 0xFFFF);
        ops.push({ op: 'skip', reason: 'encryption seed' });
        continue;
      }
      ops.push(ctx ? decodeCodeBreaker(line, ctx) : { op: 'skip', reason: 'no encryption seed' });
    }
    return ops;
  };

  const score = (ops) => ops.reduce((n, op) => n + (isActionable(op) ? 1 : 0), 0);

  const candidates = [
    { format: 'raw', ops: lines.map(decodeRaw) },
    { format: 'gameshark', ops: lines.map(decodeGameShark) },
    { format: 'codebreaker', ops: cbContextFor() },
  ];
  for (const c of candidates) c.score = score(c.ops);

  const best = candidates.reduce((a, b) => (b.score > a.score ? b : a));
  const raw = candidates[0];
  // A tie means the evidence is weak; stay with raw rather than guess a cipher.
  const chosen = best.score > raw.score ? best : raw;

  const notes = [];
  if (chosen.format !== 'raw') notes.push(`Decrypted as ${chosen.format} codes.`);
  const unsupported = new Set();
  for (const op of chosen.ops) if (op && op.op === 'unsupported') unsupported.add(op.reason);
  if (unsupported.size) notes.push(`Ignored unsupported code types: ${[...unsupported].join(', ')}.`);
  if (chosen.score === 0) {
    notes.push('No code in this list targets EWRAM or IWRAM, so nothing will be applied.');
  }

  return {
    ops: chosen.ops.filter(Boolean),
    format: chosen.format,
    notes,
    lineCount: lines.length,
  };
}

/**
 * Convenience wrapper returning just the operations.
 * @param {string} codeText
 * @returns {Array<object>}
 */
export function parseCheatCodes(codeText) {
  return parseCheatCodeList(codeText).ops;
}

/**
 * Short human-readable summary of a parsed op, for the cheat list UI.
 * @param {object} op
 * @returns {string}
 */
export function describeCheatOp(op) {
  const addr = (op.address >>> 0).toString(16).toUpperCase().padStart(8, '0');
  switch (op.op) {
    case 'write': return `${op.size * 8}-bit write ${addr} = ${op.value.toString(16).toUpperCase()}`;
    case 'if': return `if ${addr} ${op.compare} ${op.value.toString(16).toUpperCase()}`;
    case 'and': return `${addr} &= ${op.value.toString(16).toUpperCase()}`;
    case 'or': return `${addr} |= ${op.value.toString(16).toUpperCase()}`;
    case 'add': return `${addr} += ${op.value.toString(16).toUpperCase()}`;
    case 'skip': return op.reason || 'skipped';
    case 'unsupported': return `unsupported: ${op.reason}`;
    default: return 'unknown';
  }
}
