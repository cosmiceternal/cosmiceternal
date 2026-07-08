#pragma once

#include <cstdint>

// Identifies the attached atomizer by measuring coil resistance, and reports
// presence. Resistance both gates safety (no-load) and lets the device pick a
// sensible default profile per atomizer type (auto-detect).
enum class AtomizerType : uint8_t {
  kNone,      // out of range -> nothing attached / open / short
  kStandard,  // stock 3D-chamber-style coil
  kLowTemp,   // higher-resistance flavor coil
  kHighPower, // lower-resistance banger/high-output
  kUnknown,   // in-range but not matching a known band
};

class Atomizer {
 public:
  void begin();
  void update(uint32_t now_ms);

  float ohms() const { return ohms_; }
  bool present() const { return type_ != AtomizerType::kNone; }
  AtomizerType type() const { return type_; }

  // Suggested profile slot for the detected atomizer, so a fresh attach can
  // pre-select a matching heat profile. Returns Standard for unknown.
  uint8_t suggestedProfileSlot() const;

 private:
  float readOhms();

  float ohms_ = 0.0f;
  AtomizerType type_ = AtomizerType::kNone;
  uint32_t last_read_ms_ = 0;
};
