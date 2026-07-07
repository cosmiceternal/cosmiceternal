#include "display.h"

#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Arduino.h>

namespace {
constexpr uint32_t kRenderIntervalMs = 200;
constexpr int kScreenWidth = 128;
constexpr int kScreenHeight = 64;
Adafruit_SSD1306 g_oled(kScreenWidth, kScreenHeight, &Wire, -1);

const char* stateLabel(State s) {
  switch (s) {
    case State::kIdle: return "IDLE";
    case State::kHeating: return "HEATING";
    case State::kReady: return "READY";
    case State::kActiveSession: return "SESSION";
    case State::kCooldown: return "COOLDOWN";
    case State::kFault: return "FAULT";
  }
  return "?";
}
}  // namespace

void Display::begin() {
  g_oled.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  g_oled.clearDisplay();
  g_oled.display();
}

void Display::update(const StateMachine& machine, uint32_t now_ms) {
  if (now_ms - last_render_ms_ < kRenderIntervalMs) {
    return;
  }
  last_render_ms_ = now_ms;

  g_oled.clearDisplay();
  g_oled.setTextSize(1);
  g_oled.setTextColor(SSD1306_WHITE);
  g_oled.setCursor(0, 0);
  g_oled.printf("%s\n", stateLabel(machine.state()));
  g_oled.printf("%.0fF -> %.0fF\n", machine.currentTempF(), machine.targetTempF());
  g_oled.printf("batt %.0f%%\n", machine.batteryPercent());
  g_oled.display();
}
