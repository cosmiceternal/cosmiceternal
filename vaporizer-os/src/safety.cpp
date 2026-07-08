#include "safety.h"

#include "config.h"

void SafetyMonitor::armForSession(uint32_t now_ms) {
  armed_ = true;
  session_start_ms_ = now_ms;
  fault_ = FaultReason::kNone;
}

void SafetyMonitor::disarm() { armed_ = false; }

bool SafetyMonitor::check(const TempSensor& sensor, const SafetyInputs& in, uint32_t now_ms) {
  if (!armed_) {
    return false;
  }

  // --- Sensor integrity first: everything below trusts these readings. ---
  if (sensor.isStale(now_ms)) {
    fault_ = FaultReason::kSensorStale;
    return true;
  }

  // --- Coil thermal faults ---
  if (sensor.temperatureF() >= cfg::SAFETY_MAX_TEMP_F) {
    fault_ = FaultReason::kOverTemp;
    return true;
  }
  if (sensor.rawRateFPerSec() >= cfg::SAFETY_MAX_RATE_F_PER_S) {
    fault_ = FaultReason::kThermalRunaway;
    return true;
  }

  // --- Electrical faults ---
  if (in.pack_volts <= cfg::SAFETY_MIN_PACK_VOLTS) {
    fault_ = FaultReason::kUnderVoltage;
    return true;
  }
  if (in.heater_amps >= cfg::SAFETY_MAX_HEATER_AMPS) {
    fault_ = FaultReason::kOverCurrent;
    return true;
  }

  // No-load: only a fault while we're actually pushing power. An out-of-range
  // resistance with the coil energized means the atomizer is missing or the
  // element failed open/short — cut power before dumping energy into nothing.
  if (in.heater_energized &&
      (in.atomizer_ohms < cfg::ATOMIZER_MIN_OHMS ||
       in.atomizer_ohms > cfg::ATOMIZER_MAX_OHMS)) {
    fault_ = FaultReason::kNoLoad;
    return true;
  }

  // --- Enclosure / user-contact temperature ---
  if (in.enclosure_f >= cfg::SAFETY_MAX_ENCLOSURE_F) {
    fault_ = FaultReason::kEnclosureOverTemp;
    return true;
  }

  // --- Watchdog on session length ---
  if (now_ms - session_start_ms_ >= cfg::SAFETY_MAX_SESSION_MS) {
    fault_ = FaultReason::kSessionTimeout;
    return true;
  }
  return false;
}

const char* faultLabel(FaultReason r) {
  switch (r) {
    case FaultReason::kNone:             return "OK";
    case FaultReason::kOverTemp:         return "OVER-TEMP";
    case FaultReason::kThermalRunaway:   return "RUNAWAY";
    case FaultReason::kSessionTimeout:   return "TIMEOUT";
    case FaultReason::kSensorStale:      return "SENSOR";
    case FaultReason::kUnderVoltage:     return "LOW-VOLT";
    case FaultReason::kOverCurrent:      return "OVER-AMP";
    case FaultReason::kEnclosureOverTemp:return "HOT-BODY";
    case FaultReason::kNoLoad:           return "NO-COIL";
  }
  return "?";
}
