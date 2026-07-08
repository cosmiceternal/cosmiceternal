#pragma once

#include <cstdint>

// The signature status LED ring (Puffco-style). Purely presentational: it is
// told the current status + a 0..1 progress value and renders an animation.
// It never reads control/safety state directly.
enum class LedStatus : uint8_t {
  kOff,
  kIdle,
  kHeating,   // fills the ring as progress -> 1.0
  kReady,     // breathing pulse
  kSession,   // steady glow
  kCooldown,  // fading
  kFault,     // red flash
  kCharging,
  kLocked,    // child-lock indication
};

class LedRing {
 public:
  void begin();

  // status + progress (0..1, used by kHeating). Call every render tick.
  void update(LedStatus status, float progress, uint32_t now_ms);

  // Stealth mode dims; party mode can crank it. 0..255.
  void setBrightness(uint8_t brightness) { brightness_ = brightness; }

 private:
  void fill(uint8_t r, uint8_t g, uint8_t b);
  void fillProgress(float progress, uint8_t r, uint8_t g, uint8_t b);

  uint8_t brightness_ = 120;
  uint32_t last_render_ms_ = 0;
};
