#include "ble_service.h"

#include <Arduino.h>
#include <BLE2902.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>

#include <cstring>

#include "session_profiles.h"

namespace {

// Custom 128-bit UUIDs — regenerate your own before shipping more than one
// unit, these are placeholders for development.
constexpr char kServiceUuid[]       = "7a2b1e00-0001-4a5c-9c1e-3f2b1a2c3d4e";
constexpr char kCommandCharUuid[]   = "7a2b1e00-0002-4a5c-9c1e-3f2b1a2c3d4e";
constexpr char kTelemetryCharUuid[] = "7a2b1e00-0003-4a5c-9c1e-3f2b1a2c3d4e";
constexpr char kOtaCharUuid[]       = "7a2b1e00-0004-4a5c-9c1e-3f2b1a2c3d4e";

constexpr uint32_t kTelemetryIntervalMs = 500;

// Command opcodes (first byte of a write to the command characteristic).
enum : uint8_t {
  kCmdStart        = 0x01,  // arg[0] = profile slot
  kCmdStop         = 0x02,
  kCmdAckFault     = 0x03,
  kCmdSetMode      = 0x04,  // arg[0] = DeviceMode
  kCmdSetLock      = 0x05,  // arg[0] = 0/1
  kCmdSetDailyLimit = 0x06, // arg[0..1] = uint16 limit
  kCmdResetClean   = 0x07,
  kCmdSetDayIndex  = 0x08,  // arg[0..3] = uint32 day index
  kCmdSaveProfile  = 0x09,  // arg[0]=slot, arg[1..] = SessionProfile bytes
};

// OTA sub-protocol (first byte of a write to the OTA characteristic).
enum : uint8_t {
  kOtaStart  = 0xA1,
  kOtaChunk  = 0xA2,  // followed by raw image bytes
  kOtaFinish = 0xA3,
  kOtaAbort  = 0xA4,
};

BLEServer* g_server = nullptr;
BLECharacteristic* g_telemetry_char = nullptr;
uint32_t g_last_telemetry_ms = 0;

class CommandCallbacks : public BLECharacteristicCallbacks {
 public:
  CommandCallbacks(StateMachine* m, DeviceModes* modes) : m_(m), modes_(modes) {}

  void onWrite(BLECharacteristic* c) override {
    std::string v = c->getValue();
    if (v.empty()) return;
    uint8_t op = static_cast<uint8_t>(v[0]);
    auto arg = [&](size_t i) -> uint8_t {
      return v.size() > i ? static_cast<uint8_t>(v[i]) : 0;
    };

    switch (op) {
      case kCmdStart:
        if (!modes_->locked()) m_->requestStart(arg(1));
        break;
      case kCmdStop:
        m_->requestStop();
        break;
      case kCmdAckFault:
        m_->acknowledgeFault();
        break;
      case kCmdSetMode:
        modes_->setMode(static_cast<DeviceMode>(arg(1)));
        break;
      case kCmdSetLock:
        modes_->setLocked(arg(1) != 0);
        break;
      case kCmdSetDailyLimit: {
        uint16_t limit = static_cast<uint16_t>(arg(1) | (arg(2) << 8));
        m_->stats().setDailyLimit(limit);
        break;
      }
      case kCmdResetClean:
        m_->stats().resetCleaningCounter();
        break;
      case kCmdSetDayIndex: {
        uint32_t day = arg(1) | (arg(2) << 8) | (arg(3) << 16) | (arg(4) << 24);
        m_->setDayIndex(day);
        break;
      }
      case kCmdSaveProfile: {
        if (v.size() >= 1 + 1 + sizeof(SessionProfile)) {
          SessionProfile p;
          memcpy(&p, v.data() + 2, sizeof(SessionProfile));
          profiles::saveCustom(arg(1), p);
        }
        break;
      }
      default:
        break;
    }
  }

 private:
  StateMachine* m_;
  DeviceModes* modes_;
};

class OtaCallbacks : public BLECharacteristicCallbacks {
 public:
  explicit OtaCallbacks(Ota* ota) : ota_(ota) {}

  void onWrite(BLECharacteristic* c) override {
    std::string v = c->getValue();
    if (v.empty()) return;
    uint8_t op = static_cast<uint8_t>(v[0]);
    const uint8_t* payload = reinterpret_cast<const uint8_t*>(v.data()) + 1;
    uint32_t len = v.size() - 1;

    switch (op) {
      case kOtaStart:  ota_->start(); break;
      case kOtaChunk:  ota_->writeChunk(payload, len); break;
      case kOtaFinish: ota_->finish(); break;
      case kOtaAbort:  ota_->abort(); break;
      default: break;
    }
  }

 private:
  Ota* ota_;
};

}  // namespace

void BleService::begin(StateMachine* machine, DeviceModes* modes, Ota* ota) {
  machine_ = machine;
  modes_ = modes;
  ota_ = ota;

  BLEDevice::init("VaporOS");
  g_server = BLEDevice::createServer();
  BLEService* service = g_server->createService(kServiceUuid);

  BLECharacteristic* cmd = service->createCharacteristic(
      kCommandCharUuid, BLECharacteristic::PROPERTY_WRITE);
  cmd->setCallbacks(new CommandCallbacks(machine_, modes_));

  BLECharacteristic* ota_char = service->createCharacteristic(
      kOtaCharUuid, BLECharacteristic::PROPERTY_WRITE);
  ota_char->setCallbacks(new OtaCallbacks(ota_));

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

  // Telemetry frame (little-endian):
  //  [0]  state
  //  [1..2] current temp F x10 (int16)
  //  [3..4] target temp F x10 (int16)
  //  [5]  battery percent
  //  [6]  fault reason
  //  [7]  device mode | (locked << 7)
  //  [8]  atomizer type
  //  [9]  flags: bit0 charging, bit1 cleaning-due
  //  [10..11] hits today (uint16)
  uint8_t f[12];
  f[0] = static_cast<uint8_t>(machine_->state());
  int16_t cur = static_cast<int16_t>(machine_->currentTempF() * 10.0f);
  int16_t tgt = static_cast<int16_t>(machine_->targetTempF() * 10.0f);
  memcpy(&f[1], &cur, 2);
  memcpy(&f[3], &tgt, 2);
  f[5] = static_cast<uint8_t>(machine_->battery().percent());
  f[6] = static_cast<uint8_t>(machine_->faultReason());
  f[7] = static_cast<uint8_t>(modes_->mode()) | (modes_->locked() ? 0x80 : 0);
  f[8] = static_cast<uint8_t>(machine_->atomizer().type());
  f[9] = (machine_->battery().isCharging() ? 0x01 : 0) |
         (machine_->stats().cleaningDue() ? 0x02 : 0);
  uint16_t hits = machine_->stats().summary().hits_today;
  memcpy(&f[10], &hits, 2);

  g_telemetry_char->setValue(f, sizeof(f));
  g_telemetry_char->notify();
}
