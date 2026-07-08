#include "device_mode.h"

#include <Preferences.h>

namespace {
Preferences g_prefs;
constexpr char kNamespace[] = "vapor-mode";
}  // namespace

void DeviceModes::begin() {
  g_prefs.begin(kNamespace, /*readOnly=*/true);
  mode_ = static_cast<DeviceMode>(g_prefs.getUChar("mode", 0));
  locked_ = g_prefs.getBool("locked", false);
  g_prefs.end();
}

void DeviceModes::cycleMode() {
  switch (mode_) {
    case DeviceMode::kNormal:  mode_ = DeviceMode::kStealth; break;
    case DeviceMode::kStealth: mode_ = DeviceMode::kParty;   break;
    case DeviceMode::kParty:   mode_ = DeviceMode::kNormal;  break;
  }
  g_prefs.begin(kNamespace, /*readOnly=*/false);
  g_prefs.putUChar("mode", static_cast<uint8_t>(mode_));
  g_prefs.end();
}

void DeviceModes::setLocked(bool locked) {
  locked_ = locked;
  g_prefs.begin(kNamespace, /*readOnly=*/false);
  g_prefs.putBool("locked", locked_);
  g_prefs.end();
}

uint8_t DeviceModes::ledBrightness() const {
  switch (mode_) {
    case DeviceMode::kStealth: return 15;
    case DeviceMode::kParty:   return 255;
    case DeviceMode::kNormal:  return 120;
  }
  return 120;
}
