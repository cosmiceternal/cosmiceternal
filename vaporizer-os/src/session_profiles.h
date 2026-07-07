#pragma once

#include <cstdint>

// Puffco-style named heat profiles: a target temperature plus a ramp/hold
// shape. Kept as data, not code, so the companion app can eventually push
// custom profiles over BLE without a firmware update.
struct SessionProfile {
  const char* name;
  float target_f;
  uint32_t ramp_ms;   // time allowed to reach target_f
  uint32_t hold_ms;   // time to hold at target_f before auto-cooldown
};

enum class ProfileId : uint8_t {
  kFlavor = 0,
  kStandard = 1,
  kBoost = 2,
  kCount = 3,
};

namespace profiles {

const SessionProfile& get(ProfileId id);

}  // namespace profiles
