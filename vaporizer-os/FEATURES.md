# VaporOS — Feature List & Roadmap

Three tiers, from "won't work without it" to "premium differentiators." The
**Module** column points at where each feature lives in `src/`. **Status**:
🟢 implemented in firmware logic · 🟡 scaffolded (interface + logic, hardware
read/write stubbed) · ⚪ planned.

> Reminder: every temperature/current/voltage threshold in `config.h` is a
> placeholder. Bench-validate the safety cutoffs against your real heater,
> thermal mass, and enclosure before this touches a battery and a coil.

## Tier 1 — Core

### Heating & control
| Feature | Module | Status |
|---|---|---|
| Preset temp profiles (Flavor / Standard / Boost) | `session_profiles` | 🟢 |
| Closed-loop PID heating to target | `heater_control` | 🟢 |
| Rapid-heat dash + controlled PID handoff (no overshoot) | `heater_control` | 🟢 |
| Auto heat-up → ready → timed hold → auto-cooldown lifecycle | `state_machine` | 🟢 |
| Boost gesture (hold button = start on hottest preset) | `main` + `input` | 🟢 |

### Safety (independent watchdog, cannot be bypassed by control/BLE)
| Feature | Module | Status |
|---|---|---|
| Absolute over-temp cutoff | `safety` | 🟢 |
| Thermal-runaway (rate-of-rise) detection | `safety` | 🟢 |
| Max session-duration timeout | `safety` | 🟢 |
| Stale / dead-sensor fault | `safety` | 🟢 |
| Battery under-voltage (over-discharge) cutoff | `safety` | 🟢 |
| Heater over-current (short / bad coil) trip | `safety` | 🟡 (needs current-sense ADC) |
| Enclosure / body over-temp cutoff | `safety` | 🟡 (needs body NTC) |
| No-load detection (energized with no atomizer) | `safety` + `atomizer` | 🟢 |

### Power
| Feature | Module | Status |
|---|---|---|
| Battery state-of-charge readout | `battery` | 🟡 (needs MAX17048) |
| USB-C charge management + charge state | `battery` | 🟡 (needs BQ25895) |
| Low-battery warning | `battery` | 🟢 |
| Under-charge session lockout | `battery` + `state_machine` | 🟢 |
| Idle deep-sleep, wake-on-button | `main` | 🟢 |

## Tier 2 — Smart features

### Companion app (BLE)
| Feature | Module | Status |
|---|---|---|
| Start/stop/profile-select over BLE | `ble_service` | 🟢 |
| Live telemetry (temp, target, battery, mode, atomizer, hits) | `ble_service` | 🟢 |
| Custom user profiles (create/name/save, NVS-persisted) | `session_profiles` + `ble_service` | 🟢 |
| Firmware OTA update (safe-gated to idle+heater-off) | `ota` + `ble_service` | 🟡 (transport wired, verify on hardware) |
| Session history & last-session stats | `stats` | 🟢 |
| Dosing / hit counter with optional daily limit | `stats` + `state_machine` | 🟢 |

### On-device UX
| Feature | Module | Status |
|---|---|---|
| OLED status display (state, temps, battery, alerts) | `display` | 🟡 (needs SSD1306) |
| Non-blocking haptic feedback (tick/ready/fault/draw) | `haptics` | 🟢 |
| RGB LED status ring (heating fill, ready breathe, fault flash) | `led_ring` | 🟡 (needs WS2812) |
| Multi-tap + hold button gestures | `input` | 🟢 (native-tested) |

## Tier 3 — Premium / differentiators
| Feature | Module | Status |
|---|---|---|
| Atomizer auto-detect via coil resistance → auto profile | `atomizer` | 🟡 (needs sense divider) |
| Guided sessions (temp ramps across the hold/draw) | `session_profiles` + `state_machine` | 🟢 |
| Draw detection (inhale sensor) → hit count + auto-session | `draw_sensor` + `state_machine` | 🟡 (needs pressure sensor) |
| Party / Stealth modes (LED brightness + haptic muting) | `device_mode` | 🟢 |
| Child-lock / anti-pocket-fire (triple-tap or app) | `device_mode` + `main` | 🟢 |
| Concentrate-specific presets (Rosin / Shatter / Badder) | `session_profiles` | 🟢 |
| Cleaning reminder by session count | `stats` | 🟢 |
| Ambient/altitude PID compensation | `heater_control` | ⚪ planned |

## Button gesture map (single action button)

| Gesture | Idle | Heating/Ready/Session | Fault | Locked |
|---|---|---|---|---|
| Single tap | Start (auto profile) | Stop | Acknowledge | — |
| Double tap | Cycle mode (Normal→Stealth→Party) | — | — | — |
| Triple tap | Toggle child-lock | Toggle child-lock | — | **Unlock** |
| Hold | Start on Boost preset | — | — | — |

While locked, only triple-tap (unlock) is honored; everything else buzzes a
fault cue.

## BLE command protocol (write to command characteristic)

| Opcode | Meaning | Args |
|---|---|---|
| `0x01` | Start session | `[1]` = profile slot |
| `0x02` | Stop | — |
| `0x03` | Acknowledge fault | — |
| `0x04` | Set device mode | `[1]` = mode |
| `0x05` | Set lock | `[1]` = 0/1 |
| `0x06` | Set daily hit limit | `[1..2]` = uint16 |
| `0x07` | Reset cleaning counter | — |
| `0x08` | Set day index (for daily limit rollover) | `[1..4]` = uint32 |
| `0x09` | Save custom profile | `[1]` = slot, `[2..]` = profile bytes |

OTA uses a separate characteristic (`0xA1` start / `0xA2` chunk / `0xA3`
finish / `0xA4` abort).

## What's left before hardware bring-up

The 🟡 items share one shape: the firmware logic and interfaces are done, but
the actual sensor reads / IC writes are stubbed as clearly-marked hooks
(`readOhms()`, `readFlow()`, MAX17048/BQ25895 register access, etc.). Bring-up
order that de-risks fastest:

1. **Sensor calibration** — thermocouple, enclosure NTC, atomizer divider.
2. **Safety in isolation** — trip every `FaultReason` on the bench before the
   PID ever runs a real coil.
3. **Heater loop** — tune PID + rapid-heat handoff for your coil's thermal mass.
4. **Power path** — MAX17048 SoC + BQ25895 charge/fault reporting.
5. **UX** — OLED, LED ring, haptics, then the BLE app.
