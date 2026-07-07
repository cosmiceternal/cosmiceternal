#pragma once

#include <cstdint>

#include "battery.h"
#include "heater_control.h"
#include "safety.h"
#include "session_profiles.h"
#include "temp_sensor.h"

enum class State {
  kIdle,
  kHeating,
  kReady,
  kActiveSession,
  kCooldown,
  kFault,
};

class StateMachine {
 public:
  void begin();
  void update(uint32_t now_ms);

  // Requests, driven by button input or BLE.
  void requestStart(ProfileId profile);
  void requestStop();
  void acknowledgeFault();

  State state() const { return state_; }
  float currentTempF() const { return temp_sensor_.temperatureF(); }
  float targetTempF() const { return profiles::get(profile_).target_f; }
  FaultReason faultReason() const { return safety_.lastFault(); }
  float batteryPercent() const { return battery_.percent(); }

 private:
  void enter(State next, uint32_t now_ms);

  State state_ = State::kIdle;
  ProfileId profile_ = ProfileId::kStandard;
  uint32_t state_entered_ms_ = 0;

  TempSensor temp_sensor_;
  HeaterControl heater_;
  SafetyMonitor safety_;
  Battery battery_;
};
