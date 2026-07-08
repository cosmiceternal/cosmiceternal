#include "session_profiles.h"

#include <Preferences.h>
#include <algorithm>
#include <cstring>

namespace {

// {name, target_f, start_f, ramp_ms, hold_ms, guided}
constexpr SessionProfile kBuiltins[] = {
    {"Flavor",   440.0f, 440.0f, 15000, 20000, false},
    {"Standard", 500.0f, 500.0f, 12000, 25000, false},
    {"Boost",    575.0f, 575.0f,  9000, 15000, false},
    {"Rosin",    420.0f, 420.0f, 14000, 22000, false},
    {"Shatter",  560.0f, 560.0f, 10000, 18000, false},
    {"Badder",   470.0f, 500.0f, 12000, 26000, true},   // guided 470 -> 500
};
static_assert(sizeof(kBuiltins) / sizeof(kBuiltins[0]) ==
                  static_cast<size_t>(ProfileId::kBuiltinCount),
              "kBuiltins must match ProfileId::kBuiltinCount");

SessionProfile g_custom[profiles::kMaxCustom];
bool g_custom_valid[profiles::kMaxCustom] = {false};

Preferences g_prefs;
constexpr char kNamespace[] = "vapor-prof";

}  // namespace

void profiles::begin() {
  g_prefs.begin(kNamespace, /*readOnly=*/true);
  for (uint8_t i = 0; i < kMaxCustom; i++) {
    char key[8];
    snprintf(key, sizeof(key), "c%u", i);
    size_t n = g_prefs.getBytesLength(key);
    if (n == sizeof(SessionProfile)) {
      g_prefs.getBytes(key, &g_custom[i], sizeof(SessionProfile));
      g_custom_valid[i] = true;
    }
  }
  g_prefs.end();
}

const SessionProfile& profiles::get(uint8_t slot) {
  const uint8_t builtin_count = static_cast<uint8_t>(ProfileId::kBuiltinCount);
  if (slot < builtin_count) {
    return kBuiltins[slot];
  }
  uint8_t ci = slot - builtin_count;
  if (ci < kMaxCustom && g_custom_valid[ci]) {
    return g_custom[ci];
  }
  return kBuiltins[static_cast<uint8_t>(ProfileId::kStandard)];
}

float profiles::targetAtHoldElapsed(const SessionProfile& p,
                                    uint32_t hold_elapsed_ms) {
  if (!p.guided || p.hold_ms == 0) {
    return p.target_f;
  }
  float frac = std::min(1.0f, hold_elapsed_ms / static_cast<float>(p.hold_ms));
  return p.start_f + (p.target_f - p.start_f) * frac;
}

bool profiles::saveCustom(uint8_t slot, const SessionProfile& p) {
  const uint8_t builtin_count = static_cast<uint8_t>(ProfileId::kBuiltinCount);
  if (slot < builtin_count || slot >= kTotalSlots) {
    return false;
  }
  uint8_t ci = slot - builtin_count;
  g_custom[ci] = p;
  g_custom_valid[ci] = true;

  g_prefs.begin(kNamespace, /*readOnly=*/false);
  char key[8];
  snprintf(key, sizeof(key), "c%u", ci);
  g_prefs.putBytes(key, &g_custom[ci], sizeof(SessionProfile));
  g_prefs.end();
  return true;
}

uint8_t profiles::totalSlots() { return kTotalSlots; }
