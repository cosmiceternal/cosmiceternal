#include "atomizer.h"

#include <Arduino.h>

#include "config.h"
#include "session_profiles.h"

namespace {
constexpr uint32_t kReadIntervalMs = 250;

AtomizerType classify(float ohms) {
  if (ohms < cfg::ATOMIZER_MIN_OHMS || ohms > cfg::ATOMIZER_MAX_OHMS) {
    return AtomizerType::kNone;
  }
  // Bands within the healthy window. Tune to your actual coil lineup.
  if (ohms >= 1.6f) return AtomizerType::kLowTemp;
  if (ohms <= 0.7f) return AtomizerType::kHighPower;
  if (ohms >= 0.9f && ohms <= 1.3f) return AtomizerType::kStandard;
  return AtomizerType::kUnknown;
}
}  // namespace

void Atomizer::begin() {
  // ADC + reference-resistor divider setup hook. A brief low-power pulse
  // through a known series resistor lets us compute coil resistance from the
  // divider voltage without energizing the heater for real.
}

float Atomizer::readOhms() {
  // Placeholder: real code drives a small sense current and reads the divider.
  //   float v = analogReadMilliVolts(cfg::PIN_ATOMIZER_SENSE) / 1000.0f;
  //   ohms = R_ref * v / (V_ref - v);
  return ohms_;
}

void Atomizer::update(uint32_t now_ms) {
  if (now_ms - last_read_ms_ < kReadIntervalMs) {
    return;
  }
  last_read_ms_ = now_ms;
  ohms_ = readOhms();
  type_ = classify(ohms_);
}

uint8_t Atomizer::suggestedProfileSlot() const {
  switch (type_) {
    case AtomizerType::kLowTemp:   return static_cast<uint8_t>(ProfileId::kFlavor);
    case AtomizerType::kHighPower: return static_cast<uint8_t>(ProfileId::kBoost);
    case AtomizerType::kStandard:  return static_cast<uint8_t>(ProfileId::kStandard);
    default:                       return static_cast<uint8_t>(ProfileId::kStandard);
  }
}
