# PokéAdvance — Web GBA Emulator

A browser-based Game Boy Advance emulator built on the [mGBA](https://mgba-emu.org)
core, compiled to WebAssembly. The whole thing is static files: no backend, no
database, no accounts, and **nothing to install or build**.

Saves are real `.sav` and `.state` files in a folder you choose on your own
disk, so they survive clearing browser data and are readable by other
emulators.

```
node server.js      # then open http://localhost:3000/
```

Full setup and controls: **[HOW_TO_RUN.md](HOW_TO_RUN.md)**.

---

## Table of contents

- [How the web app works](#how-the-web-app-works)
  - [The big picture](#the-big-picture)
  - [What runs where](#what-runs-where)
  - [The frame loop, and why it is driven by audio](#the-frame-loop-and-why-it-is-driven-by-audio)
  - [Reaching the emulated RAM](#reaching-the-emulated-ram)
  - [Saves and states](#saves-and-states)
  - [Why there is no build step](#why-there-is-no-build-step)
  - [Project layout](#project-layout)
- [Cheats: tutorial](#cheats-tutorial)
  - [Adding a code](#adding-a-code)
  - [The formats it understands](#the-formats-it-understands)
  - [Reading the leading digit](#reading-the-leading-digit)
  - [Conditionals](#conditionals)
  - [Why codes go stale, and how to find a working address](#why-codes-go-stale-and-how-to-find-a-working-address)
  - [What does not work](#what-does-not-work)
  - [Cheat troubleshooting](#cheat-troubleshooting)
- [Other tutorials](#other-tutorials)
  - [Saves: the folder, the formats, and manual transfer](#saves-the-folder-the-formats-and-manual-transfer)
  - [Save states](#save-states)
  - [Speed control](#speed-control)
  - [Fullscreen and scaling](#fullscreen-and-scaling)
  - [Controls](#controls)
  - [Running on a different port or network](#running-on-a-different-port-or-network)
- [Troubleshooting](#troubleshooting)
- [Credits and licence](#credits-and-licence)

---

# How the web app works

## The big picture

There is no server doing emulation. The emulator is a WebAssembly build of
mGBA running inside your browser tab, and the Node script in `server.js` does
only one job: hand out the files with correct MIME types.

```
browser tab
├── app.js ................ UI wiring, cheat panel, address finder
├── saves.js .............. real .sav / .state files via File System Access API
├── input.js .............. keyboard + gamepad -> GBA key bits
├── core/gba-core.js ...... the API the rest of the app talks to
├── core/cheats.js ........ GameShark / CodeBreaker / raw code parsing
└── core/mgba.* ........... mGBA's own WebAssembly SDK + mgba.wasm
```

`server.js` exists because browsers refuse to load WebAssembly and ES modules
from `file://`. Any static file server works; the bundled one just saves you
installing one. It binds to `127.0.0.1` only, so it is not reachable from your
network.

## What runs where

| Concern | Where it happens |
|---|---|
| GBA CPU, PPU, audio, timing | `core/mgba.wasm` — mGBA compiled to WebAssembly |
| Canvas presentation | 2D canvas, `putImageData` per frame |
| Audio output | `AudioWorklet` ("mgba-sink") fed by an `AudioBufferSourceNode` chain |
| Input | `keydown`/`keyup` plus the Gamepad API |
| Saves | `showDirectoryPicker()` — real files on your disk |
| Cheats | JS writing directly into the WASM heap (see below) |

There is no emulation in JavaScript and no DOM per frame; the only
per-frame work is one WebAssembly call, one image blit and some audio
buffering.

## The frame loop, and why it is driven by audio

`requestAnimationFrame` is the wrong clock for an emulator. A browser can and
does stall a tab — background it, lose focus, or simply not schedule a frame —
and running emulation to match the display would make the game stutter, and
its audio would crackle to match.

So mGBA's SDK paces emulation against the **audio clock** instead. Each
animation frame the SDK compares how many audio samples the output device has
consumed against how many it has produced, and runs exactly enough emulated
frames to make up the difference, targeting a ~90 ms buffer:

```js
const TARGET_SECONDS = 0.09;
const deficit = Math.round(rate * TARGET_SECONDS) - buffered;
for (let i = 0; i < deficit; i++) runFrame();
```

This is why the emulator keeps correct speed even when the display drops
frames, and why pausing is exact rather than approximate.

**Consequence worth knowing:** if the audio output cannot start — typically
because the browser blocks autoplay until you interact with the page — the
clock never advances and the game will appear frozen at 0 FPS. Click anywhere
on the page once and it will start.

## Reaching the emulated RAM

This is the least obvious part of the project, and the reason cheat codes were
originally broken here.

mGBA allocates the GBA's work RAM as ordinary blocks in its own heap:

| Region | GBA address | Size |
|---|---|---|
| EWRAM | `0x02000000`–`0x0203FFFF` (mirrored to `0x02FFFFFF`) | 256 KB |
| IWRAM | `0x03000000`–`0x03007FFF` (mirrored to `0x03FFFFFF`) | 32 KB |

Those addresses **move every time a ROM is loaded**, and this build of mGBA
exports no accessor to read or write GBA RAM. So the cheat engine recovers
them at runtime, using mGBA's own save state as the map:

1. `_mgbawasm_state_size()` reports the size, and `_mgbawasm_state_save()`
   serialises the whole machine into a buffer we allocate.
2. mGBA's GBA state **ends with byte-exact copies of IWRAM and EWRAM**. For
   this build, EWRAM is the last `0x40000` bytes of the blob and IWRAM the
   `0x8000` before it — so their offsets are derived from the size, not
   guessed.
3. Those copies are matched back into the live heap to recover the real
   addresses, cross-checked at several independent offsets.
4. The result is then **proven**: a marker is written at the candidate address
   and mGBA is asked to serialise itself again. If the marker shows up in the
   RAM section, that address really is that bank.

Step 4 matters. Content matching alone is not enough, because the save-state
buffer we just filled is *itself* a copy of the blob and matches perfectly.
A write there is never reflected back into the RAM section, which is exactly
what the marker test distinguishes.

Once located, the banks are written directly through `HEAPU8` just before each
emulated frame — the same buffer the ARM7 CPU reads and writes through its
bus, so a write there is a write as far as the game is concerned. Nothing is
copied, proxied or synchronised.

> **Why `HEAPU8` only:** Emscripten does not publish the wider typed-array
> views consistently. This build exposes `HEAPU8`, `HEAP16` and `HEAPU32` but
> **not** `HEAPU16` or `HEAP32`, so the cheat engine writes byte by byte
> rather than assuming a view exists.

## Saves and states

`persist` is explicitly disabled in the SDK: the emulator keeps no hidden
state. Everything you care about is a real file, handled by `saves.js` through
the **File System Access API**:

| File | Contents |
|---|---|
| `<rom>.sav` | Battery / SRAM — your actual game save |
| `<rom>.state1` … `.state3` | Full emulator snapshots (quick-state slots) |

Naming is derived from the ROM filename, so a folder of `.gba` files and a
folder of matching `.sav` files just work together.

Battery saves are written automatically every 5 seconds, but only when the
SRAM contents have actually changed (compared with an FNV-1a hash), and again
on `pagehide` so closing the tab mid-game does not lose progress.

Because these are ordinary files, you can drop a `.sav` from another emulator
into the same folder and the game will pick it up on load. There are also
manual **Import/Export** buttons for browsers without the File System Access
API.

## Why there is no build step

`package.json` has **no dependencies** and there is nothing to compile. The
emulator core ships as a prebuilt `core/mgba.wasm`, and everything else is
plain ES modules loaded directly by the browser. `npm install` does nothing
useful, and there is no bundler, transpiler or framework in the pipeline.

The practical consequences:

- `index.html` must be served over `http://`, not opened from disk.
- `core/mgba.js` is a UMD bundle that installs `createMgbaModule` on `globalThis`;
  the SDK loads it as a classic script because it cannot be imported.
- `style.css` is hand-written plain CSS with custom properties.

## Project layout

| File | Lines | Role |
|---|---|---|
| `app.js` | 822 | UI wiring: chassis, cheat panel, address finder, toasts |
| `core/gba-core.js` | 932 | The public API — load, run, save, cheats, RAM discovery |
| `core/cheats.js` | 475 | GameShark / CodeBreaker ciphers, type tables, code parsing |
| `saves.js` | 202 | File System Access API: folder, `.sav`, `.state` |
| `input.js` | 146 | Keyboard and gamepad mapping to GBA keys |
| `server.js` | 56 | Static file server with correct MIME types |
| `index.html` / `style.css` | 442 / 1308 | Markup and styling |
| `core/mgba.*` | — | mGBA SDK (vendored, unmodified) |
| `core/mgba.wasm` | — | The emulator core, ~800 KB prebuilt |

---

# Cheats: tutorial

The cheat engine finds the game's RAM (see
[Reaching the emulated RAM](#reaching-the-emulated-ram)) and re-applies your
codes at the start of every emulated frame. That per-frame re-application is
what makes a "freeze" code hold even though the game keeps writing to the same
address.

## Adding a code

1. Click the **Cheats** pill in the header.
2. Type a name, e.g. `Infinite HP`.
3. Paste your codes — **one code per line**, whole lists are fine.
4. Click **Add Cheat**.

Each entry then shows how your code was *decoded*, not the raw text:

```
Infinite HP  ->  GameShark (encrypted): 16-bit write 02001234 = 64 (+1 more)
```

Hover an entry to see every decoded code in the list. If it says
`address outside GBA RAM`, the code points at ROM or video memory and will
never apply — the app tells you rather than pretending.

Tick the checkbox to enable, ✕ to remove, **Clear All** to wipe the list.
Disabling a cheat restores the value that was there before it was applied.

## The formats it understands

Paste codes exactly as you found them. The format is detected **per list**,
because a single code is too short to tell a ciphertext from a plaintext — a
wrong guess reads as plausible about 4% of the time, so each candidate format
is tried against every line and the one that explains the most lines wins.

| Format | Example |
|---|---|
| GameShark (raw) | `02001234 00000064` |
| GameShark (encrypted) | `7B674DE5 6586601C` |
| CodeBreaker (raw) | `82001234 0064` |
| CodeBreaker (encrypted) | a list whose first line starts with `9` |
| Plain address/value | `02001234 0064` |

Encrypted GameShark codes are TEA-32 with the stock device seeds.
Encrypted CodeBreaker codes are seeded by the `9…` line at the top of the
list. Both ciphers and all type tables are ported from mGBA's own GBA cheat
engine, which is the reference implementation.

## Reading the leading digit

In every 8-digit address, **the first hex digit is a code type, not part of
the address.** The real address is the remaining 28 bits, so
`82001234` is a write to `0x02001234`.

| Leading digit | Meaning |
|---|---|
| `0xxxxxxx` | GameShark 8-bit write |
| `1xxxxxxx` | GameShark 16-bit write |
| `2xxxxxxx` | GameShark 32-bit write |
| `3xxxxxxx` | CodeBreaker 8-bit write |
| `8xxxxxxx` | CodeBreaker 16-bit write |
| `6xxxxxxx` | 16-bit bitwise AND |
| `7xxxxxxx` | If equal — gates the next line |
| `Axxxxxxx` | If not equal — gates the next line |
| `Dxxxxxxx` | GameShark if-equal — gates the next line |
| `E0xxxxxx` | GameShark multi-line if-equal |

A 7-digit token is a bare address with the type implied, and 6 or fewer is
treated as an offset into IWRAM.

**Forcing a width:** add a third token, e.g. `02001234 0064 8` writes one
byte instead of two.

## Conditionals

A conditional is a test followed by the write it controls. The gated write
only happens when the test passes, re-evaluated every frame:

```
72001234 0064      ; if EWRAM[0x1234] == 0x64 ...
82001236 ABCD      ; ... then write 0xABCD to EWRAM[0x1236]
```

This is what lets one cheat track a *condition* — for example, only refill
your HP when the game is not mid-animation, or only overwrite a value once a
flag is set — rather than fighting the game every frame.

## Why codes go stale, and how to find a working address

Homebrew games like **Pokémon Unbound** get rebuilt often, and a game's
variables move between revisions. A code copied from a list can therefore
point at an address that no longer holds anything. A good sign of this is a
code whose decoded address is not in the `02xxxxxx`/`03xxxxxx` ranges at all.

When a list does not work, find the address yourself. Expand **"Can't find a
working code? Search the game's RAM"** in the cheat panel:

1. Type the value the game is currently showing — your money, say — and click
   **Search**.
2. Change that value in the game, type the new value, and **Search** again.
3. Repeat until exactly one address is left.
4. Enter the value you want and click **Create freeze code**.

Narrowing works because a real counter *changes when you change it*, whereas
the same number sitting coincidentally in hundreds of unrelated cells does
not. Two or three rounds normally isolates it.

The **Bytes** setting must match how the game stores the value; money is
often a 32-bit field. A search that returns nothing usually just needs a
different width.

If the code is created but the value does not stick, the game keeps a second
copy (a display copy and a logic copy). Search again after a purchase and try
the other address.

## What does not work

These need the cheat device's own ARM code handler patched into the game's
execution, which an emulator cannot install. They are skipped and reported,
not silently applied:

- Master and enable codes, and the code handler hook itself
- ROM patches and cheat-button writes
- Slide / fill codes
- Anything outside EWRAM and IWRAM — ROM, VRAM, OAM, I/O registers

Multi-line master-code scripts therefore usually contribute nothing; the
individual freeze codes in the list still work.

## Cheat troubleshooting

| Symptom | Cause |
|---|---|
| Toast: "Could not locate the emulated EWRAM" | Enabled a cheat before the game had run. Start the game, let it play a moment, re-enable. |
| Toast: "…targets EWRAM (02xxxxxx) or IWRAM (03xxxxxx)…" | The code list contains no RAM writes — usually only master codes, or codes for a different game. |
| Entry says `address outside GBA RAM` | The decoded address is ROM or video memory. This code cannot work. |
| Entry says `unsupported: ROM patch` / `code handler hook` / `slide code` | A device code type that needs the code handler. Ignored by design. |
| Entry decodes correctly but nothing happens | Wrong address for this ROM revision, or the game keeps a second copy. Use the address finder. |
| Value flickers instead of holding | Two writes target the same cell in one list. Remove the redundant line. |
| Value reverts immediately | The game rewrites that cell every frame *and* reads it before our patch lands. Try a neighbouring address. |
| Wrong byte width | Try the other Bytes setting in the finder, or add a third token to the code. |

---

# Other tutorials

## Saves: the folder, the formats, and manual transfer

**Set up automatic saving.** Click **Choose Save Folder** and pick a folder;
grant write permission. From then on the emulator writes
`<romfilename>.sav` there automatically whenever the game's save data changes,
and the header shows `Auto-saved at HH:MM:SS`.

The folder is remembered between sessions, so this is a one-time step.

**Share a save between emulators.** Because these are plain files, just copy
the `.sav` into the folder the other emulator uses, with the same base name as
the ROM.

**No File System Access API?** Firefox and Safari do not have
`showDirectoryPicker`, so the save folder is unavailable there. The emulator
still runs; use **Export .SAV File** and **Import .SAV File** instead, and
keep the file yourself.

**What is the difference between `.sav` and `.state`?** A `.sav` is the game's
own data, which any emulator can read. A `.state` is a full snapshot of the
emulated machine taken by *this* emulator — it includes the exact CPU and
video state mid-frame, and is only loadable by this app.

## Save states

Pick slot **1**, **2** or **3**, then **Save State** / **Load State**. Slots
live in your save folder as `<romfilename>.state1`–`.state3`, so they survive
a cache clear and can be backed up.

Use these for:

- **Grinding** — save before a battle you might lose, reload if it goes wrong.
- **Testing cheats** — load a state, add a code, and see the effect without
  replaying.
- **Boss attempts** — rewind and retry.

States are per-ROM, so switching games switches slots.

## Speed control

The header speed selector offers 0.25× to 4×. It works by changing how many
frames the emulator runs per output tick, not by slowing the audio clock, so
fast-forward is genuinely faster rather than dropping audio.

Cheat codes are applied before *every* emulated frame regardless of the speed
setting, so a frozen value holds at 4× as well as at 0.25×.

## Fullscreen and scaling

Click the fullscreen button to make the screen fill the window. The canvas
scales with `image-rendering: pixelated` so GBA pixels stay square instead of
being blurred by the browser.

The on-screen **L** and **R** pills are the shoulder buttons, and double as
their keyboard hints (`Q` and `E`).

## Controls

| Action | Keyboard |
|---|---|
| D-Pad | `W` `A` `S` `D` or arrow keys |
| A | `J` |
| B | `K` |
| L shoulder | `Q` |
| R shoulder | `E` |
| Select | `C` |
| Start | `V` |

A connected gamepad is picked up automatically. `Esc` deliberately does
nothing, so the emulator's own menu cannot interrupt play.

## Running on a different port or network

```bash
node server.js 8080        # then http://localhost:8080/
```

`server.js` always binds to `127.0.0.1`, so it is only reachable from the
same machine. To load it from a phone or another computer on your LAN you
would need to change the host in `server.js` to `0.0.0.0` and be aware that
you are then serving a network-accessible web server.

---

# Troubleshooting

| Problem | Fix |
|---|---|
| Blank page, or "could not acquire a 2d canvas context" | You opened `index.html` directly. Use `http://localhost:3000/`. |
| `EADDRINUSE` | Something already uses port 3000. Use `node server.js 8080`. |
| `node` is not recognised | Install Node.js, then reopen the terminal. |
| Game frozen at 0 FPS, no sound | The browser blocked audio until you interacted. Click the page once. |
| Save folder button does nothing | Not a Chromium browser. Use Import/Export. |
| ROM will not load | Must be a real `.gba` (or a `.zip` containing one). Header integrity is checked on load. |
| Cheats report they cannot find memory | Enable them after the game has been running for a moment. |
| Everything is very slow | Try 0.5×; also close other heavy tabs — the emulator is sensitive to CPU contention. |

---

# Credits and licence

- Emulation core: [mGBA](https://mgba-emu.org) by Jeffrey Pfau and
  contributors, compiled to WebAssembly. mGBA is distributed under MPL-2.0.
- `core/mgba.*` are vendored from mGBA's published WebAssembly SDK and are
  unmodified.
- GameShark and CodeBreaker cipher and type handling in `core/cheats.js` is
  ported from mGBA's GBA cheat engine (`src/gba/cheats/`).
- Cheat code format documentation references the
  [EnHacklopedia GBA hacking guide](https://doc.kodewerx.org/hacking_gba.html).

You are responsible for having the right to the ROMs you load.
