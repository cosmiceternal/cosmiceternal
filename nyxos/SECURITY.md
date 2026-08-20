# NyxOS security model

NyxOS is a **web/PWA phone OS**. It enforces a real, testable security model in
the browser, and is honest about the limits of that environment. This document
describes the threat model, what is enforced, and what fundamentally requires a
hardware ROM.

## What NyxOS defends against (in the browser)

**Data at rest / lost or stolen device (locked).**
- The entire profile is stored as **AES‑256‑GCM ciphertext**. The key is derived
  from the user's PIN or passphrase with **PBKDF2‑SHA256 (600,000 iterations)**.
- With the device locked and no secret known, the stored bytes are unreadable.
- **Brute‑force throttling:** failed unlocks are counted in the (plaintext)
  profile metadata and enforced *before* the vault is decrypted. After 5 failures
  an escalating lockout applies (30s → 1m → 2m … capped at 30m).
- **Auto‑wipe (optional):** after a configurable number of failed unlocks, the
  device wipes all data.
- **Duress secret:** a separate secret that, when entered, wipes everything.
- **Passphrase mode:** an alphanumeric secret dramatically raises the cost of an
  offline attack on the vault versus a 4–6 digit PIN. This is the single most
  important hardening a user can enable, surfaced in **Settings → Security →
  Security checkup**.

**Malicious or curious apps.**
- Apps receive only a capability object (`sys`) scoped to their own id. There is
  no ambient access to the network, sensors, location, camera, microphone, the
  clipboard, or other apps' storage.
- **Per‑app permissions** gate every sensitive capability; a revoked permission
  genuinely blocks access (e.g. `sys.net.fetch` throws), it doesn't just hide UI.
- **Storage Scopes** are enforced: an app can only read its own namespace.
- App network requests are sent with **`credentials: 'omit'`** and
  **`Referrer-Policy: no-referrer`**.

**Shoulder‑surfing / smudge / lock‑screen leakage.**
- Optional **scrambled PIN layout**; **masked** secret entry.
- **Sensitive notifications** are content‑hidden on the lock screen.
- Lock‑screen restrictions for **USB**, **camera**, and **quick tiles**.
- **Clipboard auto‑clear** removes copied secrets after a timeout, and any
  cross‑app clipboard read raises a notification.

**Code integrity / XSS.**
- **Boot integrity check:** on every boot, core files are hashed and compared to
  a signed manifest (`integrity.json`). A mismatch blocks with a warning — a
  browser‑scoped analog of verified boot.
- **Content‑Security‑Policy** (meta + server headers): `script-src 'self'`, no
  `eval`, no inline scripts, `object-src 'none'`, `frame-ancestors 'none'`.
- User‑controlled strings (e.g. profile names) are rendered via `textContent`,
  never interpolated into `innerHTML`.

## What NyxOS cannot do (needs a hardware ROM)

A browser has no hardware root of trust, so these are represented honestly in
**Settings → Security features** as "Needs ROM", never faked:

- Hardened memory allocator (`hardened_malloc`).
- Kernel mitigations (ASLR, stack canaries, a hardened kernel).
- Signed firmware and hardware‑rooted **verified boot** / attested OTA.
- A **secure element** for hardware‑throttled key derivation and PIN attempts.
- Hardware‑backed **Advanced Protection**, FIDO2, and a real Sandboxed Play.

### Honest limits of the browser controls

- Attempt counters and settings live in `localStorage`, which is readable and
  resettable by anyone with local device/browser access. On real hardware these
  live behind a secure element. The throttling/auto‑wipe here raises the bar for
  a casual attacker, but is not equivalent to hardware‑enforced throttling.
- A short PIN's vault can still be brute‑forced offline given the ciphertext; the
  KDF cost and (better) a passphrase are the mitigations.
- After first unlock (AFU), the key stays in memory so the lock screen can show
  notifications — exactly like a real phone. JavaScript cannot guarantee secure
  erasure of memory.

## Reporting

This is a hobby/learning project, not a product. If you find an issue, open an
issue or PR. Please don't rely on NyxOS to protect against a determined,
resourceful adversary — for that, flash a real hardened OS onto a supported
device (see the README).
