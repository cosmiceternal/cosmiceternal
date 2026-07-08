#include "stats.h"

#include <Preferences.h>

#include "config.h"

namespace {
Preferences g_prefs;
constexpr char kNamespace[] = "vapor-stats";
}  // namespace

void Stats::begin() {
  g_prefs.begin(kNamespace, /*readOnly=*/true);
  s_.lifetime_sessions   = g_prefs.getULong("life", 0);
  s_.sessions_since_clean = g_prefs.getULong("clean", 0);
  s_.daily_hit_limit     = g_prefs.getUShort("limit", cfg::DEFAULT_DAILY_HIT_LIMIT);
  s_.last_session_peak_f = g_prefs.getFloat("peak", 0.0f);
  s_.last_session_ms     = g_prefs.getULong("last", 0);
  current_day_           = g_prefs.getULong("day", 0);
  s_.hits_today          = g_prefs.getUShort("hits", 0);
  g_prefs.end();
}

void Stats::persist() {
  g_prefs.begin(kNamespace, /*readOnly=*/false);
  g_prefs.putULong("life", s_.lifetime_sessions);
  g_prefs.putULong("clean", s_.sessions_since_clean);
  g_prefs.putUShort("limit", s_.daily_hit_limit);
  g_prefs.putFloat("peak", s_.last_session_peak_f);
  g_prefs.putULong("last", s_.last_session_ms);
  g_prefs.putULong("day", current_day_);
  g_prefs.putUShort("hits", s_.hits_today);
  g_prefs.end();
}

// day_index is a monotonically increasing "which day is it" value supplied by
// the caller. Without an RTC the firmware can't know the calendar date, so the
// companion app pushes the current day index on connect; until then we use a
// device-uptime-derived day so the limit still rolls over roughly daily.
void Stats::rollDayIfNeeded(uint32_t day_index) {
  if (day_index != current_day_) {
    current_day_ = day_index;
    s_.hits_today = 0;
  }
}

void Stats::recordSession(float peak_f, uint32_t duration_ms, uint32_t day_index) {
  rollDayIfNeeded(day_index);
  s_.lifetime_sessions++;
  s_.sessions_since_clean++;
  s_.last_session_peak_f = peak_f;
  s_.last_session_ms = duration_ms;
  persist();
}

bool Stats::canHit(uint32_t day_index) {
  rollDayIfNeeded(day_index);
  if (s_.daily_hit_limit == 0) {
    return true;  // limiting disabled
  }
  return s_.hits_today < s_.daily_hit_limit;
}

void Stats::recordHit(uint32_t day_index) {
  rollDayIfNeeded(day_index);
  s_.hits_today++;
  persist();
}

void Stats::setDailyLimit(uint16_t limit) {
  s_.daily_hit_limit = limit;
  persist();
}

void Stats::resetCleaningCounter() {
  s_.sessions_since_clean = 0;
  persist();
}

bool Stats::cleaningDue() const {
  return s_.sessions_since_clean >= cfg::CLEANING_REMINDER_SESSIONS;
}
