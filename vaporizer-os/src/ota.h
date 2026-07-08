#pragma once

#include <cstdint>

// Over-the-air firmware update entry point. The actual byte transfer happens
// over BLE (chunked writes to a dedicated characteristic) or WiFi pull; this
// module owns the flash-partition write + verify + reboot so the transport
// layer (ble_service) stays a dumb pipe.
//
// Safety rule: OTA is only allowed to begin from an idle, unlocked device with
// the heater guaranteed off. begin() enforces that via the gate callback.
class Ota {
 public:
  using SafeToUpdateFn = bool (*)();

  void begin(SafeToUpdateFn gate);

  // Called by the transport when an update session is requested. Returns false
  // (and does nothing) if the device isn't in a safe state to flash.
  bool start();
  // Feed a chunk of firmware image. Returns false on write/verify error.
  bool writeChunk(const uint8_t* data, uint32_t len);
  // Finalize: verify image, set boot partition, reboot. No return on success.
  bool finish();
  void abort();

  bool inProgress() const { return in_progress_; }

 private:
  SafeToUpdateFn gate_ = nullptr;
  bool in_progress_ = false;
};
