import { manifest } from './mgba.manifest.js';
import { bindConfig, createSettingsStore, } from './mgba.config.js';
import { coerceOptionValue, DEFAULT_MGBA_OPTIONS, MGBA_ENGINE_OPTIONS, MGBA_GB_MODEL_VALUES, MGBA_LOG_LEVEL_IDS, MGBA_PLATFORM_IDS, toEscMenuGroups, } from './mgba.options.js';
import { extractRom } from './mgba.zip.js';
export { manifest };
/** `enum mPlatform` values, as reported by `_mgbawasm_platform()`. */
const PLATFORM_GBA = 0;
const PLATFORM_GB = 1;
/** Numeric ids `mgbawasm_set_idle_optimization()` takes. */
const IDLE_IDS = { ignore: 0, remove: 1, detect: 2 };
/**
 * Bit index of each control, matching `enum GBAKey` in mGBA. The Game Boy core
 * numbers its first eight keys the same way, so one mask drives both; the L/R
 * bits are ignored while a Game Boy ROM is running.
 */
const KEY_BITS = {
    a: 0,
    b: 1,
    select: 2,
    start: 3,
    right: 4,
    left: 5,
    up: 6,
    down: 7,
    r: 8,
    l: 9,
};
/**
 * Default keyboard bindings (KeyboardEvent.code → control). X/Z sit where A/B
 * do on the handheld: A is the right-hand button, B the left one.
 */
const DEFAULT_KEYMAP = {
    'p1.up': ['KeyW', 'w', 'W'],
    'p1.down': ['KeyS', 's', 'S'],
    'p1.left': ['KeyA', 'a', 'A'],
    'p1.right': ['KeyD', 'd', 'D'],
    'p1.a': ['KeyJ', 'j', 'J'],
    'p1.b': ['KeyK', 'k', 'K'],
    'p1.l': ['KeyQ', 'q', 'Q'],
    'p1.r': ['KeyE', 'e', 'E'],
    'p1.start': ['KeyV', 'v', 'V'],
    'p1.select': ['KeyC', 'c', 'C'],
};
/**
 * AudioWorklet processor: an SPSC float ring fed int16 chunks, resampling on
 * the way out.
 *
 * The resampling is here rather than in the SDK because these cores emit at a
 * rate the SDK does not choose and cannot pin: 131072 Hz on Game Boy, and 32768
 * or 65536 Hz on GBA depending on what the running game has written to
 * SOUNDBIAS. A `rate` message retunes the read cursor mid-stream, so a game
 * changing resolution is a ratio change and not a glitch.
 *
 * `consumed` is reported in *source* frames — that is the unit the SDK's pacing
 * arithmetic works in, since that is what the core produces.
 */
const WORKLET_SOURCE = `
class MgbaSink extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cap = 32768; // source frames
    this.buf = new Float32Array(this.cap * 2);
    this.pos = 0; // fractional read cursor, in source frames
    this.w = 0;   // source frames written
    this.ratio = 1;
    this.lastPost = 0;
    this.port.onmessage = (e) => {
      const msg = e.data;
      if (msg && msg.rate) {
        this.ratio = msg.rate / sampleRate;
        return;
      }
      const s = msg; // Int16Array, interleaved stereo
      const frames = s.length >> 1;
      for (let i = 0; i < frames; i++) {
        if (this.w - this.pos >= this.cap) break; // full: drop excess
        const idx = (this.w % this.cap) * 2;
        this.buf[idx] = s[i * 2] / 32768;
        this.buf[idx + 1] = s[i * 2 + 1] / 32768;
        this.w++;
      }
    };
  }
  process(inputs, outputs) {
    const out = outputs[0];
    const L = out[0];
    const R = out[1] || out[0];
    const n = L.length;
    for (let i = 0; i < n; i++) {
      // One source frame must be left past the cursor to interpolate against.
      if (this.pos + 1 < this.w) {
        const base = Math.floor(this.pos);
        const frac = this.pos - base;
        const a = (base % this.cap) * 2;
        const b = ((base + 1) % this.cap) * 2;
        L[i] = this.buf[a] + (this.buf[b] - this.buf[a]) * frac;
        R[i] = this.buf[a + 1] + (this.buf[b + 1] - this.buf[a + 1]) * frac;
        this.pos += this.ratio;
      } else {
        L[i] = 0;
        R[i] = 0;
      }
    }
    const consumed = Math.floor(this.pos);
    if (consumed - this.lastPost >= 1024) {
      this.port.postMessage(consumed);
      this.lastPost = consumed;
    }
    return true;
  }
}
registerProcessor('mgba-sink', MgbaSink);
`;
const scriptLoadCache = new Map();
function loadClassicScriptOnce(src) {
    const cached = scriptLoadCache.get(src);
    if (cached)
        return cached;
    const p = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`mgba: failed to load script: ${src}`));
        document.head.appendChild(script);
    });
    scriptLoadCache.set(src, p);
    return p;
}
function toUint8(x) {
    if (x == null)
        return null;
    if (typeof x === 'string')
        return new TextEncoder().encode(x);
    if (x instanceof Uint8Array)
        return x;
    if (x instanceof ArrayBuffer)
        return new Uint8Array(x);
    if (ArrayBuffer.isView(x))
        return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    throw new TypeError('mgba: asset must be Uint8Array | ArrayBuffer | string');
}
function resolveCanvas(config) {
    const canvasEl = config.canvasEl;
    if (canvasEl)
        return canvasEl;
    const attachTo = config.attachTo;
    if (attachTo) {
        const existing = attachTo.querySelector('canvas');
        if (existing)
            return existing;
        const created = document.createElement('canvas');
        attachTo.appendChild(created);
        return created;
    }
    throw new Error('mgba: config.canvasEl or config.attachTo is required');
}
async function opfsDir(namespace, create) {
    try {
        const root = await navigator.storage.getDirectory();
        const engineDir = await root.getDirectoryHandle('mgba', { create });
        return await engineDir.getDirectoryHandle(namespace, { create });
    }
    catch {
        return null;
    }
}
/** Copy bytes into the WASM heap; returns the pointer (caller frees). */
function heapAlloc(mod, bytes) {
    const ptr = mod._malloc(bytes.length);
    mod.HEAPU8.set(bytes, ptr);
    return ptr;
}
export async function load(config) {
    const { assets, onEvent } = config;
    const emit = (e) => {
        try {
            onEvent?.(e);
        }
        catch {
            // host callback must not break the engine runtime
        }
    };
    const rawRom = toUint8(assets?.rom ?? assets?.data);
    if (!rawRom) {
        throw new Error('mgba: no ROM provided — pass assets.rom (a .gba/.gb/.gbc cartridge image)');
    }
    // Cartridge dumps circulate zipped far more often than not, and this build
    // carries no libzip, so the archive is opened here instead.
    const { bytes: romBytes } = await extractRom(rawRom, ['.gba', '.gb', '.gbc', '.sgb']);
    const biosBytes = toUint8(assets?.bios);
    const namespace = config.storageNamespace ?? 'default';
    const settingsStore = createSettingsStore(namespace);
    const requested = (config.options ?? {});
    // This package's defaults, then the player's persisted menu tweaks, then
    // whatever the host asked for explicitly — a caller-supplied option is a
    // deliberate choice and outranks the last session.
    const opts = { ...DEFAULT_MGBA_OPTIONS };
    // The same object seen by key, which is what the live config writes through:
    // the loop reads `opts` every frame, so a menu change is picked up with no
    // further plumbing.
    const state = opts;
    const persisted = settingsStore.load();
    for (const option of MGBA_ENGINE_OPTIONS) {
        const stored = persisted[option.key];
        if (stored !== undefined)
            state[option.key] = stored;
        const asked = requested[option.key];
        if (asked === undefined)
            continue;
        const value = coerceOptionValue(option, asked);
        if (value !== undefined)
            state[option.key] = value;
    }
    if (typeof requested.escMenu === 'boolean')
        opts.escMenu = requested.escMenu;
    const canvas = resolveCanvas(config);
    canvas.style.imageRendering = opts.renderFilter === 'pixelated' ? 'pixelated' : 'auto';
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d)
        throw new Error('mgba: could not acquire a 2d canvas context');
    // ---------------------------------------------------------------- audio
    const audioCtx = new AudioContext();
    const workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
    await audioCtx.audioWorklet.addModule(workletUrl);
    URL.revokeObjectURL(workletUrl);
    const sink = new AudioWorkletNode(audioCtx, 'mgba-sink', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
    });
    const gain = audioCtx.createGain();
    gain.gain.value = Math.max(0, Math.min(1, opts.volume));
    sink.connect(gain).connect(audioCtx.destination);
    let enqueuedFrames = 0;
    let consumedFrames = 0;
    sink.port.onmessage = (e) => {
        consumedFrames = e.data;
    };
    // --------------------------------------------------------------- module
    const jsUrl = config.jsUrl ?? new URL('./mgba.js', import.meta.url).href;
    const wasmUrl = config.wasmUrl ?? new URL('./mgba.wasm', jsUrl).href;
    await loadClassicScriptOnce(jsUrl);
    const g = globalThis;
    if (typeof g.createMgbaModule !== 'function') {
        throw new Error('mgba: unable to initialize runtime module from mgba.js');
    }
    const mod = await g.createMgbaModule({
        locateFile(path) {
            if (path.endsWith('.wasm'))
                return wasmUrl;
            return new URL(path, jsUrl).href;
        },
    });
    // ----------------------------------------------------------------- boot
    mod._mgbawasm_init();
    mod._mgbawasm_set_log_level(MGBA_LOG_LEVEL_IDS[opts.logLevel]);
    /** Copies a string into the heap as NUL-terminated UTF-8 (caller frees). */
    const heapString = (value) => {
        const size = mod.lengthBytesUTF8(value) + 1;
        const ptr = mod._malloc(size);
        mod.stringToUTF8(value, ptr, size);
        return ptr;
    };
    /**
     * Boots the cartridge. Everything the core reads while mapping it — the
     * platform, the Game Boy model, the BIOS, `skipBios` — is settled here,
     * which is why the options that feed it are tagged "needs reset".
     */
    const bootCore = () => {
        const romPtr = heapAlloc(mod, romBytes);
        const biosPtr = biosBytes ? heapAlloc(mod, biosBytes) : 0;
        const gbModel = MGBA_GB_MODEL_VALUES[opts.gbModel];
        const gbModelPtr = gbModel ? heapString(gbModel) : 0;
        const ok = mod._mgbawasm_load(romPtr, romBytes.length, biosPtr, biosBytes?.length ?? 0, MGBA_PLATFORM_IDS[opts.system], gbModelPtr, opts.skipBios ? 1 : 0);
        mod._free(romPtr);
        if (biosPtr)
            mod._free(biosPtr);
        if (gbModelPtr)
            mod._free(gbModelPtr);
        if (!ok) {
            throw new Error('mgba: ROM load failed — is this a valid .gba/.gb/.gbc cartridge image?');
        }
    };
    bootCore();
    const platform = mod._mgbawasm_platform();
    const system = platform === PLATFORM_GB ? 'gb' : 'gba';
    // Without a BIOS image mGBA runs its high-level replacement, which has no
    // boot animation to play — so the option is not merely ignored, it is
    // meaningless, and the state is corrected rather than left lying.
    const hasBios = mod._mgbawasm_has_bios() === 1;
    if (!hasBios)
        opts.skipBios = true;
    /** Maps a fresh cartridge, then re-pushes everything that is not boot-time. */
    const rebootCore = () => {
        bootCore();
        applyLiveSettings();
        framerate = mod._mgbawasm_framerate_micro() / 1e6 || 60;
    };
    /** Re-pushes every option the core keeps in its own config. */
    const applyLiveSettings = () => {
        mod._mgbawasm_set_log_level(MGBA_LOG_LEVEL_IDS[opts.logLevel]);
        mod._mgbawasm_set_idle_optimization?.(IDLE_IDS[opts.idleOptimization] ?? 1);
        mod._mgbawasm_set_allow_opposing_directions?.(opts.allowOpposingDirections ? 1 : 0);
    };
    applyLiveSettings();
    let framerate = mod._mgbawasm_framerate_micro() / 1e6 || 60;
    /**
     * The rate the core is emitting at *now*, pushed to the worklet whenever it
     * moves. A GBA game raising the SOUNDBIAS resolution doubles it mid-play, so
     * this is re-read every tick rather than latched at boot.
     */
    let coreRate = 0;
    const syncCoreRate = () => {
        const rate = mod._mgbawasm_sample_rate();
        if (rate > 0 && rate !== coreRate) {
            coreRate = rate;
            sink.port.postMessage({ rate });
        }
        return coreRate;
    };
    syncCoreRate();
    // Scratch space the core drains audio into, sized for a comfortable multiple
    // of a frame's worth of stereo samples.
    const AUDIO_SCRATCH_FRAMES = 4096;
    const audioPtr = mod._malloc(AUDIO_SCRATCH_FRAMES * 2 * 2);
    // ---------------------------------------------------------- persistence
    const persistEnabled = false; // Strictly disabled to follow local folder saves via File System Access API
    const cloneSram = () => {
        const size = mod._mgbawasm_sram_save();
        if (!size)
            return null;
        const ptr = mod._mgbawasm_sram_ptr();
        if (!ptr)
            return null;
        // Copied out of the heap rather than sliced from it, so the bytes are not
        // sitting on the WASM memory that a growth could detach.
        const bytes = new Uint8Array(size);
        bytes.set(mod.HEAPU8.subarray(ptr, ptr + size));
        return bytes;
    };
    const restoreSram = async () => {};
    const persistSram = async () => {};
    // ---------------------------------------------------------------- input
    let keyMask = 0;
    let padMask = 0;
    let sentMask = -1;
    let codeToBit = new Map();
    const pushInput = () => {
        const mask = keyMask | padMask;
        if (mask !== sentMask) {
            sentMask = mask;
            mod._mgbawasm_set_keys(mask);
        }
    };
    const buildKeymap = (map) => {
        codeToBit = new Map();
        for (const [action, code] of Object.entries(map)) {
            const dot = action.indexOf('.');
            if (!code)
                continue;
            const control = dot < 0 ? action : action.slice(dot + 1);
            const bit = KEY_BITS[control];
            if (bit !== undefined) {
                if (Array.isArray(code)) {
                    for (const c of code) codeToBit.set(c, bit);
                } else {
                    codeToBit.set(code, bit);
                }
            }
        }
    };
    buildKeymap(DEFAULT_KEYMAP);
    const applyKey = (code, down) => {
        const bit = codeToBit.get(code);
        if (bit === undefined)
            return false;
        const flag = 1 << bit;
        keyMask = down ? keyMask | flag : keyMask & ~flag;
        pushInput();
        emit({ type: 'input', keyBit: bit, pressed: down, mask: keyMask });
        return true;
    };
    const isEmulatorFocused = () => {
        const el = document.activeElement;
        if (!el || el === document.body || el === canvas || canvas.contains(el)) return true;
        // Don't intercept if user is typing in a text input or textarea
        if (el.tagName === 'INPUT' && (el.type === 'text' || el.type === 'search')) return false;
        if (el.tagName === 'TEXTAREA') return false;
        return true;
    };
    const onKeyDown = (e) => {
        if (e.repeat)
            return;
        const handled = applyKey(e.code, true) || applyKey(e.key, true);
        if (handled && isEmulatorFocused())
            e.preventDefault();
    };
    const onKeyUp = (e) => {
        const handled = applyKey(e.code, false) || applyKey(e.key, false);
        if (handled && isEmulatorFocused())
            e.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    /** Gamepad polling (standard mapping). */
    const pollGamepads = () => {
        if (!opts.gamepads || !navigator.getGamepads)
            return;
        const pad = navigator.getGamepads()[0];
        let mask = 0;
        if (pad && pad.connected) {
            const btn = (i) => !!pad.buttons[i]?.pressed;
            const ax = (i) => pad.axes[i] ?? 0;
            if (btn(0))
                mask |= 1 << KEY_BITS.a;
            if (btn(1))
                mask |= 1 << KEY_BITS.b;
            if (btn(4))
                mask |= 1 << KEY_BITS.l;
            if (btn(5))
                mask |= 1 << KEY_BITS.r;
            if (btn(8))
                mask |= 1 << KEY_BITS.select;
            if (btn(9))
                mask |= 1 << KEY_BITS.start;
            if (btn(12) || ax(1) < -0.4)
                mask |= 1 << KEY_BITS.up;
            if (btn(13) || ax(1) > 0.4)
                mask |= 1 << KEY_BITS.down;
            if (btn(14) || ax(0) < -0.4)
                mask |= 1 << KEY_BITS.left;
            if (btn(15) || ax(0) > 0.4)
                mask |= 1 << KEY_BITS.right;
        }
        if (mask !== padMask) {
            padMask = mask;
            pushInput();
        }
    };
    // Browsers may refuse to start audio without a user gesture; retry on the
    // next interaction if the context comes up suspended.
    const resumeAudio = () => {
        if (audioCtx.state === 'suspended')
            void audioCtx.resume();
    };
    window.addEventListener('pointerdown', resumeAudio);
    window.addEventListener('keydown', resumeAudio);
    // --------------------------------------------------------------- render
    // Geometry is read from the core every frame: it is 240x160 on GBA, 160x144
    // on Game Boy, and 256x224 the moment a Super Game Boy border appears.
    let imageData = null;
    let lastW = 0;
    let lastH = 0;
    // Previous frame, kept only while interframe blending is on.
    let prevFrame = null;
    /**
     * Publishes the presentation ratio two ways.
     *
     * `aspect-ratio` shapes the element. `--mgba-aspect` is the same number in a
     * form arithmetic can use, so a stylesheet can size the canvas to fit its
     * container without knowing which core is running:
     *
     *     width: min(100%, calc(100% * var(--mgba-aspect)));
     *
     * Which is not a detail a host can hardcode here: it is 1.5 on GBA, 1.11 on
     * Game Boy, 1.14 once a Super Game Boy border appears, and 1.33 when the
     * player picks `aspect: '4:3'`.
     */
    const applyAspect = () => {
        if (!lastW)
            return;
        const fourThirds = opts.aspect === '4:3';
        canvas.style.aspectRatio = fourThirds ? '4 / 3' : `${lastW} / ${lastH}`;
        canvas.style.setProperty('--mgba-aspect', String(fourThirds ? 4 / 3 : lastW / lastH));
    };
    const renderFrame = () => {
        const w = mod._mgbawasm_video_width();
        const h = mod._mgbawasm_video_height();
        if (w <= 0 || h <= 0)
            return;
        if (w !== lastW || h !== lastH || !imageData) {
            canvas.width = w;
            canvas.height = h;
            imageData = ctx2d.createImageData(w, h);
            lastW = w;
            lastH = h;
            prevFrame = null;
            applyAspect();
        }
        const ptr = mod._mgbawasm_video_ptr();
        const src = mod.HEAPU8.subarray(ptr, ptr + w * h * 4);
        if (opts.interframeBlending) {
            // The unlit GBA/GB LCDs were slow enough that a sprite drawn every other
            // frame read as half-transparent. Averaging consecutive frames restores
            // that, and is what the effect is on every other frontend too.
            const dst = imageData.data;
            if (prevFrame && prevFrame.length === src.length) {
                for (let i = 0; i < src.length; i++) {
                    dst[i] = (src[i] + prevFrame[i]) >> 1;
                }
            }
            else {
                dst.set(src);
            }
            prevFrame = Uint8ClampedArray.from(src);
        }
        else {
            imageData.data.set(src);
            prevFrame = null;
        }
        ctx2d.putImageData(imageData, 0, 0);
    };
    // ------------------------------------------------------------ main loop
    // Audio-clocked pacing: keep ~90ms of audio queued ahead of the worklet's
    // consumption. While the AudioContext is suspended (no consumption), fall
    // back to wall-clock pacing so video still runs.
    //
    // Everything here counts in source frames, not output frames — the core's
    // rate is the one that fixes how much work a frame is, and the worklet
    // reports its consumption in the same unit for exactly that reason.
    const TARGET_SECONDS = 0.09;
    const MAX_FRAMES_PER_TICK = 5;
    let rafId = 0;
    let running = false;
    let paused = false;
    let wallClockFrames = 0;
    let wallClockStart = 0;
    let fpsCount = 0;
    let fpsWindowStart = 0;
    let persistTimer = null;
    // Audio-clocked pacing only works while the audio clock actually advances.
    // A context can report `running` and still never render a quantum when there
    // is no output device (headless browsers, VMs without a sound card), and
    // then the buffer deficit never reappears and the picture freezes for good.
    // Watch AudioContext.currentTime and treat a clock that has not moved for
    // half a second as stalled, so pacing falls back to the wall clock.
    const AUDIO_STALL_MS = 500;
    let audioClockTime = -1;
    let audioClockWall = 0;
    let audioStalled = false;
    const audioClockAdvancing = (now) => {
        const t = audioCtx.currentTime;
        if (t !== audioClockTime) {
            audioClockTime = t;
            audioClockWall = now;
            audioStalled = false;
        }
        else if (now - audioClockWall > AUDIO_STALL_MS) {
            audioStalled = true;
        }
        return !audioStalled;
    };
    const drainAudio = () => {
        // Short reads are the norm: the sample count a frame produces wobbles
        // around the nominal rate, so this drains whatever is actually there.
        for (;;) {
            const frames = mod._mgbawasm_read_audio(audioPtr, AUDIO_SCRATCH_FRAMES);
            if (frames <= 0)
                return;
            const start = audioPtr >> 1;
            const chunk = mod.HEAP16.slice(start, start + frames * 2);
            sink.port.postMessage(chunk, [chunk.buffer]);
            enqueuedFrames += frames;
            if (frames < AUDIO_SCRATCH_FRAMES)
                return;
        }
    };
    const runFrames = (count) => {
        for (let i = 0; i < count; i++) {
            mod._mgbawasm_run_frame();
            drainAudio();
            fpsCount++;
        }
    };
    const tick = (now) => {
        if (!running || paused)
            return;
        rafId = requestAnimationFrame(tick);
        pollGamepads();
        const rate = syncCoreRate();
        let frames = 0;
        if (audioCtx.state === 'running' && audioClockAdvancing(now)) {
            const buffered = enqueuedFrames - consumedFrames;
            const deficit = Math.round(rate * TARGET_SECONDS) - buffered;
            const perEmulatedFrame = rate / framerate;
            if (deficit > 0)
                frames = Math.ceil(deficit / perEmulatedFrame);
            wallClockStart = 0;
        }
        else {
            // Wall-clock fallback (audio blocked or stalled): accumulate at the core
            // framerate.
            if (!wallClockStart) {
                wallClockStart = now;
                wallClockFrames = 0;
            }
            const due = Math.floor(((now - wallClockStart) / 1000) * framerate);
            frames = due - wallClockFrames;
            wallClockFrames = due;
        }
        frames = Math.max(0, Math.min(MAX_FRAMES_PER_TICK, frames));
        if (frames > 0) {
            runFrames(frames);
            renderFrame();
        }
        if (!fpsWindowStart)
            fpsWindowStart = now;
        if (now - fpsWindowStart >= 1000) {
            emit({ type: 'frame', fps: (fpsCount * 1000) / (now - fpsWindowStart) });
            fpsWindowStart = now;
            fpsCount = 0;
        }
    };
    const startLoop = () => {
        if (rafId)
            cancelAnimationFrame(rafId);
        wallClockStart = 0;
        rafId = requestAnimationFrame(tick);
    };
    const setInput = (map) => {
        if (typeof map === 'string') {
            buildKeymap(DEFAULT_KEYMAP);
        }
        else {
            buildKeymap({ ...DEFAULT_KEYMAP, ...map });
        }
    };
    // -------------------------------------------------------- live settings
    // What the cartridge was actually mapped with. A change to any of these only
    // lands on the next boot, which is what reset() below does.
    let bootedSystem = opts.system;
    let bootedGbModel = opts.gbModel;
    let bootedSkipBios = opts.skipBios;
    /**
     * How each setting reaches the running emulator. A key left out here — or
     * dropped because the loaded wasm predates its shim setter — is reported as
     * unsupported and does not appear in the menu.
     */
    const appliers = {
        renderFilter: (value) => {
            canvas.style.imageRendering = value === 'pixelated' ? 'pixelated' : 'auto';
        },
        aspect: () => applyAspect(),
        interframeBlending: () => {
            prevFrame = null;
        },
        volume: (value) => {
            gain.gain.value = Math.max(0, Math.min(1, Number(value)));
        },
        gamepads: (value) => {
            // Whatever a pad was holding when polling stopped would otherwise stay
            // pressed forever.
            if (!value) {
                padMask = 0;
                pushInput();
            }
        },
        logLevel: (value) => mod._mgbawasm_set_log_level(MGBA_LOG_LEVEL_IDS[value]),
    };
    const setIdle = mod._mgbawasm_set_idle_optimization;
    if (setIdle) {
        appliers.idleOptimization = (value) => setIdle.call(mod, IDLE_IDS[String(value)] ?? 1);
    }
    const setOpposing = mod._mgbawasm_set_allow_opposing_directions;
    if (setOpposing) {
        appliers.allowOpposingDirections = (value) => setOpposing.call(mod, value ? 1 : 0);
    }
    // Recorded now, applied by reset().
    appliers.system = () => { };
    appliers.gbModel = () => { };
    // Without a real BIOS there is no intro to skip, so the option is dropped
    // from the menu entirely rather than offered as a lie.
    if (hasBios)
        appliers.skipBios = () => { };
    const engineConfig = bindConfig(state, appliers);
    // The ESC menu lives in the host's demo shell as of engine-specs 0.2.5, so
    // this package supplies the rows and applies the writes rather than drawing
    // anything itself. Persisting on every write keeps the two in step without
    // the shell having to know that persistence exists.
    const engineWrite = engineConfig.write;
    engineConfig.write = (key, value) => {
        const ok = engineWrite(key, value);
        if (ok)
            settingsStore.save(engineConfig.values());
        return ok;
    };
    const instance = {
        config: engineConfig,
        system,
        escMenuGroups() {
            return toEscMenuGroups(engineConfig.values());
        },
        start() {
            if (running)
                return;
            running = true;
            paused = false;
            resumeAudio();
            startLoop();
            if (persistEnabled) {
                persistTimer = setInterval(() => void persistSram(), 15000);
            }
            emit({ type: 'ready' });
        },
        pause() {
            if (!running || paused)
                return;
            paused = true;
            cancelAnimationFrame(rafId);
            rafId = 0;
            void audioCtx.suspend();
            void persistSram();
        },
        resume() {
            if (!running || !paused)
                return;
            paused = false;
            void audioCtx.resume();
            startLoop();
        },
        reset() {
            const needsReboot = opts.system !== bootedSystem ||
                opts.gbModel !== bootedGbModel ||
                opts.skipBios !== bootedSkipBios;
            if (!needsReboot) {
                mod._mgbawasm_reset();
                return;
            }
            // A reboot throws the cartridge away and maps a new one, so battery RAM
            // is carried across by hand — on hardware it would have survived the
            // power cycle.
            const sram = cloneSram();
            rebootCore();
            bootedSystem = opts.system;
            bootedGbModel = opts.gbModel;
            bootedSkipBios = opts.skipBios;
            if (sram) {
                const ptr = heapAlloc(mod, sram);
                mod._mgbawasm_sram_load(ptr, sram.length);
                mod._free(ptr);
            }
        },
        setInput,
        getSram() {
            return cloneSram();
        },
        loadSram(bytes) {
            if (!bytes || !bytes.length)
                return false;
            try {
                const ptr = heapAlloc(mod, bytes);
                const ok = mod._mgbawasm_sram_load(ptr, bytes.length);
                mod._free(ptr);
                return !!ok;
            } catch (err) {
                console.error('Failed to load SRAM:', err);
                return false;
            }
        },
        setKeyMask(mask) {
            keyMask = mask;
            pushInput();
        },
        setKey(keyBit, pressed) {
            const flag = 1 << keyBit;
            keyMask = pressed ? (keyMask | flag) : (keyMask & ~flag);
            pushInput();
            emit({ type: 'input', keyBit, pressed, mask: keyMask });
        },
        getKeyMask() {
            return keyMask;
        },
        setVolume(vol) {
            opts.volume = Math.max(0, Math.min(1, vol));
            gain.gain.value = opts.volume;
        },
        getVolume() {
            return opts.volume;
        },
        setMuted(muted) {
            gain.gain.value = muted ? 0 : Math.max(0, Math.min(1, opts.volume));
        },
        getRawModule() {
            return mod;
        },
        renderCurrentFrame() {
            renderFrame();
        },
        async saveState() {
            const size = mod._mgbawasm_state_size();
            if (!size)
                throw new Error('mgba: failed to save state');
            const ptr = mod._malloc(size);
            const ok = mod._mgbawasm_state_save(ptr);
            const bytes = ok ? mod.HEAPU8.slice(ptr, ptr + size) : null;
            mod._free(ptr);
            if (!bytes)
                throw new Error('mgba: failed to save state');
            return bytes;
        },
        async loadState(data) {
            const size = mod._mgbawasm_state_size();
            if (data.length !== size) {
                throw new Error(`mgba: savestate is ${data.length} bytes but this core expects ${size} — it belongs to a different game or a different build`);
            }
            const ptr = heapAlloc(mod, data);
            const ok = mod._mgbawasm_state_load(ptr);
            mod._free(ptr);
            if (!ok)
                throw new Error('mgba: failed to load state');
        },
        async screenshot() {
            renderFrame();
            return new Promise((resolve, reject) => {
                canvas.toBlob((blob) => {
                    if (blob)
                        resolve(blob);
                    else
                        reject(new Error('mgba: screenshot failed'));
                }, 'image/png');
            });
        },
        async purgeStorage() {
            let data = false;
            try {
                const root = await navigator.storage.getDirectory();
                const engineDir = await root.getDirectoryHandle('mgba');
                await engineDir.removeEntry(namespace, { recursive: true });
                data = true;
            }
            catch {
                // nothing persisted for this namespace
            }
            settingsStore.clear();
            return { data, settings: true };
        },
        destroy() {
            running = false;
            paused = false;
            if (rafId)
                cancelAnimationFrame(rafId);
            rafId = 0;
            if (persistTimer)
                clearInterval(persistTimer);
            persistTimer = null;
            void persistSram();
            window.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('keyup', onKeyUp);
            window.removeEventListener('pointerdown', resumeAudio);
            window.removeEventListener('keydown', resumeAudio);
            sink.disconnect();
            gain.disconnect();
            void audioCtx.close();
            mod._free(audioPtr);
            mod._mgbawasm_unload();
            emit({ type: 'exit' });
        },
    };
    return instance;
}
export default { manifest, load };
//# sourceMappingURL=mgba.sdk.js.map