#pragma once

#include <cstdint>

// Non-blocking haptic feedback. Patterns are queued and driven from update()
// so a buzz never stalls the control loop with delay().
enum class HapticPattern : uint8_t {
  kTick,       // one short pulse (confirmation)
  kReady,      // double pulse (session at temp)
  kFault,      // long pulse (something went wrong)
  kDraw,       // subtle pulse on inhale detect
};

class Haptics {
 public:
  void begin();
  void play(HapticPattern pattern);
  void update(uint32_t now_ms);
  void setEnabled(bool enabled) { enabled_ = enabled; }  // stealth mode mutes

 private:
  struct Step { bool on; uint16_t ms; };
  const Step* seq_ = nullptr;
  uint8_t seq_len_ = 0;
  uint8_t idx_ = 0;
  uint32_t step_started_ms_ = 0;
  bool enabled_ = true;
};
