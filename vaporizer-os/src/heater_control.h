#pragma once

#include <cstdint>

// PID loop driving heater PWM duty toward a target temperature. Has no
// concept of "is this safe" — that's safety.cpp's job, layered on top.
class HeaterControl {
 public:
  void begin();

  void setTarget(float target_f);
  void setEnabled(bool enabled);

  // current_f: latest filtered sensor reading. Called once per control tick.
  void update(float current_f, uint32_t now_ms);

  float dutyFraction() const { return duty_; }  // 0.0-1.0, for telemetry/UI

 private:
  void writeDuty(float duty_0_to_1);

  float target_f_ = 0.0f;
  float duty_ = 0.0f;
  float integral_ = 0.0f;
  float prev_error_ = 0.0f;
  uint32_t prev_update_ms_ = 0;
  bool enabled_ = false;
};
