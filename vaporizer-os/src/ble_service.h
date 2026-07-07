#pragma once

#include "state_machine.h"

// GATT server exposing session control + telemetry to a companion app.
// Wraps the ESP32 Arduino BLE stack; kept isolated so state_machine.cpp has
// no BLE-library dependency.
class BleService {
 public:
  void begin(StateMachine* machine);
  void update(uint32_t now_ms);

 private:
  StateMachine* machine_ = nullptr;
};
