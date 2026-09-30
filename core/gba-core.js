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
// GBA memory map constants for cheat patching
// The WASM emulator maps GBA address space at a fixed offset in its heap.
// EWRAM: 0x02000000..0x0203FFFF (256 KB)
// IWRAM: 0x03000000..0x03007FFF (32 KB)
// I/O:   0x04000000..0x040003FE
// We compute the JS heap offset using the raw module's memory layout.

/**
 * Parses a GameShark / Action Replay cheat code string into a list of
 * { address, value, size } patch operations.
 *
 * Supported formats:
 *  - GameShark v1 (GBA): XXXXXXXX YYYY  (32-bit address, 16-bit value)
 *  - GameShark v3 / AR v3: 0AAAAAAA VVVVVVVV (various sub-types by prefix nibble)
 *  - 8-bit patch: lines starting with 0x00..0x0F / C4..C7, address + 2-hex value
 *
 * Returns null entries for unrecognised lines.
 * @param {string} codeText
 * @returns {Array<{address: number, value: number, size: 1|2|4}>}
 */
export function parseCheatCodes(codeText) {
  const patches = [];
  const lines = codeText.split(/\n/).map(l => l.trim()).filter(Boolean);

  for (const line of lines) {
    // Strip comments
    const clean = line.replace(/;.*$/, '').replace(/\/\/.*$/, '').trim();
    if (!clean) continue;

    // Allow spaces or dashes in the middle
    const parts = clean.split(/[\s\-]+/);
    if (parts.length < 2) continue;

    const addrHex = parts[0].replace(/^0x/i, '');
    const valHex  = parts[1].replace(/^0x/i, '');

    if (!/^[0-9a-fA-F]{6,8}$/.test(addrHex)) continue;
    if (!/^[0-9a-fA-F]{2,8}$/.test(valHex))  continue;

    const rawAddr = parseInt(addrHex, 16);
    const rawVal  = parseInt(valHex,  16);

    // Decode by upper nibble / length
    const typeNibble = (rawAddr >>> 28) & 0xF;

    if (addrHex.length === 8) {
      // Action Replay v3 / GameShark v3-style decoding
      const addr = rawAddr & 0x0FFFFFFF;
      if (typeNibble === 0x0 || typeNibble === 0x1) {
        // 32-bit write
        patches.push({ address: addr, value: rawVal, size: 4 });
      } else if (typeNibble === 0x2 || typeNibble === 0x3) {
        // 16-bit write
        patches.push({ address: addr, value: rawVal & 0xFFFF, size: 2 });
      } else if (typeNibble === 0x8 || typeNibble === 0x9 ||
                 typeNibble === 0xC || typeNibble === 0xD) {
        // 8-bit write
        patches.push({ address: addr, value: rawVal & 0xFF, size: 1 });
      } else {
        // Fallback: treat value width by hex length
        const sz = valHex.length <= 2 ? 1 : valHex.length <= 4 ? 2 : 4;
        patches.push({ address: addr, value: rawVal, size: sz });
      }
    } else if (addrHex.length === 6) {
      // Old GameShark v1 (6-char address) — always 16-bit writes
      patches.push({ address: rawAddr, value: rawVal & 0xFFFF, size: 2 });
    }
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
    this._cheats = [];           // Array<{address,value,size,enabled,label}>
    this._cheatIntervalId = null;

    // Callbacks
    this.onFpsUpdate = null;
    this.onInputEvent = null;
    this.onRomLoaded = null;
    this.onError = null;
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

    // (Re)start cheat application loop
    this._startCheatLoop();
    // Reapply speed after ROM reload
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
   * Wraps the WASM core's _mgbawasm_run_frame so every SDK-driven tick
   * runs the correct number of emulated frames:
   *   >1× → run_frame is called N times total (N-1 extras after the real call)
   *   <1× → run_frame is skipped every M-1 out of M calls (frame-drop slow-down)
   *   1×  → unwrap / restore the original function
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

    // Restore the original run_frame first (idempotent)
    if (mod.__origRunFrame) {
      mod._mgbawasm_run_frame = mod.__origRunFrame;
      delete mod.__origRunFrame;
    }

    const mult = this._speedMultiplier;
    if (Math.abs(mult - 1.0) < 0.01) return; // 1× – nothing to wrap

    // Save the original
    mod.__origRunFrame = mod._mgbawasm_run_frame.bind(mod);

    if (mult > 1.0) {
      // Fast-forward: run the frame N times per SDK tick.
      // Integer multipliers (2, 4) are exact; fractional ones round.
      const extra = Math.round(mult) - 1; // extra calls beyond the first
      mod._mgbawasm_run_frame = () => {
        mod.__origRunFrame();
        for (let i = 0; i < extra; i++) mod.__origRunFrame();
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
        if (counter === 0) mod.__origRunFrame();
      };
    }
  }

  // ─── Cheat Engine ─────────────────────────────────────────────────────────

  /**
   * Replaces the active cheat list.
   * Each entry: { label: string, code: string, enabled: boolean }
   * @param {Array<{label: string, code: string, enabled: boolean}>} cheatList
   */
  setCheats(cheatList) {
    this._cheats = (cheatList || []).map(c => ({
      label:   c.label   || 'Unnamed',
      code:    c.code    || '',
      enabled: c.enabled !== false,
      patches: parseCheatCodes(c.code || ''),
    }));
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
    const existing = this._cheats.findIndex(c => c.label === label);
    const entry = { label, code, enabled, patches: parseCheatCodes(code) };
    if (existing >= 0) {
      this._cheats[existing] = entry;
    } else {
      this._cheats.push(entry);
    }
  }

  /**
   * Removes a cheat by label.
   * @param {string} label
   */
  removeCheat(label) {
    this._cheats = this._cheats.filter(c => c.label !== label);
  }

  /**
   * Enables or disables a cheat by label.
   * @param {string} label
   * @param {boolean} enabled
   */
  toggleCheat(label, enabled) {
    const c = this._cheats.find(e => e.label === label);
    if (c) c.enabled = enabled;
  }

  /**
   * Clears all loaded cheats.
   */
  clearCheats() {
    this._cheats = [];
  }

  /**
   * Internal: starts the cheat application loop that writes patches to WASM memory.
   * GBA address space is mapped inside the WASM heap. The offset of GBA address
   * 0x00000000 within mod.HEAPU8 is obtained via _mgbawasm_video_ptr heuristic:
   * we locate VRAM at GBA addr 0x06000000 and back-calculate the base.
   * @private
   */
  _startCheatLoop() {
    if (this._cheatIntervalId !== null) {
      clearInterval(this._cheatIntervalId);
      this._cheatIntervalId = null;
    }

    this._cheatIntervalId = setInterval(() => {
      if (!this.isRunning || this.isPaused || this._cheats.length === 0) return;
      const mod = this.engine?.getRawModule?.();
      if (!mod || !mod.HEAPU8 || !mod.HEAPU16 || !mod.HEAPU32) return;

      // Locate the GBA memory base in JS heap.
      // _mgbawasm_video_ptr() returns the WASM pointer to VRAM (GBA: 0x06000000).
      let gbaBase = this._gbaMemBase;
      if (gbaBase === undefined) {
        try {
          const vramPtr = mod._mgbawasm_video_ptr();
          // VRAM is at GBA address 0x06000000, so base = ptr - 0x06000000
          gbaBase = vramPtr - 0x06000000;
          this._gbaMemBase = gbaBase;
        } catch (e) {
          return; // not ready yet
        }
      }

      for (const cheat of this._cheats) {
        if (!cheat.enabled || !cheat.patches.length) continue;
        for (const patch of cheat.patches) {
          try {
            const heapOffset = gbaBase + patch.address;
            if (heapOffset < 0 || heapOffset + patch.size > mod.HEAPU8.length) continue;
            if (patch.size === 1) {
              mod.HEAPU8[heapOffset] = patch.value & 0xFF;
            } else if (patch.size === 2) {
              mod.HEAPU16[heapOffset >> 1] = patch.value & 0xFFFF;
            } else {
              mod.HEAPU32[heapOffset >> 2] = patch.value >>> 0;
            }
          } catch (e) {
            // Ignore out-of-bounds patches silently
          }
        }
      }
    }, 16); // ~60 Hz application rate
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
    if (this._cheatIntervalId !== null) {
      clearInterval(this._cheatIntervalId);
      this._cheatIntervalId = null;
    }
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
    this._gbaMemBase = undefined;
    this.currentRomBytes = null;
    this.currentRomInfo = null;
  }
}
