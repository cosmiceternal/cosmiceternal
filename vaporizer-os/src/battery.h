#pragma once

#include <cstdint>

// Thin wrapper over a fuel-gauge IC (e.g. MAX17048). Kept separate from
// charge-controller status so either can be swapped without touching the
// state machine.
class Battery {
 public:
  void begin();
  void update(uint32_t now_ms);

  float percent() const { return percent_; }
  bool isLow() const;
  bool isCharging() const { return charging_; }

 private:
  float percent_ = 100.0f;
  bool charging_ = false;
  uint32_t last_poll_ms_ = 0;
};
