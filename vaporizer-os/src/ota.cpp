#include "ota.h"

#include <Update.h>

void Ota::begin(SafeToUpdateFn gate) { gate_ = gate; }

bool Ota::start() {
  // Never flash while the device could be heating. The gate is supplied by
  // main/state_machine and must confirm idle + heater-off + unlocked.
  if (in_progress_ || (gate_ && !gate_())) {
    return false;
  }
  if (!Update.begin(UPDATE_SIZE_UNKNOWN)) {
    return false;
  }
  in_progress_ = true;
  return true;
}

bool Ota::writeChunk(const uint8_t* data, uint32_t len) {
  if (!in_progress_) {
    return false;
  }
  if (Update.write(const_cast<uint8_t*>(data), len) != len) {
    abort();
    return false;
  }
  return true;
}

bool Ota::finish() {
  if (!in_progress_) {
    return false;
  }
  if (!Update.end(/*evenIfRemaining=*/true) || !Update.isFinished()) {
    abort();
    return false;
  }
  in_progress_ = false;
  ESP.restart();  // boots the newly written partition
  return true;    // not reached
}

void Ota::abort() {
  if (in_progress_) {
    Update.abort();
    in_progress_ = false;
  }
}
