#pragma once

#include <cstdint>

// Discrete gestures decoded from the single action button. Emitting semantic
// gestures (not raw edges) keeps the state machine free of debounce/timing
// bookkeeping and makes the button's meaning obvious at the call site.
enum class Gesture : uint8_t {
  kNone,
  kSingleTap,
  kDoubleTap,
  kTripleTap,
  kHold,          // held past GESTURE_HOLD_MS (fires once on threshold)
  kHoldRelease,   // the release that ends a hold (for "boost while held" UX)
};

// Debounces the button and classifies taps vs. holds. Call poll() every tick
// with the current raw pressed state; it returns at most one gesture per call.
class InputDecoder {
 public:
  void begin();
  Gesture poll(bool pressed_raw, uint32_t now_ms);

 private:
  bool stable_pressed_ = false;
  bool raw_last_ = false;
  uint32_t last_change_ms_ = 0;
  uint32_t press_start_ms_ = 0;
  uint32_t last_release_ms_ = 0;
  uint8_t tap_count_ = 0;
  bool hold_fired_ = false;
};
