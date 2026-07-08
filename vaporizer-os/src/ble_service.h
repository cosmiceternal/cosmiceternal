#pragma once

#include "device_mode.h"
#include "ota.h"
#include "state_machine.h"

// GATT server exposing session control, settings, telemetry, and OTA to a
// companion app. Wraps the ESP32 Arduino BLE stack; kept isolated so the
// control modules have no BLE-library dependency.
class BleService {
 public:
  void begin(StateMachine* machine, DeviceModes* modes, Ota* ota);
  void update(uint32_t now_ms);

 private:
  StateMachine* machine_ = nullptr;
  DeviceModes* modes_ = nullptr;
  Ota* ota_ = nullptr;
};
