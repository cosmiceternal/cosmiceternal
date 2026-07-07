#pragma once

#include <cstdint>

#include "temp_sensor.h"

enum class FaultReason : uint8_t {
  kNone,
  kOverTemp,
  kThermalRunaway,
  kSessionTimeout,
  kSensorStale,
};

// Independent watchdog over the heater. Does not trust heater_control or BLE
// state — reads the sensor directly and can force a shutdown regardless of
// what the rest of the system thinks it's doing. Keep this the single place
// that can declare a fault; nothing else should duplicate these checks.
class SafetyMonitor {
 public:
  void armForSession(uint32_t now_ms);
  void disarm();

  // Returns true if a fault is active. Call every loop tick while heating.
  bool check(const TempSensor& sensor, uint32_t now_ms);

  FaultReason lastFault() const { return fault_; }
  void clearFault() { fault_ = FaultReason::kNone; }

 private:
  FaultReason fault_ = FaultReason::kNone;
  uint32_t session_start_ms_ = 0;
  bool armed_ = false;
};
