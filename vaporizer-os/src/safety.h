#pragma once

#include <cstdint>

#include "temp_sensor.h"

enum class FaultReason : uint8_t {
  kNone,
  kOverTemp,
  kThermalRunaway,
  kSessionTimeout,
  kSensorStale,
  kUnderVoltage,
  kOverCurrent,
  kEnclosureOverTemp,
  kNoLoad,
};

// Extra live readings the watchdog needs beyond the coil thermocouple.
// Gathered once per tick and handed to check() so safety never has to reach
// into other modules or trust their cached state.
struct SafetyInputs {
  float pack_volts = 4.2f;
  float heater_amps = 0.0f;
  float enclosure_f = 70.0f;
  float atomizer_ohms = 1.0f;
  bool heater_energized = false;  // is the control loop actually driving the coil?
};

// Independent watchdog over the heater. Does not trust heater_control or BLE
// state — reads sensors directly and can force a shutdown regardless of what
// the rest of the system thinks it's doing. Keep this the single place that
// can declare a fault; nothing else should duplicate these checks.
class SafetyMonitor {
 public:
  void armForSession(uint32_t now_ms);
  void disarm();

  // Returns true if a fault is active. Call every loop tick while heating.
  bool check(const TempSensor& sensor, const SafetyInputs& in, uint32_t now_ms);

  FaultReason lastFault() const { return fault_; }
  void clearFault() { fault_ = FaultReason::kNone; }

 private:
  FaultReason fault_ = FaultReason::kNone;
  uint32_t session_start_ms_ = 0;
  bool armed_ = false;
};

// Human-readable label, shared by display/BLE/logging.
const char* faultLabel(FaultReason r);
