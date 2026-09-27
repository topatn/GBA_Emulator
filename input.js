/**
 * GBA Input Controller & Keyboard Mapper
 * Hard-mapped controls per specification:
 * W/A/S/D -> D-Pad Up/Left/Down/Right
 * J -> A button
 * K -> B button
 * Q -> L shoulder
 * E -> R shoulder
 * C -> Select
 * V -> Start
 */

import { GBA_KEY } from './core/gba-core.js';

export const KEY_BINDINGS = {
  // D-Pad
  KeyW: GBA_KEY.UP,
  w: GBA_KEY.UP,
  W: GBA_KEY.UP,

  KeyA: GBA_KEY.LEFT,
  a: GBA_KEY.LEFT,
  A: GBA_KEY.LEFT,

  KeyS: GBA_KEY.DOWN,
  s: GBA_KEY.DOWN,
  S: GBA_KEY.DOWN,

  KeyD: GBA_KEY.RIGHT,
  d: GBA_KEY.RIGHT,
  D: GBA_KEY.RIGHT,

  // Action Buttons
  KeyJ: GBA_KEY.A,
  j: GBA_KEY.A,
  J: GBA_KEY.A,

  KeyK: GBA_KEY.B,
  k: GBA_KEY.B,
  K: GBA_KEY.B,

  // Shoulder Buttons
  KeyQ: GBA_KEY.L,
  q: GBA_KEY.L,
  Q: GBA_KEY.L,

  KeyE: GBA_KEY.R,
  e: GBA_KEY.R,
  E: GBA_KEY.R,

  // System Buttons
  KeyC: GBA_KEY.SELECT,
  c: GBA_KEY.SELECT,
  C: GBA_KEY.SELECT,

  KeyV: GBA_KEY.START,
  v: GBA_KEY.START,
  V: GBA_KEY.START,
};

export class InputManager {
  /**
   * @param {import('./core/gba-core.js').GbaEmulatorCore} core
   * @param {HTMLElement} focusContainer (canvas or emulator bezel)
   */
  constructor(core, focusContainer) {
    this.core = core;
    this.focusContainer = focusContainer;
    this.pressedCodes = new Set();
    this.currentMask = 0;
    this.onKeyStateChange = null;

    this._onKeyDown = this.handleKeyDown.bind(this);
    this._onKeyUp = this.handleKeyUp.bind(this);
    this._onBlur = this.handleBlur.bind(this);

    this.attach();
  }

  attach() {
    window.addEventListener('keydown', this._onKeyDown, { passive: false });
    window.addEventListener('keyup', this._onKeyUp, { passive: false });
    window.addEventListener('blur', this._onBlur);
  }

  detach() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
  }

  isFocused() {
    const active = document.activeElement;
    if (!active || active === document.body || active === this.focusContainer || this.focusContainer?.contains(active)) {
      return true;
    }
    // Ignore when user is typing inside text fields/inputs
    if (active.tagName === 'INPUT' && (active.type === 'text' || active.type === 'search')) return false;
    if (active.tagName === 'TEXTAREA') return false;
    return true;
  }

  resolveKey(e) {
    if (KEY_BINDINGS[e.code] !== undefined) return KEY_BINDINGS[e.code];
    if (KEY_BINDINGS[e.key] !== undefined) return KEY_BINDINGS[e.key];
    return undefined;
  }

  handleKeyDown(e) {
    // Ignore OS auto-repeat
    if (e.repeat) return;

    const gbaKey = this.resolveKey(e);
    if (gbaKey === undefined) return;

    // Track pressed keys
    this.pressedCodes.add(e.code);

    if (this.isFocused()) {
      e.preventDefault();
    }

    this.setGbaButton(gbaKey, true);
  }

  handleKeyUp(e) {
    const gbaKey = this.resolveKey(e);
    if (gbaKey === undefined) return;

    this.pressedCodes.delete(e.code);

    if (this.isFocused()) {
      e.preventDefault();
    }

    // Verify whether any other code mapped to this same GBA key is still held
    let stillHeld = false;
    for (const code of this.pressedCodes) {
      if (KEY_BINDINGS[code] === gbaKey) {
        stillHeld = true;
        break;
      }
    }

    if (!stillHeld) {
      this.setGbaButton(gbaKey, false);
    }
  }

  handleBlur() {
    // Clear all pressed keys when window loses focus
    this.pressedCodes.clear();
    this.currentMask = 0;
    if (this.core) {
      this.core.setKeyMask(0);
    }
    if (this.onKeyStateChange) {
      this.onKeyStateChange(null, false, 0);
    }
  }

  setGbaButton(keyBit, pressed) {
    const bitFlag = 1 << keyBit;
    if (pressed) {
      this.currentMask |= bitFlag;
    } else {
      this.currentMask &= ~bitFlag;
    }

    if (this.core) {
      this.core.setKey(keyBit, pressed);
    }

    if (this.onKeyStateChange) {
      this.onKeyStateChange(keyBit, pressed, this.currentMask);
    }
  }
}
