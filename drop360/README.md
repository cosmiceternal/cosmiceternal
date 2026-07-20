# Drop360

A drag-and-drop **Xbox 360 emulator app**: drop a game file anywhere in the window and it lands in your library — then click **Play**.

![status](https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-blue) ![core](https://img.shields.io/badge/core-Xenia-green)

## How it works (honest version)

No one can write an Xbox 360 CPU/GPU emulator from scratch in an afternoon — the only working one is [Xenia](https://xenia.jp), an open-source project that has been in development for over a decade. Drop360 is the friendly shell around it:

- **Drop360 (this app)** — the library, drag-and-drop, settings, and launch UI.
- **Xenia (the core)** — the actual Xbox 360 emulation. Drop360 downloads it for you on first run with one click; you never have to touch it directly.

> **Why not Xbox One?** There is no usable Xbox One emulator anywhere — the console's security has never been broken in a way that makes emulation possible. Xbox 360 emulation via Xenia is mature and plays hundreds of titles, so that's what this targets.

## Requirements

- **Windows 10/11, 64-bit** (Xenia is Windows-only)
- A GPU with **Vulkan or Direct3D 12** support (most GPUs from ~2016 onward)
- [Node.js LTS](https://nodejs.org) installed (to run the app from source)

## Quick start

```bash
cd drop360
npm install
npm start
```

1. On first launch, click **Install emulator core** — Drop360 downloads the latest Xenia Canary build (~15 MB) and sets it up automatically.
2. **Drag a game file anywhere into the window** (or click *Add games*).
3. Click **▶ Play**. The first boot of a game can take a minute while Xenia caches shaders.

### Building a standalone .exe

```bash
npm run dist
```

This produces a portable `Drop360.exe` in `dist/` — no Node.js needed to run it.

## Supported game formats

| Format | Notes |
| --- | --- |
| `.iso` | Xbox 360 disc images |
| `.xex` | Xbox 360 executables (or drop an extracted game **folder** — Drop360 finds the `default.xex` inside) |
| GoD / STFS containers | Games-on-Demand / XBLA packages — these usually have **no file extension**; that's fine, drop them in |
| `.zar`, `.elf`, `.xexp` | Also accepted |

Games must be **your own dumps** of discs/content you own. Drop360 does not and will not download games.

## Settings (⚙)

- **Core variant** — Xenia *Canary* (recommended, best compatibility) or upstream *master*.
- **Fullscreen** — launch games directly in fullscreen.
- **Locate core manually** — point at your own `xenia.exe` if you already have one, or at a wrapper script.
- **Re-download core** — grab the latest Xenia build any time.

## Where things live

Everything Drop360 stores is in your per-user app-data folder (`%APPDATA%/drop360` on Windows):

```
library.json    your game list (paths only — games are never copied or moved)
settings.json   app settings
xenia/          the downloaded emulator core (kept portable — config stays in this folder)
```

## Troubleshooting

- **A game won't boot / crashes** — check the [Xenia compatibility list](https://github.com/xenia-canary/game-compatibility/issues); not every title works. Try switching core variant in Settings.
- **"Core not installed" after download** — your antivirus may have quarantined `xenia_canary.exe`; add an exclusion for the app-data `xenia/` folder.
- **Slow performance** — Xenia leans hard on single-core CPU speed and needs a real GPU; integrated graphics will struggle.
