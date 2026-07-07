#include "ble_service.h"

#include <Arduino.h>
#include <BLE2902.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>

#include <cstring>

namespace {

// Custom 128-bit UUIDs — regenerate your own before shipping more than one
// unit, these are placeholders for development.
constexpr char kServiceUuid[]        = "7a2b1e00-0001-4a5c-9c1e-3f2b1a2c3d4e";
constexpr char kCommandCharUuid[]    = "7a2b1e00-0002-4a5c-9c1e-3f2b1a2c3d4e";
constexpr char kTelemetryCharUuid[]  = "7a2b1e00-0003-4a5c-9c1e-3f2b1a2c3d4e";

constexpr uint32_t kTelemetryIntervalMs = 500;

// Single-byte command protocol: [0]=opcode, [1]=arg
// opcode 0x01 = start session, arg = ProfileId
// opcode 0x02 = stop session
// opcode 0x03 = acknowledge fault
class CommandCallbacks : public BLECharacteristicCallbacks {
 public:
  explicit CommandCallbacks(StateMachine* machine) : machine_(machine) {}

  void onWrite(BLECharacteristic* characteristic) override {
    std::string value = characteristic->getValue();
    if (value.empty()) {
      return;
    }
    uint8_t opcode = static_cast<uint8_t>(value[0]);
    switch (opcode) {
      case 0x01: {
        uint8_t arg = value.size() > 1 ? static_cast<uint8_t>(value[1]) : 1;
        if (arg < static_cast<uint8_t>(ProfileId::kCount)) {
          machine_->requestStart(static_cast<ProfileId>(arg));
        }
        break;
      }
      case 0x02:
        machine_->requestStop();
        break;
      case 0x03:
        machine_->acknowledgeFault();
        break;
      default:
        break;
    }
  }

 private:
  StateMachine* machine_;
};

BLEServer* g_server = nullptr;
BLECharacteristic* g_telemetry_char = nullptr;
uint32_t g_last_telemetry_ms = 0;

}  // namespace

void BleService::begin(StateMachine* machine) {
  machine_ = machine;

  BLEDevice::init("VaporOS");
  g_server = BLEDevice::createServer();
  BLEService* service = g_server->createService(kServiceUuid);

  BLECharacteristic* command_char = service->createCharacteristic(
      kCommandCharUuid, BLECharacteristic::PROPERTY_WRITE);
  command_char->setCallbacks(new CommandCallbacks(machine_));

  g_telemetry_char = service->createCharacteristic(
      kTelemetryCharUuid,
      BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  g_telemetry_char->addDescriptor(new BLE2902());

  service->start();
  g_server->getAdvertising()->start();
}

void BleService::update(uint32_t now_ms) {
  if (!g_telemetry_char || now_ms - g_last_telemetry_ms < kTelemetryIntervalMs) {
    return;
  }
  g_last_telemetry_ms = now_ms;

  // Telemetry frame: [state(1)][current_temp_f(2, x10 fixed-point)]
  //                  [target_temp_f(2, x10 fixed-point)][battery_pct(1)][fault(1)]
  uint8_t frame[7];
  frame[0] = static_cast<uint8_t>(machine_->state());
  int16_t cur_x10 = static_cast<int16_t>(machine_->currentTempF() * 10.0f);
  int16_t tgt_x10 = static_cast<int16_t>(machine_->targetTempF() * 10.0f);
  memcpy(&frame[1], &cur_x10, 2);
  memcpy(&frame[3], &tgt_x10, 2);
  frame[5] = static_cast<uint8_t>(machine_->batteryPercent());
  frame[6] = static_cast<uint8_t>(machine_->faultReason());

  g_telemetry_char->setValue(frame, sizeof(frame));
  g_telemetry_char->notify();
}
