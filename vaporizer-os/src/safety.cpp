#include "safety.h"

#include "config.h"

void SafetyMonitor::armForSession(uint32_t now_ms) {
  armed_ = true;
  session_start_ms_ = now_ms;
  fault_ = FaultReason::kNone;
}

void SafetyMonitor::disarm() { armed_ = false; }

bool SafetyMonitor::check(const TempSensor& sensor, uint32_t now_ms) {
  if (!armed_) {
    return false;
  }

  if (sensor.isStale(now_ms)) {
    fault_ = FaultReason::kSensorStale;
    return true;
  }
  if (sensor.temperatureF() >= cfg::SAFETY_MAX_TEMP_F) {
    fault_ = FaultReason::kOverTemp;
    return true;
  }
  if (sensor.rawRateFPerSec() >= cfg::SAFETY_MAX_RATE_F_PER_S) {
    fault_ = FaultReason::kThermalRunaway;
    return true;
  }
  if (now_ms - session_start_ms_ >= cfg::SAFETY_MAX_SESSION_MS) {
    fault_ = FaultReason::kSessionTimeout;
    return true;
  }
  return false;
}
