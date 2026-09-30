/**
 * GBA Emulator Core Wrapper
 * Wraps mGBA WebAssembly core providing a clean, typed JS API.
 */

import { load } from './mgba.sdk.js';

export const GBA_KEY = {
  A: 0,
  B: 1,
  SELECT: 2,
  START: 3,
  RIGHT: 4,
  LEFT: 5,
  UP: 6,
  DOWN: 7,
  R: 8,
  L: 9,
};

export const GBA_KEY_NAMES = {
  [GBA_KEY.A]: 'A',
  [GBA_KEY.B]: 'B',
  [GBA_KEY.SELECT]: 'Select',
  [GBA_KEY.START]: 'Start',
  [GBA_KEY.RIGHT]: 'Right',
  [GBA_KEY.LEFT]: 'Left',
  [GBA_KEY.UP]: 'Up',
  [GBA_KEY.DOWN]: 'Down',
  [GBA_KEY.R]: 'R',
  [GBA_KEY.L]: 'L',
};

/**
 * Validates GBA ROM buffer & extracts header metadata
 * @param {Uint8Array} bytes
 * @returns {{ valid: boolean, title: string, gameCode: string, makerCode: string, size: number, error: string | null }}
 */
export function validateGbaRom(bytes) {
  if (!bytes || !(bytes instanceof Uint8Array)) {
    return { valid: false, title: '', gameCode: '', makerCode: '', size: 0, error: 'Invalid file data provided.' };
  }

  const size = bytes.byteLength;
  if (size < 192) {
    return { valid: false, title: '', gameCode: '', makerCode: '', size, error: 'File is too small to be a valid GBA ROM (minimum 192 bytes).' };
  }
  if (size > 64 * 1024 * 1024) {
    return { valid: false, title: '', gameCode: '', makerCode: '', size, error: 'File size exceeds maximum supported GBA ROM capacity (64 MB).' };
  }

  // Header parsing:
  // Title at 0xA0..0xAB (12 bytes ASCII)
  let title = '';
  for (let i = 0xA0; i <= 0xAB; i++) {
    const c = bytes[i];
    if (c === 0) break;
    if (c >= 32 && c <= 126) title += String.fromCharCode(c);
  }
  title = title.trim();

  // Game Code at 0xAC..0xAF (4 bytes ASCII)
  let gameCode = '';
  for (let i = 0xAC; i <= 0xAF; i++) {
    const c = bytes[i];
    if (c >= 32 && c <= 126) gameCode += String.fromCharCode(c);
  }
  gameCode = gameCode.trim();

  // Maker code at 0xB0..0xB1
  let makerCode = '';
  for (let i = 0xB0; i <= 0xB1; i++) {
    const c = bytes[i];
    if (c >= 32 && c <= 126) makerCode += String.fromCharCode(c);
  }

  // Fixed value at 0xB2 must be 0x96 on authentic GBA carts
  const fixedByte = bytes[0xB2];

  // Complement checksum check
  let sum = 0;
  for (let i = 0xA0; i <= 0xBC; i++) {
    sum = (sum + bytes[i]) & 0xFF;
  }
  const checksum = (0x100 - (sum + 0x19)) & 0xFF;
  const expectedChecksum = bytes[0xBD];
  const checksumMatches = checksum === expectedChecksum;

  // Most commercial GBA ROMs match both fixed byte 0x96 and checksum
  const isGba = fixedByte === 0x96 || checksumMatches || title.length > 0;

  if (!isGba) {
    return {
      valid: false,
      title: title || 'Unknown',
      gameCode: gameCode || '----',
      makerCode,
      size,
      error: 'File does not contain a standard GBA cartridge header (missing Nintendo 0x96 flag or invalid checksum).'
    };
  }

  return {
    valid: true,
    title: title || 'Untitled GBA Game',
    gameCode: gameCode || '----',
    makerCode,
    size,
    checksumMatches,
    error: null,
  };
}

/**
 * GbaEmulatorCore manages the mGBA WASM instance, frame running,
 * canvas rendering, input handling, and save/load operations.
 */
// ── GBA address space, as the cheat engine needs to see it ────────────────
// EWRAM is 256 KB mirrored across 0x02000000-0x02FFFFFF, IWRAM is 32 KB
// mirrored across 0x03000000-0x03FFFFFF. Masking with the region size turns
// any address a code list happens to use back into a real offset.
const EWRAM_BASE = 0x02000000;
const EWRAM_SIZE = 0x40000;
const IWRAM_BASE = 0x03000000;
const IWRAM_SIZE = 0x8000;
const EWRAM_MIRROR_END = 0x03000000;   // 0x02000000..0x02FFFFFF
const IWRAM_MIRROR_END = 0x04000000;   // 0x03000000..0x03FFFFFF
const EWRAM_MASK = EWRAM_SIZE - 1;
const IWRAM_MASK = IWRAM_SIZE - 1;

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

/**
 * Parses a GameShark / Action Replay cheat code list into { address, value, size }
 * patch operations against the GBA address space.
 *
 * Accepted per line (blank lines and `;` / `//` comments are ignored):
 *
 *   ADDRESS VALUE [BITS]
 *     ADDRESS  6-8 hex digits, optionally 0x-prefixed. A GBA address such as
 *              02001234, or a bare offset such as 0001234 / 1234.
 *     VALUE    2, 4 or 8 hex digits. The width picks the write size:
 *              2 digits -> 8-bit, 4 -> 16-bit, 8 -> 32-bit.
 *     BITS     optional explicit 8 / 16 / 32 override.
 *
 * Multiple lines become multiple patches, applied in order. Multi-line
 * master-code/handler scripts are parsed as independent writes, which covers
 * the "freeze this address" codes that make up most GBA code lists.
 *
 * @param {string} codeText
 * @returns {Array<{address: number, value: number, size: 1|2|4}>}
 */
export function parseCheatCodes(codeText) {
  const patches = [];
  if (typeof codeText !== 'string') return patches;

  for (const rawLine of codeText.split(/[\r\n]+/)) {
    const clean = rawLine.replace(/[;#].*$/, '').replace(/\/\/.*$/, '').trim();
    if (!clean) continue;

    const parts = clean.split(/[\s,]+/).filter(Boolean);
    if (parts.length < 2) continue;

    const addrHex = parts[0].replace(/^0x/i, '');
    const valHex  = parts[1].replace(/^0x/i, '');
    if (!/^[0-9a-f]{1,8}$/i.test(addrHex)) continue;
    if (!/^[0-9a-f]{1,8}$/i.test(valHex))  continue;

    // 7 or 8 digits is a GBA address (0x02000000 and up need more than 24 bits,
    // so this masks off sign extension only). 6 or fewer is a bare EWRAM/IWRAM
    // offset, which code lists use interchangeably with the full address.
    let address;
    if (addrHex.length >= 7) {
      address = parseInt(addrHex, 16) & 0x0fffffff;
    } else {
      const offset = parseInt(addrHex, 16);
      address = offset < IWRAM_SIZE ? IWRAM_BASE + offset : EWRAM_BASE + offset;
    }

    const value = parseInt(valHex, 16);
    const hint = parts[2] ? parseInt(parts[2], 10) : NaN;
    let size;
    if (hint === 8 || hint === 16 || hint === 32) {
      size = hint / 8;
    } else {
      size = valHex.length <= 2 ? 1 : valHex.length <= 4 ? 2 : 4;
    }

    patches.push({
      address,
      value: value >>> 0,
      size,
    });
  }
  return patches;
}

export class GbaEmulatorCore {
  constructor(canvas, options = {}) {
    if (!canvas) throw new Error('A canvas element is required to initialize GbaEmulatorCore.');
    this.canvas = canvas;
    this.options = {
      volume: 1.0,
      renderFilter: 'pixelated',
      allowOpposingDirections: false,
      idleOptimization: 'remove',
      skipBios: true,
      ...options,
    };

    this.engine = null;
    this.currentRomBytes = null;
    this.currentRomName = '';
    this.currentRomInfo = null;
    this.isRunning = false;
    this.isPaused = false;
    this.isMuted = false;
    this.currentFps = 0;

    // Speed control
    this._speedMultiplier = 1.0;
    this._speedIntervalId = null;

    // Cheat engine
    this._cheats = [];           // Array<{label, code, enabled, patches}>
    this._memMap = null;         // {ewram, iwram} heap offsets, or null until located
    this._cheatError = null;     // last discovery/apply failure, for the UI
    this._cheatRestores = [];    // saved bytes to put back when a cheat is switched off

    // Callbacks
    this.onFpsUpdate = null;
    this.onInputEvent = null;
    this.onRomLoaded = null;
    this.onError = null;
    this.onCheatChange = null;   // (error: string|null) fired when the cheat engine's state changes
  }

  /**
   * Initializes or reloads a ROM into the mGBA engine
   * @param {Uint8Array} romBytes
   * @param {string} romFileName
   * @returns {Promise<{ title: string, gameCode: string }>}
   */
  async loadRom(romBytes, romFileName = 'game.gba') {
    // Basic header/size sanity check
    const validation = validateGbaRom(romBytes);
    if (!validation.valid) {
      const err = new Error(validation.error || 'Failed GBA ROM sanity check.');
      if (this.onError) this.onError(err);
      throw err;
    }

    // Clean up previous instance if running
    if (this.engine) {
      try {
        this.engine.destroy();
      } catch (e) {
        console.warn('Error while destroying previous engine instance:', e);
      }
      this.engine = null;
    }

    this.currentRomBytes = romBytes;
    this.currentRomName = romFileName;
    this.currentRomInfo = validation;

    const baseName = romFileName.replace(/\.[^/.]+$/, '');

    // Set pixelated canvas scaling
    this.canvas.style.imageRendering = 'pixelated';

    // Load mGBA instance
    this.engine = await load({
      canvasEl: this.canvas,
      assets: {
        rom: romBytes,
      },
      options: {
        system: 'gba',
        renderFilter: this.options.renderFilter,
        volume: this.isMuted ? 0 : this.options.volume,
        idleOptimization: this.options.idleOptimization,
        skipBios: this.options.skipBios,
        allowOpposingDirections: this.options.allowOpposingDirections,
        escMenu: false,
      },
      storageNamespace: baseName,
      persist: null, // Strictly disable OPFS / browser storage; saves handled via local folder
      onEvent: (event) => {
        if (event.type === 'frame') {
          this.currentFps = event.fps;
          if (this.onFpsUpdate) {
            this.onFpsUpdate(event.fps);
          }
        } else if (event.type === 'input') {
          if (this.onInputEvent) {
            this.onInputEvent(event.keyBit, event.pressed, event.mask);
          }
        }
      },
    });

    this.isRunning = true;
    this.isPaused = false;
    this.engine.start();

    // A new cartridge means new RAM allocations, so anything the cheat engine
    // learned about the old layout is stale. It is re-located on demand, the
    // first time a patch is actually applied.
    this._memMap = null;
    this._cheatRestores.length = 0;
    this._cheatError = null;
    // Installs the per-frame hook (cheat patches + speed control).
    this._applySpeed();

    if (this.onRomLoaded) {
      this.onRomLoaded(validation);
    }

    return validation;
  }

  /**
   * Starts or resumes emulation
   */
  start() {
    if (!this.engine) return;
    this.engine.start();
    this.isRunning = true;
    this.isPaused = false;
  }

  /**
   * Pauses emulation
   */
  pause() {
    if (!this.engine) return;
    this.engine.pause();
    this.isPaused = true;
  }

  /**
   * Resumes paused emulation
   */
  resume() {
    if (!this.engine) return;
    this.engine.resume();
    this.isPaused = false;
  }

  /**
   * Resets the console
   */
  reset() {
    if (!this.engine) return;
    this.engine.reset();
  }

  /**
   * Feeds raw button press/release by key bit
   * @param {number} keyBit
   * @param {boolean} pressed
   */
  setKey(keyBit, pressed) {
    if (!this.engine) return;
    this.engine.setKey(keyBit, pressed);
  }

  /**
   * Sets the 10-bit GBA keymask directly
   * @param {number} mask
   */
  setKeyMask(mask) {
    if (!this.engine) return;
    this.engine.setKeyMask(mask);
  }

  /**
   * Gets the current 10-bit GBA keymask
   * @returns {number}
   */
  getKeyMask() {
    if (!this.engine) return 0;
    return this.engine.getKeyMask();
  }

  /**
   * Reads the current SRAM (battery save) buffer from the core
   * @returns {Uint8Array | null}
   */
  getSram() {
    if (!this.engine) return null;
    return this.engine.getSram();
  }

  /**
   * Loads SRAM data into the core
   * @param {Uint8Array} sramBytes
   * @returns {boolean}
   */
  loadSram(sramBytes) {
    if (!this.engine) return false;
    return this.engine.loadSram(sramBytes);
  }

  /**
   * Captures a full savestate snapshot
   * @returns {Promise<Uint8Array>}
   */
  async saveState() {
    if (!this.engine) throw new Error('Cannot save state: No game is running.');
    return await this.engine.saveState();
  }

  /**
   * Restores a full savestate snapshot
   * @param {Uint8Array} stateBytes
   * @returns {Promise<void>}
   */
  async loadState(stateBytes) {
    if (!this.engine) throw new Error('Cannot load state: No game is running.');
    await this.engine.loadState(stateBytes);
  }

  /**
   * Captures a screenshot of the current frame
   * @returns {Promise<Blob>}
   */
  async screenshot() {
    if (!this.engine) throw new Error('Cannot take screenshot: No game is running.');
    return await this.engine.screenshot();
  }

  /**
   * Sets volume multiplier (0.0 to 1.0)
   * @param {number} vol
   */
  setVolume(vol) {
    this.options.volume = Math.max(0, Math.min(1, vol));
    if (this.engine) {
      this.engine.setVolume(this.isMuted ? 0 : this.options.volume);
    }
  }

  /**
   * Toggles mute state
   * @param {boolean} [force]
   * @returns {boolean} new mute state
   */
  toggleMute(force) {
    this.isMuted = typeof force === 'boolean' ? force : !this.isMuted;
    if (this.engine) {
      this.engine.setMuted(this.isMuted);
    }
    return this.isMuted;
  }

  // ─── Speed Control ────────────────────────────────────────────────────────

  /**
   * Sets the emulation speed multiplier.
   * 0.25 = quarter speed, 0.5 = half, 1.0 = normal, 2.0 = 2×, 4.0 = 4×
   * @param {number} multiplier
   */
  setSpeed(multiplier) {
    this._speedMultiplier = Math.max(0.25, Math.min(4.0, multiplier));
    this._applySpeed();
  }

  /**
   * Returns the current speed multiplier.
   * @returns {number}
   */
  getSpeed() {
    return this._speedMultiplier;
  }

  /**
   * Rebuilds the wrapper around the WASM core's _mgbawasm_run_frame so that each
   * emulated frame is preceded by a cheat-patch pass and the right number of
   * frames runs per SDK tick:
   *   >1× → run_frame is called N times total (N-1 extras after the real call)
   *   <1× → run_frame is skipped every M-1 out of M calls (frame-drop slow-down)
   *   1×  → one frame per tick, still patched
   *
   * Patches have to be written inside this hook rather than from a timer: the
   * emulator is only reachable between frames, so a timer would either land
   * mid-frame or miss the frame entirely.
   *
   * This approach is zero-interference with the SDK's audio-clocked pacing
   * because drainAudio() and renderFrame() still fire at the same rate —
   * only the number of emulated frames per render tick changes.
   * @private
   */
  _applySpeed() {
    // Always clear the old speed interval (kept for cleanup compatibility)
    if (this._speedIntervalId !== null) {
      clearInterval(this._speedIntervalId);
      this._speedIntervalId = null;
    }

    const mod = this.engine?.getRawModule?.();
    if (!mod) return; // no engine yet – will be applied again after loadRom

    // Remember the pristine run_frame once, then always rebuild from it so
    // repeated calls cannot stack wrappers on top of each other.
    if (!mod.__origRunFrame) {
      mod.__origRunFrame = mod._mgbawasm_run_frame.bind(mod);
    } else {
      mod._mgbawasm_run_frame = mod.__origRunFrame;
    }
    const runFrame = mod.__origRunFrame;
    const step = () => {
      this._applyCheatPatches();
      runFrame();
    };

    const mult = this._speedMultiplier;
    if (Math.abs(mult - 1.0) < 0.01) {
      // 1× – one patched frame per tick
      mod._mgbawasm_run_frame = step;
      return;
    }

    if (mult > 1.0) {
      // Fast-forward: run the frame N times per SDK tick.
      // Integer multipliers (2, 4) are exact; fractional ones round.
      const extra = Math.round(mult) - 1; // extra calls beyond the first
      mod._mgbawasm_run_frame = () => {
        step();
        for (let i = 0; i < extra; i++) step();
      };
    } else {
      // Slow-down (0.25×, 0.5×): skip frames.
      // skipEvery = how many calls to skip for every real call.
      // 0.5× → skip 1, run 1 → every other frame runs → 30fps
      // 0.25×→ skip 3, run 1 → every 4th frame runs → 15fps
      const ratio   = Math.round(1 / mult); // e.g. 2 for 0.5×, 4 for 0.25×
      let   counter = 0;
      mod._mgbawasm_run_frame = () => {
        counter = (counter + 1) % ratio;
        if (counter === 0) step();
      };
    }
  }

  // ─── Cheat Engine ─────────────────────────────────────────────────────────
  //
  // The WASM build of mGBA exports no read/write accessor for GBA RAM, so the
  // cheat engine talks to the emulator's linear memory directly. EWRAM and
  // IWRAM are separate malloc'd blocks at addresses that move every time a ROM
  // is loaded, so they are located at runtime (see _locateMemoryMap) and the
  // patches are written straight into those buffers just before each frame.
  // That is the same buffer the ARM7 CPU reads and writes through its bus, so
  // a write here is a write as far as the game is concerned.

  /**
   * Replaces the active cheat list.
   * Each entry: { label: string, code: string, enabled: boolean }
   * @param {Array<{label: string, code: string, enabled: boolean}>} cheatList
   */
  setCheats(cheatList) {
    const next = (cheatList || []).map(c => ({
      label:   c.label   || 'Unnamed',
      code:    c.code    || '',
      enabled: c.enabled !== false,
      patches: parseCheatCodes(c.code || ''),
    }));
    this._restoreDisabledCheats(next);
    this._cheats = next;
  }

  /**
   * Returns a copy of the current cheat list.
   * @returns {Array<{label: string, code: string, enabled: boolean}>}
   */
  getCheats() {
    return this._cheats.map(c => ({ label: c.label, code: c.code, enabled: c.enabled }));
  }

  /**
   * Adds or updates a single cheat entry by label.
   * @param {string} label
   * @param {string} code
   * @param {boolean} [enabled=true]
   */
  addCheat(label, code, enabled = true) {
    this.setCheats([...this.getCheats().filter(c => c.label !== label), { label, code, enabled }]);
  }

  /**
   * Removes a cheat by label.
   * @param {string} label
   */
  removeCheat(label) {
    this.setCheats(this.getCheats().filter(c => c.label !== label));
  }

  /**
   * Enables or disables a cheat by label.
   * @param {string} label
   * @param {boolean} enabled
   */
  toggleCheat(label, enabled) {
    this.setCheats(this.getCheats().map(c => (c.label === label ? { ...c, enabled } : c)));
  }

  /**
   * Clears all loaded cheats, putting back anything they had frozen.
   */
  clearCheats() {
    this.setCheats([]);
  }

  /**
   * The last cheat-engine problem, or null when everything is fine.
   * @returns {string|null}
   */
  getCheatError() {
    return this._cheatError;
  }

  /**
   * Whether the engine has found the emulated EWRAM/IWRAM yet.
   * @returns {boolean}
   */
  isCheatMemoryMapped() {
    return this._memMap !== null;
  }

  /**
   * Resolves a GBA address to a byte offset in the WASM heap.
   * @param {{ewram: number, iwram: number}} map
   * @param {number} address
   * @returns {number|null} null when the address is outside the RAM we can patch
   */
  _resolveAddress(map, address) {
    const region = cheatRegionFor(address);
    if (region === 'ewram') return map.ewram + (address & EWRAM_MASK);
    if (region === 'iwram') return map.iwram + (address & IWRAM_MASK);
    return null;
  }

  /**
   * Finds the heap offsets of the emulated EWRAM and IWRAM.
   *
   * mGBA's GBA save state ends with copies of both RAM banks, so the state blob
   * is a byte-exact mirror of the live buffers the CPU uses. The blob is
   * therefore matched back into the heap to recover the live addresses, and the
   * match is cross-checked at several independent offsets before it is trusted.
   *
   * @private
   * @returns {{ewram: number, iwram: number}|null}
   */
  _locateMemoryMap() {
    const mod = this.engine?.getRawModule?.();
    if (!mod || !mod.HEAPU8) return null;

    const stateSize = mod._mgbawasm_state_size?.();
    // Both banks plus their headers have to fit, or this is not the state we
    // know how to read and guessing would corrupt the wrong memory.
    if (!stateSize || stateSize < EWRAM_SIZE + IWRAM_SIZE) {
      this._setCheatError('Unsupported emulator core: the save state is too small to locate GBA memory.');
      return null;
    }

    const scratch = mod._malloc(stateSize);
    const capture = () => {
      mod._mgbawasm_state_save(scratch);
      // Copied out of the heap: a later heap growth would detach this view.
      return mod.HEAPU8.slice(scratch, scratch + stateSize);
    };

    try {
      const blob = capture();
      // EWRAM is the last thing in the state and IWRAM sits directly before it.
      const ewramOff = stateSize - EWRAM_SIZE;
      const iwramOff = ewramOff - IWRAM_SIZE;

      const find = (blobOffset, size) => {
        for (const base of this._matchSectionInHeap(mod.HEAPU8, blob, blobOffset, size, scratch, stateSize)) {
          if (this._confirmMemoryMapping(mod, base, blobOffset, scratch, stateSize, capture)) {
            return base;
          }
        }
        return null;
      };

      const ewram = find(ewramOff, EWRAM_SIZE);
      const iwram = find(iwramOff, IWRAM_SIZE);

      if (ewram === null) {
        this._setCheatError('Could not locate the emulated EWRAM. Let the game run a moment, then re-enable the cheat.');
        return null;
      }

      this._memMap = { ewram, iwram };
      this._setCheatError(iwram === null
        ? 'Located EWRAM but not IWRAM, so IWRAM cheats will not apply.'
        : null);
      return this._memMap;
    } finally {
      mod._free(scratch);
    }
  }

  /**
   * Proves a candidate heap address really is the RAM bank at `blobOffset`, by
   * planting a marker and asking the core to serialise itself. Content matching
   * alone is not enough: the save-state buffer we just filled is itself a copy
   * of the blob, so it matches too — but a write there is never reflected back
   * into the RAM section, which is exactly what this test distinguishes.
   *
   * @private
   * @returns {boolean}
   */
  _confirmMemoryMapping(mod, base, blobOffset, scratch, stateSize, capture) {
    const MARK = [0xa5, 0x5a, 0xc3, 0x3c, 0x69, 0x96, 0xf0, 0x0f];
    const offset = base + 0x40;   // skip the vectors at the very start of a bank
    if (offset + MARK.length > mod.HEAPU8.length) return false;

    const saved = mod.HEAPU8.slice(offset, offset + MARK.length);
    for (let i = 0; i < MARK.length; i++) mod.HEAPU8[offset + i] = MARK[i];
    const blob = capture();
    for (let i = 0; i < MARK.length; i++) mod.HEAPU8[offset + i] = saved[i];

    for (let i = 0; i < MARK.length; i++) {
      if (blob[blobOffset + 0x40 + i] !== MARK[i]) return false;
    }
    return true;
  }

  /**
   * Recovers candidate live heap addresses of a RAM bank by matching its copy in
   * the save-state blob. Several distinct windows have to agree on the same
   * base, so a coincidental single match cannot be mistaken for the real thing.
   *
   * @private
   * @param {Uint8Array} heap
   * @param {Uint8Array} blob
   * @param {number} blobOffset
   * @param {number} size
   * @param {number} excludeFrom heap offset to ignore matches in
   * @param {number} excludeTo heap offset to ignore matches up to
   * @returns {number[]} candidate bases, best first
   */
  _matchSectionInHeap(heap, blob, blobOffset, size, excludeFrom, excludeTo) {
    const WINDOW = 24;
    const usedEnd = this._highestUsedOffset(heap);
    if (usedEnd < WINDOW) return [];

    // Distinctive windows, spread across the bank. All-zero stretches (an
    // unused EWRAM, or a game's untouched IWRAM) match everywhere in the heap
    // and are useless as a fingerprint, so they are skipped.
    const stride = Math.max(4, (size >> 8) & ~3);
    const probes = [];
    for (let t = 0; t + WINDOW <= size && probes.length < 8; t += stride) {
      if (this._hasVariety(blob, blobOffset + t, WINDOW)) probes.push(t);
    }
    if (!probes.length) return [];

    const matches = (heapStart, blobStart) => {
      for (let k = 1; k < WINDOW; k++) {
        if (heap[heapStart + k] !== blob[blobStart + k]) return false;
      }
      return true;
    };

    // The whole heap is searched: the banks can sit either side of the state
    // buffer. Only the state buffer's own copy of the blob is skipped.
    const candidates = [];
    const anchor = probes[0];
    const needle = blob[blobOffset + anchor];
    let hit = heap.indexOf(needle);
    while (hit !== -1 && hit + WINDOW <= usedEnd) {
      const inScratch = hit >= excludeFrom && hit < excludeTo;
      if (!inScratch && matches(hit, blobOffset + anchor)) {
        const base = hit - anchor;
        // Confirm the rest of the fingerprints line up at the same base.
        const fits = base >= 0 &&
          probes.every(t => base + t + WINDOW <= usedEnd && matches(base + t, blobOffset + t));
        if (fits && !candidates.includes(base)) candidates.push(base);
      }
      if (candidates.length >= 8) break;
      hit = heap.indexOf(needle, hit + 1);
    }
    return candidates;
  }

  /**
   * @private
   * @param {Uint8Array} view
   * @param {number} offset
   * @param {number} length
   * @returns {boolean} true when the span holds at least three distinct bytes
   */
  _hasVariety(view, offset, length) {
    const first = view[offset];
    let second = -1;
    let third = -1;
    for (let i = 1; i < length; i++) {
      const b = view[offset + i];
      if (b === first) continue;
      if (second < 0) { second = b; continue; }
      if (b === second) continue;
      third = b;
      break;
    }
    return third >= 0;
  }

  /**
   * @private
   * @param {Uint8Array} heap
   * @returns {number} one past the last non-zero byte
   */
  _highestUsedOffset(heap) {
    for (let i = heap.length - 4; i >= 0; i -= 4) {
      if (heap[i] | heap[i + 1] | heap[i + 2] | heap[i + 3]) return i + 4;
    }
    return 0;
  }

  /**
   * @private
   * @param {string|null} message
   */
  _setCheatError(message) {
    if (this._cheatError === message) return;
    this._cheatError = message;
    if (this.onCheatChange) this.onCheatChange(message);
  }

  /**
   * Puts back the bytes a cheat froze, for cheats that are being switched off or
   * dropped. Without this, disabling "Infinite HP" would leave the game stuck at
   * the patched value until the game happened to write that address itself.
   *
   * @private
   */
  _restoreDisabledCheats(next) {
    if (!this._cheatRestores.length) return;
    const mod = this.engine?.getRawModule?.();
    const map = this._memMap;
    if (!mod || !mod.HEAPU8 || !map) {
      this._cheatRestores.length = 0;
      return;
    }

    const stillActive = new Set(
      next.filter(c => c.enabled).flatMap(c => c.patches.map(p => `${p.address}:${p.size}`))
    );
    const kept = [];
    for (const record of this._cheatRestores) {
      if (stillActive.has(record.key)) {
        kept.push(record);
        continue;
      }
      for (let i = 0; i < record.bytes.length; i++) {
        mod.HEAPU8[record.offset + i] = record.bytes[i];
      }
    }
    this._cheatRestores = kept;
  }

  /**
   * Writes every enabled cheat into emulated memory. Called once per emulated
   * frame, immediately before the core runs it, so the game sees the value for
   * the whole frame instead of racing a timer against the CPU.
   *
   * @private
   */
  _applyCheatPatches() {
    if (!this._cheats.length) return;
    const mod = this.engine?.getRawModule?.();
    // Only HEAPU8 is assumed to exist. Emscripten does not always publish the
    // wider views (this build has no HEAPU16/HEAP32), and every write here can
    // be expressed as bytes anyway.
    if (!mod || !mod.HEAPU8) return;

    const map = this._memMap || this._locateMemoryMap();
    if (!map || !map.ewram) return;

    const heap = mod.HEAPU8;
    const heapEnd = heap.length;
    const liveKeys = new Set();

    for (const cheat of this._cheats) {
      if (!cheat.enabled) continue;
      for (const patch of cheat.patches) {
        const offset = this._resolveAddress(map, patch.address);
        if (offset === null || offset + patch.size > heapEnd) continue;

        const key = `${patch.address}:${patch.size}`;
        liveKeys.add(key);
        if (!this._cheatRestores.some(r => r.key === key)) {
          this._cheatRestores.push({
            key,
            offset,
            bytes: Array.from(heap.subarray(offset, offset + patch.size)),
          });
        }
        for (let i = 0; i < patch.size; i++) {
          heap[offset + i] = (patch.value >>> (8 * i)) & 0xFF;
        }
      }
    }

    if (this._cheatRestores.length) {
      this._cheatRestores = this._cheatRestores.filter(r => liveKeys.has(r.key));
    }
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────────

  /**
   * Shuts down and cleans up the core
   */
  destroy() {
    if (this._speedIntervalId !== null) {
      clearInterval(this._speedIntervalId);
      this._speedIntervalId = null;
    }
    this._memMap = null;
    this._cheatRestores.length = 0;
    // Restore wrapped run_frame before destroying engine
    const mod = this.engine?.getRawModule?.();
    if (mod && mod.__origRunFrame) {
      mod._mgbawasm_run_frame = mod.__origRunFrame;
      delete mod.__origRunFrame;
    }
    if (this.engine) {
      try {
        this.engine.destroy();
      } catch (e) {
        console.warn('Error during engine destroy:', e);
      }
      this.engine = null;
    }
    this.isRunning = false;
    this.isPaused = false;
    this.currentRomBytes = null;
    this.currentRomInfo = null;
  }
}
