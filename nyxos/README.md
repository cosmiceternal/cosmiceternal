# NyxOS

A **privacy-first phone OS**, built as an installable Progressive Web App. It runs
**entirely on your device**, works **offline**, ships **zero dependencies**, and sends
**no telemetry** anywhere. Add it to your Android home screen and it behaves like a
phone OS — lock screen, home screen, app drawer, notification shade, settings, and a
set of built-in apps — all wrapped around a real, enforced privacy model.

> NyxOS is inspired by GrapheneOS in spirit. It is **not** a bootable ROM and is not
> affiliated with GrapheneOS or Google. See [What's real vs. represented](#whats-real-vs-represented).

---

## Run it

Requires Node 18+ (only for the tiny static dev server — there is no build step).

```bash
cd nyxos
npm start          # serves http://localhost:8080
```

Open the URL in a browser. On first launch you set a PIN, which **encrypts the
profile**.

### Put it on your phone (non-Apple)

1. Host the `nyxos/` folder over HTTPS (any static host: GitHub Pages, a VPS, `npm start`
   behind a tunnel, etc.). A service worker + PWA install needs a secure context.
2. Open the URL in Chrome/Firefox on your Android phone.
3. **Menu → Install app / Add to Home screen.** It installs as a standalone app with
   its own icon and launches full-screen, offline-capable.

---

## Features

### Security
- **PIN-derived encryption at rest** — the whole profile is AES-256-GCM ciphertext; the
  key is derived from your PIN with PBKDF2-SHA256 (210k iterations). Without the PIN the
  stored bytes are unreadable.
- **Duress PIN** — a secret second PIN that, when entered at the lock screen, **wipes the
  entire device**.
- **Lock-screen restrictions** — block USB data, camera, and quick tiles while locked.
- **Auto-lock** with configurable timeout; **masked password entry**.
- **Boot integrity verification** — core files are checked against a signed manifest
  (`integrity.json`) on every boot; a web-scoped analog of verified boot.

### Privacy controls
- **Capability-based app sandbox** — apps only get a `sys` object scoped to themselves.
  They physically cannot touch the network, sensors, location, camera, mic, or another
  app's data unless you grant it.
- **Per-app network toggle** — revoke an app's internet access; the quick-settings Wi-Fi
  / Airplane switches gate it too.
- **Sensors permission** + a global sensors kill-switch.
- **Storage Scopes** — every app is confined to its own encrypted namespace (enforced,
  cannot be disabled).
- **Clipboard access alerts** — you're notified when an app reads the clipboard.
- **Sensitive notifications hidden** on the lock screen; keyboard suggestions off by
  default.
- **Per-profile traffic routing** — Direct / VPN / Tor selector.

### De-Googled
- No Google apps or services by default.
- Optional **Sandboxed Google Play**, **Aurora-style** anonymous installs, push /
  billing / Play Games / FIDO2 — surfaced honestly (see below).

### Usability
- **Multiple user profiles** with strong isolation — separate encrypted storage, apps,
  permissions, and routing per profile.
- Notification shade with **quick-settings tiles**, home-screen **widgets**, app drawer
  with search, recents/task switcher.
- **Dark / light / system** themes, accent colors, wallpapers, brightness.
- Works fully **offline**. Free & open source (MIT).

### Built-in apps
Privacy (permission manager), Settings, Clock (clock/stopwatch/timer), Calculator,
Notes, Files, Weather, Browser, Camera, App Store — plus optional add-ons (Compass,
Recorder) you install from the store.

---

## What's real vs. represented

NyxOS runs in a browser, so it is honest about the line between what it **enforces** and
what genuinely needs a hardware ROM. The **Settings → Security features** screen labels
every item live.

| Enforced here | Requires a hardware ROM |
| --- | --- |
| App sandboxing (capability-scoped) | Hardened memory allocator (`hardened_malloc`) |
| Per-app permissions, network, storage scopes | Kernel mitigations (ASLR, stack canaries) |
| AES-256-GCM encryption at rest | Signed firmware, hardware-rooted verified boot |
| Duress PIN, lock-screen restrictions | Advanced Protection Program (hardware-backed) |
| Clipboard alerts, hidden notifications | Sandboxed Play / FIDO2 as real subsystems |
| Boot integrity vs. signed manifest (partial verified-boot analog) | |

A real bootable OS like GrapheneOS forks AOSP and compiles a signed image for a specific
Pixel. That can't be produced by a web app — NyxOS delivers the **userland experience and
a genuinely enforced privacy model** instead, and says so plainly.

---

## Architecture

```
nyxos/
  index.html            shell skeleton
  manifest.webmanifest  PWA manifest
  sw.js                 offline service worker
  integrity.json        signed hash manifest (regen: npm run integrity)
  css/                  reset, theme tokens, shell, apps
  js/
    core/               crypto, store, state, security, permissions,
                        notifications, registry, integrity, bridge, util, icons
    shell/              lockscreen, home, drawer, shade, statusbar, navbar,
                        appframe, recents, shell controller, ui, kit, theme
    apps/               settings, privacy, clock, calculator, notes, files,
                        weather, browser, camera, appstore, compass, recorder
  tools/                dev server, icon generator, integrity generator
```

- **No frameworks, no dependencies** — vanilla ES modules. Fits the privacy goal (nothing
  third-party runs) and needs no build.
- **The permission engine** (`js/core/permissions.js`) is the heart: `makeSys(appId)`
  builds the only interface an app gets, and every capability is gated there.
- **State** (`js/core/state.js`) holds the decrypted vault in memory and re-encrypts it on
  every change.

### Regenerating the integrity manifest

Any time you change a source file, refresh the signed baseline:

```bash
npm run integrity
```

Otherwise boot integrity will (correctly) report a mismatch.

---

## License

MIT — free and open source. See [LICENSE](./LICENSE).
