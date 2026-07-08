#pragma once

#include <cstdint>

// Persistent usage tracking: lifetime session count (for cleaning reminders),
// a rolling daily hit counter (for optional self-limiting), and last-session
// summary for the app. Backed by NVS so it survives reboots and battery pulls.
struct UsageSummary {
  uint32_t lifetime_sessions;
  uint32_t sessions_since_clean;
  uint16_t hits_today;
  uint16_t daily_hit_limit;   // 0 = disabled
  float last_session_peak_f;
  uint32_t last_session_ms;
};

class Stats {
 public:
  void begin();

  // Call when a heating session completes. peak_f = hottest temp reached,
  // duration_ms = how long the session ran. day_index lets the daily counter
  // reset without a real-time clock (see note in stats.cpp).
  void recordSession(float peak_f, uint32_t duration_ms, uint32_t day_index);

  // Returns false if recording this hit would exceed the daily limit.
  bool canHit(uint32_t day_index);
  void recordHit(uint32_t day_index);

  void setDailyLimit(uint16_t limit);
  void resetCleaningCounter();  // user pressed "I cleaned it" in the app

  bool cleaningDue() const;
  const UsageSummary& summary() const { return s_; }

 private:
  void rollDayIfNeeded(uint32_t day_index);
  void persist();

  UsageSummary s_{};
  uint32_t current_day_ = 0;
};
