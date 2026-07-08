#pragma once

#include <cstdint>

// A heat profile. Kept as plain data so the companion app can push custom
// profiles over BLE and we can persist them to NVS without code changes.
//
// A "guided" session ramps target_f from start_f -> target_f across the hold
// window instead of holding flat — the Puffco-style "temp step" experience
// that keeps vapor coming as the concentrate depletes.
struct SessionProfile {
  char name[16];
  float target_f;
  float start_f;      // guided ramp start; == target_f for a flat hold
  uint32_t ramp_ms;   // time budget to reach start_f
  uint32_t hold_ms;   // time held (or guided-ramped) before auto-cooldown
  bool guided;
};

// Built-in presets. First three mirror the original Flavor/Standard/Boost;
// the rest are concentrate-tuned. Custom (user/app) profiles live in slots
// after the built-ins, persisted to NVS.
enum class ProfileId : uint8_t {
  kFlavor = 0,
  kStandard,
  kBoost,
  kRosin,       // lower-temp, flavor-forward for live rosin
  kShatter,     // hotter, for stiff shatter
  kBadder,      // mid, guided ramp
  kBuiltinCount,
};

namespace profiles {

constexpr uint8_t kMaxCustom = 4;
constexpr uint8_t kTotalSlots =
    static_cast<uint8_t>(ProfileId::kBuiltinCount) + kMaxCustom;

// Load any persisted custom profiles from NVS. Safe to call once at boot.
void begin();

// Look up by slot index (0..kTotalSlots-1). Built-ins first, then customs.
// Out-of-range or empty custom slots return the Standard preset.
const SessionProfile& get(uint8_t slot);

// Effective target for a guided profile at a given elapsed time in the hold
// phase. For non-guided profiles this is just target_f.
float targetAtHoldElapsed(const SessionProfile& p, uint32_t hold_elapsed_ms);

// Save/overwrite a custom profile (slot >= kBuiltinCount). Persists to NVS.
// Returns false if the slot is not a custom slot.
bool saveCustom(uint8_t slot, const SessionProfile& p);

uint8_t totalSlots();

}  // namespace profiles
