#include <Arduino.h>
#include <Wire.h>
#include <esp_sleep.h>

#include "ble_service.h"
#include "config.h"
#include "device_mode.h"
#include "display.h"
#include "haptics.h"
#include "input.h"
#include "led_ring.h"
#include "ota.h"
#include "state_machine.h"

namespace {
StateMachine g_machine;
BleService g_ble;
Display g_display;
InputDecoder g_input;
Haptics g_haptics;
LedRing g_led;
DeviceModes g_modes;
Ota g_ota;

uint32_t g_last_activity_ms = 0;

// OTA is only allowed when the device is idle, unlocked, and the heater is
// provably off — passed to the OTA module as its safety gate.
bool otaSafeGate() {
  return g_machine.state() == State::kIdle && g_machine.heaterOff() &&
         !g_modes.locked();
}

// Map control state -> LED status, honoring lock + charging overlays.
LedStatus ledStatusFor() {
  if (g_modes.locked()) return LedStatus::kLocked;
  if (g_machine.battery().isCharging() && g_machine.state() == State::kIdle) {
    return LedStatus::kCharging;
  }
  switch (g_machine.state()) {
    case State::kIdle:          return LedStatus::kIdle;
    case State::kHeating:       return LedStatus::kHeating;
    case State::kReady:         return LedStatus::kReady;
    case State::kActiveSession: return LedStatus::kSession;
    case State::kCooldown:      return LedStatus::kCooldown;
    case State::kFault:         return LedStatus::kFault;
  }
  return LedStatus::kIdle;
}

void applyModeToUx() {
  g_led.setBrightness(g_modes.ledBrightness());
  g_haptics.setEnabled(g_modes.hapticsEnabled());
}

// Button gesture handling. One button drives the whole device:
//   single tap  -> start (auto-selected profile) / stop / ack fault
//   double tap  -> cycle device mode (normal/stealth/party)
//   triple tap  -> toggle child-lock
//   hold        -> boost: start on the highest preset from idle
void handleGesture(Gesture g) {
  if (g == Gesture::kNone) return;
  g_last_activity_ms = millis();

  // While locked, only a triple-tap (unlock) is honored.
  if (g_modes.locked() && g != Gesture::kTripleTap) {
    g_haptics.play(HapticPattern::kFault);
    return;
  }

  switch (g) {
    case Gesture::kSingleTap:
      switch (g_machine.state()) {
        case State::kIdle:
          if (g_machine.canStart()) {
            // Auto-detected atomizer picks the starting profile.
            g_machine.requestStart(g_machine.atomizer().suggestedProfileSlot());
            g_haptics.play(HapticPattern::kTick);
          } else {
            g_haptics.play(HapticPattern::kFault);
          }
          break;
        case State::kFault:
          g_machine.acknowledgeFault();
          g_haptics.play(HapticPattern::kTick);
          break;
        default:
          g_machine.requestStop();
          g_haptics.play(HapticPattern::kTick);
          break;
      }
      break;

    case Gesture::kDoubleTap:
      g_modes.cycleMode();
      applyModeToUx();
      g_haptics.play(HapticPattern::kTick);
      break;

    case Gesture::kTripleTap:
      g_modes.toggleLock();
      applyModeToUx();
      g_haptics.play(HapticPattern::kReady);
      break;

    case Gesture::kHold:
      if (g_machine.canStart()) {
        g_machine.requestStart(static_cast<uint8_t>(ProfileId::kBoost));
        g_haptics.play(HapticPattern::kReady);
      }
      break;

    default:
      break;
  }
}

void maybeSleep(uint32_t now_ms) {
  bool idle = g_machine.state() == State::kIdle && !g_machine.battery().isCharging();
  if (idle && now_ms - g_last_activity_ms >= cfg::IDLE_SLEEP_TIMEOUT_MS) {
    // Wake on the action button (active-low) to resume from deep sleep.
    esp_sleep_enable_ext0_wakeup(static_cast<gpio_num_t>(cfg::PIN_BUTTON), 0);
    esp_deep_sleep_start();
  }
}
}  // namespace

void setup() {
  Serial.begin(115200);
  pinMode(cfg::PIN_BUTTON, INPUT_PULLUP);
  Wire.begin(cfg::PIN_I2C_SDA, cfg::PIN_I2C_SCL);

  g_modes.begin();
  g_machine.begin();
  g_display.begin();
  g_input.begin();
  g_haptics.begin();
  g_led.begin();
  g_ota.begin(otaSafeGate);
  g_ble.begin(&g_machine, &g_modes, &g_ota);

  applyModeToUx();
  g_last_activity_ms = millis();
}

void loop() {
  uint32_t now_ms = millis();

  bool pressed = digitalRead(cfg::PIN_BUTTON) == LOW;
  handleGesture(g_input.poll(pressed, now_ms));

  g_machine.update(now_ms);

  // Ready/fault get a haptic cue as they're entered. Cheap edge-detect on the
  // observable state keeps this out of the control code.
  static State prev_state = State::kIdle;
  if (g_machine.state() != prev_state) {
    if (g_machine.state() == State::kReady) g_haptics.play(HapticPattern::kReady);
    if (g_machine.state() == State::kFault) g_haptics.play(HapticPattern::kFault);
    prev_state = g_machine.state();
    g_last_activity_ms = now_ms;
  }

  g_haptics.update(now_ms);
  g_led.update(ledStatusFor(), g_machine.heatingProgress(), now_ms);
  g_display.update(g_machine, now_ms);
  g_ble.update(now_ms);

  maybeSleep(now_ms);
  delay(cfg::CONTROL_LOOP_MS);
}
