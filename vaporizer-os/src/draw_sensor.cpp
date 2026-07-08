#include "draw_sensor.h"

#include <Arduino.h>

#include "config.h"

namespace {
constexpr uint32_t kReadIntervalMs = 20;
// Flow above baseline by this much = an active draw. Units are sensor-specific
// (raw ADC delta here); calibrate to your pressure sensor.
constexpr float kDrawThreshold = 40.0f;
constexpr float kBaselineAlpha = 0.02f;  // slow-track ambient to reject drift
}  // namespace

void DrawSensor::begin() {
  // ADC setup hook for the pressure/flow sensor. baseline_ self-calibrates.
}

float DrawSensor::readFlow() {
  // Placeholder for analogRead(cfg::PIN_DRAW_SENSE). Returning baseline keeps
  // this quiescent (no false draws) until real sensor code is wired in.
  return baseline_;
}

void DrawSensor::update(uint32_t now_ms) {
  draw_started_ = false;
  draw_ended_ = false;
  if (now_ms - last_read_ms_ < kReadIntervalMs) {
    return;
  }
  last_read_ms_ = now_ms;

  float flow = readFlow();
  bool now_drawing = (flow - baseline_) > kDrawThreshold;

  // Only track baseline while NOT drawing, so a long hit doesn't get absorbed
  // into the baseline and cut itself off.
  if (!now_drawing) {
    baseline_ += kBaselineAlpha * (flow - baseline_);
  }

  if (now_drawing && !drawing_) {
    draw_started_ = true;
  } else if (!now_drawing && drawing_) {
    draw_ended_ = true;
  }
  drawing_ = now_drawing;
}
