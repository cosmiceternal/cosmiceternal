#pragma once

#include <cstdint>

namespace cfg {

// ---- Pin map (adjust to your PCB / dev board) ----
constexpr int PIN_HEATER_PWM   = 5;   // LEDC channel -> heater MOSFET gate
constexpr int PIN_THERMO_CS    = 6;   // MAX31855 chip-select (SPI)
constexpr int PIN_BUTTON       = 7;   // single action button, active-low
constexpr int PIN_HAPTIC       = 8;
constexpr int PIN_I2C_SDA      = 9;   // shared by fuel gauge + OLED
constexpr int PIN_I2C_SCL      = 10;
constexpr int PIN_LED_RING     = 11;  // WS2812 / NeoPixel data
constexpr int PIN_HEATER_ISENSE = 1;  // ADC: current-sense amp on heater rail
constexpr int PIN_ENCLOSURE_NTC = 2;  // ADC: body/enclosure ambient thermistor
constexpr int PIN_ATOMIZER_SENSE = 3; // ADC: divider to measure coil resistance
constexpr int PIN_DRAW_SENSE   = 4;   // ADC: pressure/flow sensor for inhale detect

// ---- LED ring ----
constexpr int LED_RING_COUNT   = 16;

// ---- PWM ----
constexpr int PWM_FREQ_HZ      = 20000; // above audible range
constexpr int PWM_RESOLUTION_BITS = 10;  // duty range 0-1023
constexpr int PWM_CHANNEL      = 0;

// ---- Safety limits (PLACEHOLDERS — validate against your hardware) ----
constexpr float SAFETY_MAX_TEMP_F        = 950.0f;  // hard cutoff, regardless of profile
constexpr float SAFETY_MAX_RATE_F_PER_S  = 40.0f;   // thermal-runaway trigger
constexpr uint32_t SAFETY_MAX_SESSION_MS = 45000;   // force cooldown after this long heating
constexpr uint32_t SAFETY_SENSOR_STALE_MS = 500;    // no fresh reading in this long -> fault

// Battery pack under-voltage: below this the cell is being over-discharged.
// Single-cell Li-ion; scale for your pack. Hard cutoff, not just a warning.
constexpr float SAFETY_MIN_PACK_VOLTS    = 3.0f;

// Heater over-current: a dead short or a coil that fell apart draws far more
// than a healthy element. Trip fast to protect the MOSFET and battery.
constexpr float SAFETY_MAX_HEATER_AMPS   = 12.0f;

// Enclosure/body over-temp: the outside of the device should never get here.
constexpr float SAFETY_MAX_ENCLOSURE_F   = 140.0f;

// ---- Atomizer / no-load detection ----
// Healthy coil resistance window (ohms). Outside this = no atomizer attached,
// wrong atomizer, or a fault. Used both for no-load safety and auto-detect.
constexpr float ATOMIZER_MIN_OHMS = 0.3f;
constexpr float ATOMIZER_MAX_OHMS = 3.0f;

// ---- Control loop ----
constexpr uint32_t CONTROL_LOOP_MS = 50; // 20 Hz PID tick
constexpr float PID_KP = 8.0f;
constexpr float PID_KI = 0.6f;
constexpr float PID_KD = 4.0f;

// Rapid-heat: run heater near full power until within this band of target,
// then hand off to the PID for a controlled approach (avoids big overshoot).
constexpr float RAPID_HEAT_HANDOFF_F = 60.0f;
constexpr float RAPID_HEAT_DUTY = 0.95f;

// ---- Battery ----
constexpr float BATTERY_LOW_PCT = 10.0f;
constexpr float BATTERY_LOCKOUT_PCT = 3.0f;   // refuse to start a session below this
constexpr uint32_t IDLE_SLEEP_TIMEOUT_MS = 120000; // deep-sleep after this idle

// ---- Input gestures ----
constexpr uint32_t GESTURE_MULTI_TAP_WINDOW_MS = 400;  // gap that still counts as multi-tap
constexpr uint32_t GESTURE_HOLD_MS = 800;              // press >= this = hold
constexpr uint32_t GESTURE_DEBOUNCE_MS = 25;

// ---- Usage / maintenance ----
constexpr uint32_t CLEANING_REMINDER_SESSIONS = 30;   // remind after N sessions
constexpr uint16_t DEFAULT_DAILY_HIT_LIMIT = 0;       // 0 = disabled

}  // namespace cfg
