#pragma once

#include "state_machine.h"

// Renders status to the OLED. Deliberately dumb — reads state_machine,
// draws, nothing else. Keeps UI churn out of the control/safety code.
class Display {
 public:
  void begin();
  void update(const StateMachine& machine, uint32_t now_ms);

 private:
  uint32_t last_render_ms_ = 0;
};
