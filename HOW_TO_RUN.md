# How to Open the Website

A step-by-step guide to running the PokéAdvance GBA emulator locally.

---

## 1. Check your prerequisites

You only need two things:

| Requirement | Notes |
|---|---|
| **Node.js 18 or newer** | Check with `node --version` |
| **A Chromium-based browser** | Chrome or Edge — required for save folders (see step 5) |

There is **nothing to install**. The project has zero dependencies, so skip
`npm install` entirely. There is also no build step — the emulator core is a
prebuilt `.wasm` file that is already in `core/`.

Verify Node is available:

```bash
node --version
```

If that command is not recognised, install Node.js from <https://nodejs.org>
and restart your terminal.

---

## 2. Open a terminal in the project folder

From the terminal:

```bash
cd GBA_Emulator
```

(On Windows PowerShell: `cd C:\Users\<you>\Desktop\GBA_Emulator`)

You should see `package.json`, `server.js` and `index.html` in the current
directory.

---

## 3. Start the local server

Pick **one** of these — they all do the same thing:

```bash
npm start
```

```bash
node server.js
```

```bash
node server.js 3000     # pick a different port
```

Wait for this line, which means the server is ready:

```
PokéAdvance GBA Emulator server running at: http://localhost:3000/
```

Leave this terminal window open. Closing it shuts the server down.

---

## 4. Open the website

In your browser, go to:

```
http://localhost:3000/
```

You should see the **PokéAdvance** header, the emulator screen, and the
controls.

> **Important:** use `http://localhost:3000` — not the `index.html` file
> directly. The emulator loads its WebAssembly core with JavaScript modules,
> which browsers refuse to run from `file://`.

---

## 5. Load a ROM

1. Click **Choose ROM File**, or drag a `.gba` / `.zip` file straight onto the
   screen. Dropping a `.zip` works directly.
2. The header should update to show the **game title**, **game code** and
   **ROM size**, confirming the file loaded.

### Set up saves (recommended)

1. Click **Choose Save Folder** and pick (or create) a folder for `.sav` files.
2. Grant permission when the browser asks.

Saves are stored as real files in that folder, so they survive clearing browser
data. This step uses the File System Access API, which is **Chromium-only** —
in Firefox or Safari the emulator still runs, but save folders are unavailable
and you'll use Export/Import instead.

---

## 6. Controls

Keyboard (hard-mapped):

| Action | Keys |
|---|---|
| D-Pad | `W` `A` `S` `D` or Arrow keys |
| **A** button | `J` |
| **B** button | `K` |
| **L** shoulder | `Q` |
| **R** shoulder | `E` |
| **Select** | `C` |
| **Start** | `V` |

A gamepad also works if one is connected, and the on-screen buttons respond to
touch. `Esc` deliberately does nothing, so the emulator's own menu cannot
interrupt play.

---

## 7. Using cheat codes

1. Click the **Cheats** pill in the header to open the Cheat Code Manager.
2. Type a name (e.g. `Infinite HP`), paste your codes, then click **Add Cheat**.

### Formats accepted

Paste a whole code list, one code per line. The format is detected
automatically, so you can paste codes exactly as you found them:

| Format | Example | Notes |
|---|---|---|
| **GameShark (raw)** | `02001234 00000064` | Leading digit is the code type |
| **GameShark (encrypted)** | `7B674DE5 6586601C` | Decrypted for you |
| **CodeBreaker (raw)** | `82001234 0064` | Leading digit is the code type |
| **CodeBreaker (encrypted)** | needs a `9...` seed line | Decrypted for you |
| **Plain** | `02001234 0064` | Write size taken from the value width |

The **leading digit of an 8-digit address is a cheat-device code type, not part
of the address**:

| Leading digit | Meaning |
|---|---|
| `0xxxxxxx` | GameShark 8-bit write |
| `1xxxxxxx` | GameShark 16-bit write |
| `2xxxxxxx` | GameShark 32-bit write |
| `3xxxxxxx` | CodeBreaker 8-bit write |
| `8xxxxxxx` | CodeBreaker 16-bit write |
| `6xxxxxxx` | 16-bit bitwise AND (4-digit value) |
| `7xxxxxxx` / `Axxxxxxx` | If equal / if not equal — gates the next line |
| `Dxxxxxxx` | GameShark if-equal (gates the next line) |

Want to force a write size? Add a third token, e.g. `02001234 0064 8` for an
8-bit write.

### Finding an address yourself

Homebrew games like **Pokémon Unbound** get rebuilt often, and a game's
variables move between revisions — so a code from an old list can point at an
address that no longer holds anything. If a code does nothing, the built-in
finder will locate the real address:

1. Open the Cheat Code Manager and expand **"Can't find a working code? Search
   the game's RAM"**.
2. Type the value the game is currently showing (your money, say) and click
   **Search**.
3. Change that value in the game, type the new value, and **Search** again.
4. Repeat until exactly one address is left.
5. Enter the value you want and click **Create freeze code**.

Narrowing works because a real counter changes when you change it, while
chances are the same number in hundreds of unrelated cells that will not.
Usually two or three rounds is enough.

The **Bytes** setting must match how the game stores the value — a money
counter is often 4 bytes. If a search returns nothing, try the other widths; a
16-bit search for a 32-bit value only matches its low half, and vice versa.

If the code is created but the value does not stick, the game usually keeps a
second copy — take the neighbouring address (or the one found on the next
search) and try that.

### What works and what does not

- **Works:** any write to EWRAM (`02xxxxxx`) or IWRAM (`03xxxxxx`), in 8, 16 or
  32-bit widths, plus `if equal` / `if not equal` conditionals and 16-bit AND.
- **Ignored:** master/enable code lines, ROM patches, cheat-button writes,
  slide/fill codes, and code handler hooks. These need the cheat device's own
  ARM code handler hooked into the game, which an emulator cannot install, so
  the app tells you when it skips them rather than pretending to apply them.
- **Ignored:** addresses outside EWRAM/IWRAM (ROM, VRAM, OAM, I/O registers).

Cheats are re-applied at the start of every emulated frame, which is what makes
"freeze" codes hold even though the game keeps writing to the address. A
conditional is re-evaluated every frame too, so a gated write switches on and
off as the value changes.

Each entry in the list shows how it was decoded — for example
`GameShark (encrypted): 16-bit write 02001234 = 64` — so you can confirm your
codes were understood. Hover a preview to see every decoded code in the list.

> The first time you enable a cheat the emulator briefly locates its emulated
> RAM (~100 ms, one-off). If you enable a cheat before a game has run even a
> moment it will say so, and will pick up the memory as soon as the game starts.

---

## 8. Saving and states

| Button | What it does |
|---|---|
| **Export .SAV File** | Writes the battery save to a file you choose |
| **Import .SAV File** | Loads a battery save from disk |
| **Export State File** | Writes a full emulator snapshot to a file you choose |
| **Import State File** | Loads an emulator snapshot from disk |
| **Slot 1 / 2 / 3** | Picks which of the three quick-state slots to use |
| **Save State** | Saves a snapshot into the selected slot, inside your save folder |
| **Load State** | Restores the selected slot |
| **Reset** | Restarts the running game |

Quick states need the save folder from step 5 (so they use the File System
Access API). If you have not set one up, use **Export/Import State File**
instead, which works in any browser.

---

## Troubleshooting

**`EADDRINUSE` / port already in use**
Another program is on port 3000. Use another one and open that instead:
`node server.js 8080` → <http://localhost:8080/>

**Blank page, or "could not acquire a 2d canvas context"**
You almost certainly opened `index.html` from the file system. Go through
`http://localhost:3000/` instead.

**`node` is not recognised**
Install Node.js, then close and reopen the terminal.

**Cheats report they cannot find the game's memory**
Enable the cheat after the game has been running for a moment, so the emulator
has RAM to locate. A toast will also appear if discovery fails.

**No sound**
Browsers block audio until you interact with the page. Click anywhere on the
page, then try again. Check the speaker icon in the header is not muted.

**Game runs too fast or too slow**
Use the `1×` speed selector in the header (0.25× to 4×).

**"Direct disk saves via File System Access" is unavailable**
You're not in Chrome or Edge. The emulator works; use Export/Import .SAV
instead of a save folder.

---

## Summary

```bash
cd GBA_Emulator
node server.js
```

Then open <http://localhost:3000/> and load a `.gba` file. That's it.
