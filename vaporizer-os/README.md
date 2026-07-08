# VaporOS

A firmware "OS" for a DIY smart concentrate vaporizer in the Puffco Peak / Boost family:
induction- or resistive-ceramic heating, temperature-profile sessions, BLE app control,
battery/charge management, and layered safety cutoffs.

This is a firmware scaffold, not a finished consumer product — treat the safety
thresholds in `src/config.h` as placeholders that must be tuned and validated against
your actual heater, thermal mass, and enclosure before this touches a battery and a coil.

## Board recommendation: ESP32-S3

**Primary pick: ESP32-S3 (WROOM-1 module, or a dev board like Seeed XIAO ESP32-S3 /
Adafruit ESP32-S3 Feather).**

Why it fits this problem better than the alternatives:

- **BLE 5.0 + dual-core LX7 @ 240 MHz** — enough headroom to run a tight PID heater loop,
  a GATT server for the companion app, and a display driver without them stalling each other.
- **Hardware LEDC PWM** for the heater MOSFET gate and **12-bit ADC** for thermistor/thermocouple
  readback, both on the same chip — no second MCU needed for the analog control loop.
- **Native USB** — handy for DFU/firmware flashing through the same port used for charging.
- **Arduino + ESP-IDF + PlatformIO** support with a huge example base, which matters a lot for
  a solo/small-team hardware project where you don't want to be debugging toolchain issues
  instead of heater control.
- Cheap (~$3-6 in module form) and available on breakout dev boards for prototyping before
  you design a custom PCB.

**Alternative: Nordic nRF52840** if you drop WiFi entirely and want best-in-class BLE power
efficiency for longer standby life on a small battery. It's a better radio-per-milliamp, but
you'll spend more time hand-rolling the analog control loop and app plumbing that ESP32-S3
gets from its ecosystem. Good second-revision option once the control logic is proven.

**Skip:** plain ESP32 (classic) — no meaningful advantage over the S3 here and worse
power/analog story; Raspberry Pi Pico W — no BLE (only WiFi on the Pico W's radio), wrong
tool for a battery-powered handheld.

## System architecture

```
                     ┌─────────────────────────┐
                     │        VaporOS           │
                     │  (ESP32-S3, Arduino/IDF)  │
                     └─────────────────────────┘
   Sensors                 Core                        Actuators / IO
 ┌───────────┐      ┌───────────────────┐          ┌──────────────────┐
 │ Thermistor/│─ADC─▶│ TempSensor         │          │ Heater MOSFET     │
 │ thermocouple│      │                   │─PWM(LEDC)▶│ (ceramic coil)    │
 └───────────┘      │ Safety Monitor      │          └──────────────────┘
 ┌───────────┐      │  (watchdog, cutoffs)│          ┌──────────────────┐
 │ Fuel gauge │─I2C─▶│                   │─I2C──────▶│ OLED display      │
 │ (MAX17048) │      │ Session/State      │          └──────────────────┘
 └───────────┘      │  Machine           │          ┌──────────────────┐
 ┌───────────┐      │                   │─GPIO─────▶│ Haptic motor       │
 │ Button/    │─GPIO▶│ BLE GATT Service   │          └──────────────────┘
 │ touch input│      └───────────────────┘
 └───────────┘                │
                       BLE ───▶ Companion app (set temp/profile,
                                telemetry, OTA trigger)
```

### Layers (see `src/`)

| Module | Responsibility |
|---|---|
| `state_machine` | Central coordinator + session lifecycle: `IDLE → HEATING → READY → ACTIVE_SESSION → COOLDOWN`, plus `FAULT`. Owns the control-critical subsystems. |
| `temp_sensor` | Reads + filters (EMA) the temperature sensor, converts ADC counts → °F |
| `heater_control` | PID loop + rapid-heat dash driving the heater PWM toward the active target temp |
| `session_profiles` | Preset + concentrate + custom (NVS) heat profiles, incl. guided ramps |
| `safety` | Independent watchdog: over-temp, thermal-runaway, session timeout, stale sensor, under-voltage, over-current, enclosure over-temp, no-load — cuts heater power regardless of the control loop |
| `battery` | Fuel gauge (SoC) + charger status, low-battery warning, under-charge lockout |
| `atomizer` | Coil-resistance measurement → presence + type auto-detect |
| `draw_sensor` | Inhale detection for hit counting and auto-draw sessions |
| `stats` | NVS-persisted usage: session history, hit counter/limit, cleaning reminder |
| `device_mode` | Normal / Stealth / Party modes + child-lock |
| `input` | Debounced multi-tap / hold gesture decoder |
| `haptics` | Non-blocking haptic feedback patterns |
| `led_ring` | Signature RGB status ring (heating fill, ready breathe, fault flash) |
| `ble_service` | GATT service: session control, settings, live telemetry, OTA |
| `ota` | Safe-gated firmware update (flash write/verify/reboot) |
| `display` | Thin status-render layer (OLED), decoupled from control logic |

Safety is intentionally **not** part of the PID/control path — `safety.cpp` runs as an
independent check every loop tick and can cut heater power even if `heater_control` or BLE
gets into a bad state. Don't collapse that separation when extending this.

See **[FEATURES.md](FEATURES.md)** for the full Tier 1–3 feature list, per-feature
implementation status, the button gesture map, and the BLE command protocol.

## Suggested bill of materials (beyond the MCU)

- **Heater sense**: type-K thermocouple + MAX31855 breakout (ceramic dishes run past NTC-safe
  ranges, ~450-600°C) — swap in a simple NTC divider only if your design caps well under 300°C.
- **Heater drive**: logic-level N-MOSFET (e.g. IRLZ44N for through-hole prototyping) or a
  gate-driver + power MOSFET pair for a compact PCB, flyback/snubber per your coil's inductance.
- **Charge/power path**: TI BQ25895 (I2C-configurable USB-C power path + charger).
- **Fuel gauge**: MAX17048 (I2C, tiny, good enough SoC estimation for a single-cell Li-ion/LiPo).
- **Display**: SSD1306 128x32/64 OLED (I2C) — cheap, low power, plenty of Arduino driver support.
- **Haptics**: small ERM motor + a N-channel MOSFET or motor driver, one GPIO.

## Status

Firmware in `src/` is a structural scaffold covering Tier 1–3 features (see
[FEATURES.md](FEATURES.md)): control logic and module interfaces are implemented, while the
actual sensor reads / IC register access are clearly-marked hooks. It is organized so each
hardware subsystem is swappable. The gesture decoder (`input.cpp`) has a native unit test;
the rest has **not** been flashed or run against real hardware in this session — there's no
ESP32 toolchain or hardware here to validate against. Before powering a real coil: bench-test
`safety.cpp`'s cutoffs in isolation (trip every `FaultReason`), verify your
thermocouple/thermistor calibration against a known reference, and confirm PWM frequency
doesn't create audible whine or excessive MOSFET switching loss for your coil's inductance.

## Build

```
cd vaporizer-os
pio run                # build
pio run -t upload      # flash over USB
pio device monitor      # serial log
```

Requires [PlatformIO](https://platformio.org/) (`pip install platformio` or the VS Code
extension). Target board in `platformio.ini` is `esp32-s3-devkitc-1` — change to match
whatever ESP32-S3 dev board you're prototyping on.
