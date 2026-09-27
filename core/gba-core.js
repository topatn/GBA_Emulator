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

  /**
   * Shuts down and cleans up the core
   */
  destroy() {
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
