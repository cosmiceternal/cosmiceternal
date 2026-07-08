#pragma once

#include <cstdint>

#include "atomizer.h"
#include "battery.h"
#include "draw_sensor.h"
#include "heater_control.h"
#include "safety.h"
#include "session_profiles.h"
#include "stats.h"
#include "temp_sensor.h"

enum class State {
  kIdle,
  kHeating,
  kReady,
  kActiveSession,
  kCooldown,
  kFault,
};

// Central coordinator. Owns the control-critical subsystems (sensor, heater,
// safety, battery, atomizer, draw, stats) and runs the session lifecycle.
// UX subsystems (LEDs, haptics, display, BLE, modes) live in main and read
// this via the accessors below — keeping presentation out of the control path.
class StateMachine {
 public:
  void begin();
  void update(uint32_t now_ms);

  // Requests, driven by button gestures or BLE.
  void requestStart(uint8_t profile_slot);
  void requestStop();
  void acknowledgeFault();

  // The companion app pushes a day index (see stats.cpp) for the daily limit.
  void setDayIndex(uint32_t day_index) { day_index_ = day_index; }

  // --- Telemetry / UX accessors ---
  State state() const { return state_; }
  float currentTempF() const { return temp_sensor_.temperatureF(); }
  float targetTempF() const { return active_target_f_; }
  FaultReason faultReason() const { return safety_.lastFault(); }
  float heatingProgress() const;  // 0..1 for the LED ring fill

  Battery& battery() { return battery_; }
  Atomizer& atomizer() { return atomizer_; }
  Stats& stats() { return stats_; }

  // Const conveniences for read-only consumers (display).
  float batteryPercent() const { return battery_.percent(); }
  bool cleaningDue() const { return stats_.cleaningDue(); }

  bool heaterOff() const { return !heater_.isEnergized(); }
  bool canStart() const;  // battery not locked out, idle, atomizer present

 private:
  void enter(State next, uint32_t now_ms);
  SafetyInputs gatherSafetyInputs() const;
  float readEnclosureF() const;

  State state_ = State::kIdle;
  uint8_t profile_slot_ = static_cast<uint8_t>(ProfileId::kStandard);
  float active_target_f_ = 0.0f;
  float session_peak_f_ = 0.0f;
  uint32_t state_entered_ms_ = 0;
  uint32_t now_ms_ = 0;
  uint32_t day_index_ = 0;

  TempSensor temp_sensor_;
  HeaterControl heater_;
  SafetyMonitor safety_;
  Battery battery_;
  Atomizer atomizer_;
  DrawSensor draw_sensor_;
  Stats stats_;
};
