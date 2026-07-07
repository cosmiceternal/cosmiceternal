#include "battery.h"

#include <Arduino.h>

#include "config.h"

namespace {
constexpr uint32_t kPollIntervalMs = 2000;
}  // namespace

void Battery::begin() {
  // MAX17048 I2C init hook — Wire.begin(SDA, SCL) is called once centrally
  // in main.cpp since the bus is shared with the OLED.
}

void Battery::update(uint32_t now_ms) {
  if (now_ms - last_poll_ms_ < kPollIntervalMs) {
    return;
  }
  last_poll_ms_ = now_ms;

  // Placeholder for the real MAX17048 register read (0x04 SOC register).
  // Left as a hook so the rest of the system has a stable interface
  // regardless of which fuel gauge ends up on the final PCB.
}

bool Battery::isLow() const { return percent_ <= cfg::BATTERY_LOW_PCT; }
