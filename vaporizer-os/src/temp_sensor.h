#pragma once

#include <cstdint>

// Wraps whatever physical sensor is on the board (thermocouple amp today,
// thermistor divider if you swap hardware) behind a single filtered reading.
class TempSensor {
 public:
  void begin();

  // Call every loop tick. Internally rate-limits actual hardware reads and
  // applies an EMA filter so the control loop sees a smooth signal.
  void update(uint32_t now_ms);

  float temperatureF() const { return filtered_f_; }
  float rawRateFPerSec() const { return rate_f_per_s_; }

  // True if the last successful hardware read is older than the configured
  // staleness threshold — used by safety.cpp to fault out on a dead sensor
  // instead of silently controlling off a frozen value.
  bool isStale(uint32_t now_ms) const;

 private:
  float readRawF();

  float filtered_f_ = 70.0f;   // start at ambient, not zero
  float prev_filtered_f_ = 70.0f;
  float rate_f_per_s_ = 0.0f;
  uint32_t last_read_ms_ = 0;
  uint32_t last_success_ms_ = 0;
};
