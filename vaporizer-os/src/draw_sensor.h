#pragma once

#include <cstdint>

// Inhale ("draw") detection via a pressure/flow sensor in the airpath. Lets
// the device react to a hit — brighten LEDs, hold temp, count the hit, and
// enable guided auto-draw sessions. Optional hardware; if PIN_DRAW_SENSE is
// unpopulated the sensor simply never reports a draw.
class DrawSensor {
 public:
  void begin();
  void update(uint32_t now_ms);

  bool isDrawing() const { return drawing_; }
  // True on the tick a draw starts / ends, for edge-triggered reactions.
  bool drawStarted() const { return draw_started_; }
  bool drawEnded() const { return draw_ended_; }

 private:
  float readFlow();

  bool drawing_ = false;
  bool draw_started_ = false;
  bool draw_ended_ = false;
  float baseline_ = 0.0f;
  uint32_t last_read_ms_ = 0;
};
