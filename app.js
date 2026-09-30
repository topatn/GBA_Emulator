/**
 * PokéAdvance Main Application Logic
 * Integrates mGBA WebAssembly core, File System Access saves, and hard-mapped controls.
 */

import { GbaEmulatorCore, GBA_KEY, validateGbaRom, parseCheatCodes } from './core/gba-core.js';
import { InputManager } from './input.js';
import {
  isFileSystemAccessSupported,
  pickSaveFolder,
  readBatterySave,
  writeBatterySave,
  readSaveState,
  writeSaveState,
  inspectSaveSlots,
  getRomBaseName,
  hashBytes,
  isSramEmpty,
  triggerFileDownload,
} from './saves.js';

// DOM Elements
const canvas = document.getElementById('gba-canvas');
const chassis = document.getElementById('gba-chassis');
const screenFrame = document.getElementById('screen-frame');
const dropOverlay = document.getElementById('drop-overlay');
const pauseOverlay = document.getElementById('pause-overlay');
const romFileInput = document.getElementById('rom-file-input');

// Header Elements
const folderStatusBtn = document.getElementById('folder-status-btn');
const folderStatusLabel = document.getElementById('folder-status-label');
const fpsCounter = document.getElementById('fps-counter');
const muteToggleBtn = document.getElementById('mute-toggle-btn');
const volumeIconOn = document.getElementById('volume-icon-on');
const volumeIconOff = document.getElementById('volume-icon-off');
const volumeSlider = document.getElementById('volume-slider');
const fsaWarningBanner = document.getElementById('fsa-warning-banner');

// Control Strip Elements
const loadRomBtn = document.getElementById('load-rom-btn');
const browseRomBtn = document.getElementById('browse-rom-btn');
const promptSaveFolderBtn = document.getElementById('prompt-save-folder-btn');
const setFolderBtn = document.getElementById('set-folder-btn');
const saveStateBtn = document.getElementById('save-state-btn');
const loadStateBtn = document.getElementById('load-state-btn');
const resetBtn = document.getElementById('reset-btn');
const pauseBtn = document.getElementById('pause-btn');
const pauseIcon = document.getElementById('pause-icon');
const resumeIcon = document.getElementById('resume-icon');
const pauseBtnLabel = document.getElementById('pause-btn-label');
const fullscreenBtn = document.getElementById('fullscreen-btn');
const slotPills = document.querySelectorAll('.slot-pill');

// Metadata Bar
const metaGameTitle = document.getElementById('meta-game-title');
const metaGameCode = document.getElementById('meta-game-code');
const metaRomSize = document.getElementById('meta-rom-size');
const metaSaveStatus = document.getElementById('meta-save-status');

// Manual Saves Panel
const manualExportSramBtn = document.getElementById('manual-export-sram-btn');
const manualImportSramInput = document.getElementById('manual-import-sram-input');
const manualExportStateBtn = document.getElementById('manual-export-state-btn');
const manualImportStateInput = document.getElementById('manual-import-state-input');

// Toast Container
const toastContainer = document.getElementById('toast-container');

// Virtual buttons mapping for interactive controller HUD
const virtualButtons = {
  [GBA_KEY.UP]: document.getElementById('v-btn-w'),
  [GBA_KEY.LEFT]: document.getElementById('v-btn-a'),
  [GBA_KEY.DOWN]: document.getElementById('v-btn-s'),
  [GBA_KEY.RIGHT]: document.getElementById('v-btn-d'),
  [GBA_KEY.A]: document.getElementById('v-btn-j'),
  [GBA_KEY.B]: document.getElementById('v-btn-k'),
  [GBA_KEY.L]: document.getElementById('v-btn-q'),
  [GBA_KEY.R]: document.getElementById('v-btn-e'),
  [GBA_KEY.SELECT]: document.getElementById('v-btn-c'),
  [GBA_KEY.START]: document.getElementById('v-btn-v'),
};

// Application State
let core = null;
let inputManager = null;
let saveDirHandle = null;
let currentRomBaseName = '';
let activeSlot = 1;
let lastSramHash = 0;
let autoSaveIntervalId = null;

// Speed state
const SPEED_STEPS = [0.25, 0.5, 1.0, 2.0, 4.0];
let currentSpeedIndex = 2; // starts at 1.0×

// Cheat state  (array of { label, code, enabled })
let cheatList = [];

/**
 * Displays a toast notification
 * @param {string} message
 * @param {'info' | 'success' | 'error'} type
 * @param {number} duration
 */
function showToast(message, type = 'info', duration = 3500) {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span>${message}</span>
  `;
  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    setTimeout(() => {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    }, 300);
  }, duration);
}

/**
 * Initializes the GBA core and input listeners
 */
function initApp() {
  // Check File System Access API support
  if (!isFileSystemAccessSupported()) {
    fsaWarningBanner.classList.remove('hidden');
    folderStatusLabel.textContent = 'Save Folder (Unsupported Browser)';
    folderStatusBtn.classList.remove('connected');
    folderStatusBtn.classList.add('disconnected');
    showToast('Your browser does not support the File System Access API. Manual export/import is enabled.', 'info', 6000);
  }

  // Create core
  core = new GbaEmulatorCore(canvas, {
    volume: 1.0,
    renderFilter: 'pixelated',
  });

  // Attach FPS updates
  core.onFpsUpdate = (fps) => {
    fpsCounter.textContent = `${fps.toFixed(1)} FPS`;
  };

  // Attach Input Manager
  inputManager = new InputManager(core, canvas);
  inputManager.onKeyStateChange = (keyBit, pressed) => {
    if (keyBit !== null && virtualButtons[keyBit]) {
      if (pressed) {
        virtualButtons[keyBit].classList.add('active');
      } else {
        virtualButtons[keyBit].classList.remove('active');
      }
    }
  };

  // Wire Virtual Button Touch/Click
  Object.entries(virtualButtons).forEach(([keyBitStr, el]) => {
    if (!el) return;
    const bit = parseInt(keyBitStr, 10);
    const press = (e) => {
      e.preventDefault();
      inputManager.setGbaButton(bit, true);
    };
    const release = (e) => {
      e.preventDefault();
      inputManager.setGbaButton(bit, false);
    };
    el.addEventListener('pointerdown', press);
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('pointerleave', release);
  });

  // Start periodic SRAM battery auto-save
  setupAutoSave();

  // Attach UI Events
  setupEventListeners();
}

/**
 * Configures the periodic battery save writer
 */
function setupAutoSave() {
  if (autoSaveIntervalId) clearInterval(autoSaveIntervalId);

  // Periodically check every 5 seconds if SRAM changed and write it
  autoSaveIntervalId = setInterval(async () => {
    if (!core || !core.isRunning || !saveDirHandle || !currentRomBaseName) return;

    try {
      const sram = core.getSram();
      if (!sram || sram.length === 0 || isSramEmpty(sram)) return;

      const currentHash = hashBytes(sram);
      if (currentHash !== lastSramHash) {
        await writeBatterySave(saveDirHandle, currentRomBaseName, sram);
        lastSramHash = currentHash;
        const now = new Date();
        const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        metaSaveStatus.textContent = `Auto-saved at ${timeStr}`;
      }
    } catch (err) {
      console.warn('Periodic auto-save write error:', err);
    }
  }, 5000);

  // Also auto-save on beforeunload / pagehide
  window.addEventListener('beforeunload', () => {
    if (core && core.isRunning && saveDirHandle && currentRomBaseName) {
      const sram = core.getSram();
      if (sram && sram.length > 0) {
        void writeBatterySave(saveDirHandle, currentRomBaseName, sram);
      }
    }
  });
}

/**
 * Handles choosing and verifying a local save directory
 */
async function handleSelectSaveFolder() {
  if (!isFileSystemAccessSupported()) {
    showToast('The File System Access API is not supported in this browser. Please use Chrome, Edge, or Brave for direct folder saves.', 'error', 6000);
    return;
  }

  try {
    const handle = await pickSaveFolder();
    saveDirHandle = handle;

    folderStatusLabel.textContent = `Saves: ${handle.name}/`;
    folderStatusBtn.classList.remove('disconnected');
    folderStatusBtn.classList.add('connected');
    showToast(`Connected to saves folder: "${handle.name}"`, 'success');

    // If a game is already running, check for existing battery save and update slot status
    if (currentRomBaseName) {
      await loadExistingBatterySave();
      await updateSlotStatus();
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('Save folder selection failed:', err);
      showToast('Could not access selected folder: ' + err.message, 'error');
    }
  }
}

/**
 * Checks for and loads an existing .sav file for the active ROM
 */
async function loadExistingBatterySave() {
  if (!saveDirHandle || !currentRomBaseName || !core) return;

  try {
    const sram = await readBatterySave(saveDirHandle, currentRomBaseName);
    if (sram && sram.length > 0) {
      const ok = core.loadSram(sram);
      if (ok) {
        lastSramHash = hashBytes(sram);
        metaSaveStatus.textContent = `Loaded ${currentRomBaseName}.sav`;
        showToast(`Loaded battery save: "${currentRomBaseName}.sav" (${(sram.length / 1024).toFixed(0)} KB)`, 'success');
      }
    } else {
      metaSaveStatus.textContent = 'New Save';
    }
  } catch (err) {
    console.warn('Failed to load battery save:', err);
  }
}

/**
 * Inspects save state slots and updates badges
 */
async function updateSlotStatus() {
  if (!saveDirHandle || !currentRomBaseName) return;
  try {
    const slots = await inspectSaveSlots(saveDirHandle, currentRomBaseName, 3);
    slots.forEach((s) => {
      const pill = document.querySelector(`.slot-pill[data-slot="${s.slot}"]`);
      if (pill) {
        if (s.exists) {
          pill.title = `Slot ${s.slot}: ${(s.size / 1024).toFixed(0)} KB (${s.modified?.toLocaleTimeString()})`;
        } else {
          pill.title = `Slot ${s.slot}: Empty`;
        }
      }
    });
  } catch (e) {
    console.warn('Error inspecting save slots:', e);
  }
}

/**
 * Loads and validates a ROM file from ArrayBuffer
 * @param {File} file
 */
async function handleRomFile(file) {
  if (!file) return;

  showToast(`Reading "${file.name}"...`, 'info', 2000);

  try {
    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    // Header & size validation check
    const validation = validateGbaRom(bytes);
    if (!validation.valid) {
      showToast(`Header validation failed: ${validation.error}`, 'error', 6000);
      return;
    }

    currentRomBaseName = getRomBaseName(file.name);

    // Boot into mGBA
    await core.loadRom(bytes, file.name);

    // Hide welcome drop overlay
    dropOverlay.classList.add('hidden');
    pauseOverlay.classList.add('hidden');

    // Update game metadata
    metaGameTitle.textContent = validation.title;
    metaGameCode.textContent = validation.gameCode;
    metaRomSize.textContent = `${(file.size / (1024 * 1024)).toFixed(1)} MB`;
    metaSaveStatus.textContent = 'Active';

    showToast(`Booted: ${validation.title} [${validation.gameCode}]`, 'success', 4000);

    // Focus canvas for immediate controls
    canvas.focus();

    // Check save folder
    if (saveDirHandle) {
      await loadExistingBatterySave();
      await updateSlotStatus();
    } else {
      if (isFileSystemAccessSupported()) {
        showToast('Tip: Click "Save Folder" to enable automatic battery saves directly on your PC!', 'info', 5000);
      }
    }
  } catch (err) {
    console.error('ROM Boot Error:', err);
    showToast(`Failed to boot ROM: ${err.message}`, 'error', 6000);
  }
}

/**
 * Sets up UI event listeners
 */
function setupEventListeners() {
  // Load ROM Buttons
  loadRomBtn.addEventListener('click', () => romFileInput.click());
  browseRomBtn.addEventListener('click', () => romFileInput.click());

  romFileInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) handleRomFile(file);
    romFileInput.value = '';
  });

  // Choose Save Folder Buttons
  setFolderBtn.addEventListener('click', handleSelectSaveFolder);
  folderStatusBtn.addEventListener('click', handleSelectSaveFolder);
  promptSaveFolderBtn.addEventListener('click', handleSelectSaveFolder);

  // Drag and Drop ROM loading
  const dropTargets = [chassis, dropOverlay];
  dropTargets.forEach((target) => {
    target.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropOverlay.classList.add('dragover');
    });

    target.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropOverlay.classList.remove('dragover');
    });

    target.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropOverlay.classList.remove('dragover');
      const file = e.dataTransfer.files?.[0];
      if (file) {
        handleRomFile(file);
      }
    });
  });

  // Slot Selection
  slotPills.forEach((pill) => {
    pill.addEventListener('click', () => {
      slotPills.forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
      activeSlot = parseInt(pill.dataset.slot, 10) || 1;
      saveStateBtn.title = `Save snapshot to Slot ${activeSlot} in local folder`;
      loadStateBtn.title = `Restore snapshot from Slot ${activeSlot} in local folder`;
      showToast(`Selected State Slot ${activeSlot}`, 'info', 1500);
    });
  });

  // Save State Action
  saveStateBtn.addEventListener('click', async () => {
    if (!core || !core.isRunning) {
      showToast('No game currently running.', 'error');
      return;
    }

    try {
      const stateBytes = await core.saveState();

      if (saveDirHandle) {
        const result = await writeSaveState(saveDirHandle, currentRomBaseName, activeSlot, stateBytes);
        showToast(`Saved state to "${result.fileName}" (${(result.size / 1024).toFixed(0)} KB)`, 'success');
        await updateSlotStatus();
      } else {
        // Fallback file download if no folder selected
        triggerFileDownload(stateBytes, `${currentRomBaseName}.state${activeSlot}`);
        showToast(`Downloaded state file for Slot ${activeSlot} (Choose a Save Folder for direct local saving)`, 'info', 4000);
      }
    } catch (err) {
      console.error('Save state failed:', err);
      showToast('Save state failed: ' + err.message, 'error');
    }
  });

  // Load State Action
  loadStateBtn.addEventListener('click', async () => {
    if (!core || !core.isRunning) {
      showToast('No game currently running.', 'error');
      return;
    }

    try {
      if (saveDirHandle) {
        const stateBytes = await readSaveState(saveDirHandle, currentRomBaseName, activeSlot);
        await core.loadState(stateBytes);
        showToast(`Loaded state from Slot ${activeSlot}`, 'success');
      } else {
        showToast('Please select a Save Folder first, or use the "Import State File" button below.', 'error');
      }
    } catch (err) {
      console.error('Load state failed:', err);
      showToast(`Could not load Slot ${activeSlot}: ${err.message}`, 'error');
    }
  });

  // Reset Button
  resetBtn.addEventListener('click', () => {
    if (!core || !core.isRunning) return;
    core.reset();
    showToast('Console reset.', 'info');
  });

  // Pause / Resume Button
  const togglePause = () => {
    if (!core || !core.isRunning) return;
    if (core.isPaused) {
      core.resume();
      pauseOverlay.classList.add('hidden');
      pauseIcon.classList.remove('hidden');
      resumeIcon.classList.add('hidden');
      pauseBtnLabel.textContent = 'Pause';
      showToast('Emulation resumed', 'info', 1500);
    } else {
      core.pause();
      pauseOverlay.classList.remove('hidden');
      pauseIcon.classList.add('hidden');
      resumeIcon.classList.remove('hidden');
      pauseBtnLabel.textContent = 'Resume';
      showToast('Emulation paused', 'info', 1500);
    }
  };

  pauseBtn.addEventListener('click', togglePause);
  pauseOverlay.addEventListener('click', togglePause);

  // Mute Toggle Button
  muteToggleBtn.addEventListener('click', () => {
    if (!core) return;
    const isMuted = core.toggleMute();
    if (isMuted) {
      volumeIconOn.classList.add('hidden');
      volumeIconOff.classList.remove('hidden');
      showToast('Audio Muted', 'info', 1200);
    } else {
      volumeIconOn.classList.remove('hidden');
      volumeIconOff.classList.add('hidden');
      showToast('Audio Unmuted', 'info', 1200);
    }
  });

  // Volume Slider
  volumeSlider.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10) / 100;
    if (core) {
      core.setVolume(val);
      if (val === 0) {
        volumeIconOn.classList.add('hidden');
        volumeIconOff.classList.remove('hidden');
      } else {
        volumeIconOn.classList.remove('hidden');
        volumeIconOff.classList.add('hidden');
      }
    }
  });

  // Fullscreen Button
  fullscreenBtn.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      screenFrame.requestFullscreen?.().catch((err) => {
        showToast('Fullscreen error: ' + err.message, 'error');
      });
    } else {
      document.exitFullscreen?.();
    }
  });

  // Manual Export / Import SRAM Fallback
  manualExportSramBtn.addEventListener('click', () => {
    if (!core || !core.isRunning) {
      showToast('No game currently running.', 'error');
      return;
    }
    const sram = core.getSram();
    if (sram && sram.length > 0) {
      triggerFileDownload(sram, `${currentRomBaseName || 'game'}.sav`);
      showToast(`Exported "${currentRomBaseName || 'game'}.sav"`, 'success');
    } else {
      showToast('No battery save data available to export yet.', 'info');
    }
  });

  manualImportSramInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file || !core || !core.isRunning) return;

    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      const ok = core.loadSram(bytes);
      if (ok) {
        showToast(`Imported battery save from "${file.name}"`, 'success');
      } else {
        showToast('Failed to load battery save into core.', 'error');
      }
    } catch (err) {
      showToast('Error importing SRAM: ' + err.message, 'error');
    }
    manualImportSramInput.value = '';
  });

  // Manual Export / Import Save State Fallback
  manualExportStateBtn.addEventListener('click', async () => {
    if (!core || !core.isRunning) {
      showToast('No game currently running.', 'error');
      return;
    }
    try {
      const bytes = await core.saveState();
      triggerFileDownload(bytes, `${currentRomBaseName || 'game'}.state${activeSlot}`);
      showToast(`Exported state snapshot for Slot ${activeSlot}`, 'success');
    } catch (err) {
      showToast('Export state failed: ' + err.message, 'error');
    }
  });

  manualImportStateInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file || !core || !core.isRunning) return;

    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      await core.loadState(bytes);
      showToast(`Restored state snapshot from "${file.name}"`, 'success');
    } catch (err) {
      showToast('Error restoring state: ' + err.message, 'error');
    }
    manualImportStateInput.value = '';
  });

  // Ensure clicking the canvas restores focus
  canvas.addEventListener('click', () => canvas.focus());

  // ── Speed Control ─────────────────────────────────────────────────────────
  const speedDownBtn  = document.getElementById('speed-down-btn');
  const speedUpBtn    = document.getElementById('speed-up-btn');
  const speedDisplay  = document.getElementById('speed-display');

  function applySpeed() {
    const mult = SPEED_STEPS[currentSpeedIndex];
    if (speedDisplay) speedDisplay.textContent = `${mult}×`;
    if (speedDownBtn) speedDownBtn.disabled = currentSpeedIndex <= 0;
    if (speedUpBtn)   speedUpBtn.disabled   = currentSpeedIndex >= SPEED_STEPS.length - 1;
    if (core) {
      core.setSpeed(mult);
      const label = mult === 1.0 ? 'Normal speed' : mult < 1 ? `Slow motion ${mult}×` : `Fast-forward ${mult}×`;
      showToast(label, 'info', 1200);
    }
  }

  if (speedDownBtn) {
    speedDownBtn.addEventListener('click', () => {
      if (currentSpeedIndex > 0) { currentSpeedIndex--; applySpeed(); }
    });
  }
  if (speedUpBtn) {
    speedUpBtn.addEventListener('click', () => {
      if (currentSpeedIndex < SPEED_STEPS.length - 1) { currentSpeedIndex++; applySpeed(); }
    });
  }
  // Keyboard shortcut: Tab = speed up, Shift+Tab = speed down (while not in inputs)
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.code === 'BracketRight' && !e.shiftKey) {
      e.preventDefault();
      if (currentSpeedIndex < SPEED_STEPS.length - 1) { currentSpeedIndex++; applySpeed(); }
    } else if (e.code === 'BracketLeft' && !e.shiftKey) {
      e.preventDefault();
      if (currentSpeedIndex > 0) { currentSpeedIndex--; applySpeed(); }
    }
  });

  // ── Cheat Engine UI ───────────────────────────────────────────────────────
  const cheatToggleBtn = document.getElementById('cheat-panel-toggle-btn');
  const cheatPanel     = document.getElementById('cheat-panel');
  const cheatLabelInput = document.getElementById('cheat-label-input');
  const cheatCodeInput  = document.getElementById('cheat-code-input');
  const cheatAddBtn     = document.getElementById('cheat-add-btn');
  const cheatList_el    = document.getElementById('cheat-list');
  const cheatClearAllBtn = document.getElementById('cheat-clear-all-btn');

  if (cheatToggleBtn && cheatPanel) {
    cheatToggleBtn.addEventListener('click', () => {
      const isNowHidden = cheatPanel.classList.toggle('hidden');
      cheatToggleBtn.classList.toggle('active', !isNowHidden);
      if (!isNowHidden) {
        // Scroll the panel into view smoothly after the CSS display kicks in
        requestAnimationFrame(() => {
          cheatPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
      }
    });
  }

  function renderCheatList() {
    if (!cheatList_el) return;
    cheatList_el.innerHTML = '';
    if (cheatList.length === 0) {
      cheatList_el.innerHTML = '<li class="cheat-empty">No cheats loaded.</li>';
      return;
    }
    cheatList.forEach((cheat, idx) => {
      const li = document.createElement('li');
      li.className = 'cheat-entry' + (cheat.enabled ? ' enabled' : '');
      li.innerHTML = `
        <label class="cheat-toggle" title="Enable/Disable">
          <input type="checkbox" class="cheat-check" data-idx="${idx}" ${cheat.enabled ? 'checked' : ''}>
          <span class="cheat-name">${cheat.label}</span>
        </label>
        <code class="cheat-code-preview">${cheat.code.split('\n')[0].trim()}</code>
        <button class="cheat-remove-btn" data-idx="${idx}" title="Remove cheat">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>`;
      cheatList_el.appendChild(li);
    });

    // Bind checkbox toggles
    cheatList_el.querySelectorAll('.cheat-check').forEach(cb => {
      cb.addEventListener('change', () => {
        const i = parseInt(cb.dataset.idx, 10);
        cheatList[i].enabled = cb.checked;
        syncCheatsToCore();
        renderCheatList();
      });
    });
    // Bind remove buttons
    cheatList_el.querySelectorAll('.cheat-remove-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = parseInt(btn.dataset.idx, 10);
        cheatList.splice(i, 1);
        syncCheatsToCore();
        renderCheatList();
        showToast('Cheat removed.', 'info', 1200);
      });
    });
  }

  function syncCheatsToCore() {
    if (core) core.setCheats(cheatList);
  }

  if (cheatAddBtn) {
    cheatAddBtn.addEventListener('click', () => {
      const label = cheatLabelInput?.value.trim() || `Cheat ${cheatList.length + 1}`;
      const code  = cheatCodeInput?.value.trim()  || '';
      if (!code) { showToast('Please enter a cheat code.', 'error', 2000); return; }

      // Validate: try parsing it
      const patches = parseCheatCodes(code);
      if (patches.length === 0) {
        showToast('Could not parse any valid codes. Use format: XXXXXXXX YYYY', 'error', 3500);
        return;
      }

      // Check for duplicate label
      const dupIdx = cheatList.findIndex(c => c.label === label);
      if (dupIdx >= 0) {
        cheatList[dupIdx] = { label, code, enabled: true };
        showToast(`Updated cheat "${label}" (${patches.length} patch${patches.length > 1 ? 'es' : ''})`, 'success');
      } else {
        cheatList.push({ label, code, enabled: true });
        showToast(`Added cheat "${label}" (${patches.length} patch${patches.length > 1 ? 'es' : ''})`, 'success');
      }

      syncCheatsToCore();
      renderCheatList();
      if (cheatLabelInput) cheatLabelInput.value = '';
      if (cheatCodeInput)  cheatCodeInput.value  = '';
    });
  }

  if (cheatClearAllBtn) {
    cheatClearAllBtn.addEventListener('click', () => {
      cheatList = [];
      syncCheatsToCore();
      renderCheatList();
      showToast('All cheats cleared.', 'info', 1500);
    });
  }

  // Initialize display
  renderCheatList();
  applySpeed();
}

// Start application once DOM is loaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
