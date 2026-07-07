#include <Arduino.h>
#include <Wire.h>

#include "ble_service.h"
#include "config.h"
#include "display.h"
#include "state_machine.h"

namespace {
StateMachine g_machine;
BleService g_ble;
Display g_display;

bool g_button_prev_pressed = false;

void pollButton(uint32_t now_ms) {
  bool pressed = digitalRead(cfg::PIN_BUTTON) == LOW;
  if (pressed && !g_button_prev_pressed) {
    // Single button, dual-purpose: start a Standard session from idle,
    // or stop/acknowledge whatever's currently active.
    switch (g_machine.state()) {
      case State::kIdle:
        g_machine.requestStart(ProfileId::kStandard);
        break;
      case State::kFault:
        g_machine.acknowledgeFault();
        break;
      default:
        g_machine.requestStop();
        break;
    }
  }
  g_button_prev_pressed = pressed;
}
}  // namespace

void setup() {
  Serial.begin(115200);
  pinMode(cfg::PIN_BUTTON, INPUT_PULLUP);
  pinMode(cfg::PIN_HAPTIC, OUTPUT);
  Wire.begin(cfg::PIN_I2C_SDA, cfg::PIN_I2C_SCL);

  g_machine.begin();
  g_display.begin();
  g_ble.begin(&g_machine);
}

void loop() {
  uint32_t now_ms = millis();

  pollButton(now_ms);
  g_machine.update(now_ms);
  g_display.update(g_machine, now_ms);
  g_ble.update(now_ms);

  delay(cfg::CONTROL_LOOP_MS);
}
