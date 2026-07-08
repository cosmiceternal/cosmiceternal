#pragma once

#include <cstdint>

enum class ChargeState : uint8_t {
  kDischarging,
  kCharging,
  kCharged,
  kFault,   // charger IC reported a fault (over-temp, timer, bad cell)
};

// Wrapper over a fuel-gauge IC (e.g. MAX17048) plus charger-IC (BQ25895)
// status. Kept separate from the safety watchdog: this reports state and
// makes policy decisions (lockout, sleep-ok); safety.cpp does the hard cutoff.
class Battery {
 public:
  void begin();
  void update(uint32_t now_ms);

  float percent() const { return percent_; }
  float volts() const { return volts_; }
  ChargeState chargeState() const { return charge_state_; }
  bool isCharging() const { return charge_state_ == ChargeState::kCharging; }

  bool isLow() const;
  // Too depleted to safely start a heating session. Distinct from isLow(),
  // which is just a warning.
  bool isLockedOut() const;

 private:
  float percent_ = 100.0f;
  float volts_ = 4.1f;
  ChargeState charge_state_ = ChargeState::kDischarging;
  uint32_t last_poll_ms_ = 0;
};
