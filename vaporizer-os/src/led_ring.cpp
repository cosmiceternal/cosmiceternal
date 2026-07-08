#include "led_ring.h"

#include <Adafruit_NeoPixel.h>
#include <Arduino.h>
#include <algorithm>
#include <cmath>

#include "config.h"

namespace {
constexpr uint32_t kRenderIntervalMs = 33;  // ~30 fps
Adafruit_NeoPixel g_pixels(cfg::LED_RING_COUNT, cfg::PIN_LED_RING,
                           NEO_GRB + NEO_KHZ800);

// A slow triangle wave 0..1 for breathing/pulsing effects.
float breathe(uint32_t now_ms, uint32_t period_ms) {
  float phase = (now_ms % period_ms) / static_cast<float>(period_ms);
  return 1.0f - std::fabs(phase * 2.0f - 1.0f);
}
}  // namespace

void LedRing::begin() {
  g_pixels.begin();
  g_pixels.clear();
  g_pixels.show();
}

void LedRing::fill(uint8_t r, uint8_t g, uint8_t b) {
  float s = brightness_ / 255.0f;
  uint32_t c = g_pixels.Color(r * s, g * s, b * s);
  for (int i = 0; i < cfg::LED_RING_COUNT; i++) {
    g_pixels.setPixelColor(i, c);
  }
  g_pixels.show();
}

void LedRing::fillProgress(float progress, uint8_t r, uint8_t g, uint8_t b) {
  progress = std::clamp(progress, 0.0f, 1.0f);
  float s = brightness_ / 255.0f;
  uint32_t on = g_pixels.Color(r * s, g * s, b * s);
  int lit = static_cast<int>(progress * cfg::LED_RING_COUNT + 0.5f);
  for (int i = 0; i < cfg::LED_RING_COUNT; i++) {
    g_pixels.setPixelColor(i, i < lit ? on : 0);
  }
  g_pixels.show();
}

void LedRing::update(LedStatus status, float progress, uint32_t now_ms) {
  if (now_ms - last_render_ms_ < kRenderIntervalMs) {
    return;
  }
  last_render_ms_ = now_ms;

  switch (status) {
    case LedStatus::kOff:
    case LedStatus::kIdle:
      g_pixels.clear();
      g_pixels.show();
      break;
    case LedStatus::kHeating:
      fillProgress(progress, 255, 90, 0);  // amber, fills as it heats
      break;
    case LedStatus::kReady: {
      float b = 0.3f + 0.7f * breathe(now_ms, 1600);
      fill(0, static_cast<uint8_t>(200 * b), static_cast<uint8_t>(60 * b));
      break;
    }
    case LedStatus::kSession:
      fill(0, 180, 60);  // steady green
      break;
    case LedStatus::kCooldown: {
      float b = breathe(now_ms, 2400);
      fill(static_cast<uint8_t>(80 * b), static_cast<uint8_t>(40 * b), 0);
      break;
    }
    case LedStatus::kFault:
      fill((now_ms / 250) % 2 ? 255 : 0, 0, 0);  // red flash
      break;
    case LedStatus::kCharging:
      fillProgress(breathe(now_ms, 2000), 0, 120, 220);  // blue sweep
      break;
    case LedStatus::kLocked:
      fill(60, 0, 90);  // dim purple
      break;
  }
}
