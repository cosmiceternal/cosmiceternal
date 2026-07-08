#include "input.h"

#include "config.h"

void InputDecoder::begin() {}

Gesture InputDecoder::poll(bool pressed_raw, uint32_t now_ms) {
  // --- Debounce: only accept a level that has been stable long enough. ---
  if (pressed_raw != raw_last_) {
    raw_last_ = pressed_raw;
    last_change_ms_ = now_ms;
  }
  bool edge = false;
  if (now_ms - last_change_ms_ >= cfg::GESTURE_DEBOUNCE_MS &&
      pressed_raw != stable_pressed_) {
    stable_pressed_ = pressed_raw;
    edge = true;
  }

  // --- Press edge ---
  if (edge && stable_pressed_) {
    press_start_ms_ = now_ms;
    hold_fired_ = false;
  }

  // --- Hold fires once while still pressed, past the threshold. ---
  if (stable_pressed_ && !hold_fired_ &&
      now_ms - press_start_ms_ >= cfg::GESTURE_HOLD_MS) {
    hold_fired_ = true;
    tap_count_ = 0;  // a hold is not a tap
    return Gesture::kHold;
  }

  // --- Release edge ---
  if (edge && !stable_pressed_) {
    if (hold_fired_) {
      return Gesture::kHoldRelease;
    }
    // Short press -> tap. Accumulate for multi-tap; the tap window is
    // resolved below once no further tap arrives in time.
    tap_count_++;
    last_release_ms_ = now_ms;
  }

  // --- Resolve a run of taps once the multi-tap window closes. ---
  if (tap_count_ > 0 && !stable_pressed_ &&
      now_ms - last_release_ms_ >= cfg::GESTURE_MULTI_TAP_WINDOW_MS) {
    Gesture g;
    switch (tap_count_) {
      case 1:  g = Gesture::kSingleTap; break;
      case 2:  g = Gesture::kDoubleTap; break;
      default: g = Gesture::kTripleTap; break;  // 3+ collapses to triple
    }
    tap_count_ = 0;
    return g;
  }

  return Gesture::kNone;
}
