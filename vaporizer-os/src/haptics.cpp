#include "haptics.h"

#include <Arduino.h>

#include "config.h"

namespace {
// Each pattern is a list of (motor-on?, duration-ms) steps.
constexpr Haptics::Step kTick[]  = {{true, 40}};
constexpr Haptics::Step kReady[] = {{true, 60}, {false, 80}, {true, 60}};
constexpr Haptics::Step kFault[] = {{true, 400}};
constexpr Haptics::Step kDraw[]  = {{true, 20}};
}  // namespace

void Haptics::begin() {
  pinMode(cfg::PIN_HAPTIC, OUTPUT);
  digitalWrite(cfg::PIN_HAPTIC, LOW);
}

void Haptics::play(HapticPattern pattern) {
  if (!enabled_) {
    return;
  }
  switch (pattern) {
    case HapticPattern::kTick:  seq_ = kTick;  seq_len_ = 1; break;
    case HapticPattern::kReady: seq_ = kReady; seq_len_ = 3; break;
    case HapticPattern::kFault: seq_ = kFault; seq_len_ = 1; break;
    case HapticPattern::kDraw:  seq_ = kDraw;  seq_len_ = 1; break;
  }
  idx_ = 0;
  step_started_ms_ = millis();
  digitalWrite(cfg::PIN_HAPTIC, seq_[0].on ? HIGH : LOW);
}

void Haptics::update(uint32_t now_ms) {
  if (!seq_ || idx_ >= seq_len_) {
    return;
  }
  if (now_ms - step_started_ms_ >= seq_[idx_].ms) {
    idx_++;
    if (idx_ >= seq_len_) {
      digitalWrite(cfg::PIN_HAPTIC, LOW);
      seq_ = nullptr;
      return;
    }
    step_started_ms_ = now_ms;
    digitalWrite(cfg::PIN_HAPTIC, seq_[idx_].on ? HIGH : LOW);
  }
}
