#include "battery.h"

#include <Arduino.h>

#include "config.h"

namespace {
constexpr uint32_t kPollIntervalMs = 2000;
}  // namespace

void Battery::begin() {
  // MAX17048 fuel gauge + BQ25895 charger I2C init hook. Wire.begin() is
  // called once centrally in main.cpp since the bus is shared with the OLED.
}

void Battery::update(uint32_t now_ms) {
  if (now_ms - last_poll_ms_ < kPollIntervalMs) {
    return;
  }
  last_poll_ms_ = now_ms;

  // Placeholder for the real reads:
  //   percent_ = max17048_read_soc();
  //   volts_   = max17048_read_vcell();
  //   charge_state_ = bq25895_read_status();
  // Left as hooks so the rest of the system has a stable interface regardless
  // of which fuel gauge / charger ends up on the final PCB.
}

bool Battery::isLow() const { return percent_ <= cfg::BATTERY_LOW_PCT; }

bool Battery::isLockedOut() const {
  return percent_ <= cfg::BATTERY_LOCKOUT_PCT &&
         charge_state_ != ChargeState::kCharging;
}
