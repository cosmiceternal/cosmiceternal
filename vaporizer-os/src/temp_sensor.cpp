#include "temp_sensor.h"

#include <Arduino.h>

#include "config.h"

namespace {
constexpr float kEmaAlpha = 0.25f;
constexpr uint32_t kHardwareReadIntervalMs = 20;
}  // namespace

void TempSensor::begin() {
  // MAX31855 (or thermistor ADC) hardware init goes here — SPI/ADC setup.
  // Left as a hook so this file compiles standalone against any sensor choice.
  last_success_ms_ = millis();
}

float TempSensor::readRawF() {
  // Placeholder for the real SPI transaction to a MAX31855, or an
  // analogRead() + Steinhart-Hart conversion for an NTC divider.
  // Returning the current filtered value keeps update() well-behaved
  // until real sensor code is wired in.
  return filtered_f_;
}

void TempSensor::update(uint32_t now_ms) {
  if (now_ms - last_read_ms_ < kHardwareReadIntervalMs) {
    return;
  }
  float dt_s = (now_ms - last_read_ms_) / 1000.0f;
  last_read_ms_ = now_ms;

  float raw = readRawF();
  last_success_ms_ = now_ms;

  prev_filtered_f_ = filtered_f_;
  filtered_f_ = kEmaAlpha * raw + (1.0f - kEmaAlpha) * filtered_f_;

  if (dt_s > 0.0f) {
    rate_f_per_s_ = (filtered_f_ - prev_filtered_f_) / dt_s;
  }
}

bool TempSensor::isStale(uint32_t now_ms) const {
  return (now_ms - last_success_ms_) > cfg::SAFETY_SENSOR_STALE_MS;
}
