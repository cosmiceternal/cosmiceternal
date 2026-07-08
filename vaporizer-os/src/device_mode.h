#pragma once

#include <cstdint>

// Cross-cutting device modes that modulate UX (not the control loop):
//  - Normal:  default brightness + haptics
//  - Stealth: LEDs dimmed, haptics muted, silent operation
//  - Party:   LEDs at max, extra animations
// Lock is orthogonal (a device can be locked in any mode) and blocks heating
// until unlocked — a child-lock / anti-pocket-fire safeguard.
enum class DeviceMode : uint8_t {
  kNormal,
  kStealth,
  kParty,
};

class DeviceModes {
 public:
  void begin();

  DeviceMode mode() const { return mode_; }
  void setMode(DeviceMode m) { mode_ = m; }
  void cycleMode();

  bool locked() const { return locked_; }
  void setLocked(bool locked);
  void toggleLock() { setLocked(!locked_); }

  // Derived UX parameters other modules read.
  uint8_t ledBrightness() const;
  bool hapticsEnabled() const { return mode_ != DeviceMode::kStealth; }

 private:
  DeviceMode mode_ = DeviceMode::kNormal;
  bool locked_ = false;
};
