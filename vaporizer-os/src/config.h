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

// ---- PWM ----
constexpr int PWM_FREQ_HZ      = 20000; // above audible range
constexpr int PWM_RESOLUTION_BITS = 10;  // duty range 0-1023
constexpr int PWM_CHANNEL      = 0;

// ---- Safety limits (PLACEHOLDERS — validate against your hardware) ----
constexpr float SAFETY_MAX_TEMP_F        = 950.0f;  // hard cutoff, regardless of profile
constexpr float SAFETY_MAX_RATE_F_PER_S  = 40.0f;   // thermal-runaway trigger
constexpr uint32_t SAFETY_MAX_SESSION_MS = 45000;   // force cooldown after this long heating
constexpr uint32_t SAFETY_SENSOR_STALE_MS = 500;    // no fresh reading in this long -> fault

// ---- Control loop ----
constexpr uint32_t CONTROL_LOOP_MS = 50; // 20 Hz PID tick
constexpr float PID_KP = 8.0f;
constexpr float PID_KI = 0.6f;
constexpr float PID_KD = 4.0f;

// ---- Battery ----
constexpr float BATTERY_LOW_PCT = 10.0f;

}  // namespace cfg
