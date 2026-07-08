#include "heater_control.h"

#include <Arduino.h>
#include <algorithm>

#include "config.h"

void HeaterControl::begin() {
  ledcSetup(cfg::PWM_CHANNEL, cfg::PWM_FREQ_HZ, cfg::PWM_RESOLUTION_BITS);
  ledcAttachPin(cfg::PIN_HEATER_PWM, cfg::PWM_CHANNEL);
  writeDuty(0.0f);
}

void HeaterControl::setTarget(float target_f) { target_f_ = target_f; }

void HeaterControl::setEnabled(bool enabled) {
  enabled_ = enabled;
  if (!enabled) {
    integral_ = 0.0f;
    prev_error_ = 0.0f;
    writeDuty(0.0f);
  }
}

void HeaterControl::update(float current_f, uint32_t now_ms) {
  if (!enabled_) {
    return;
  }
  float dt_s = prev_update_ms_ == 0 ? cfg::CONTROL_LOOP_MS / 1000.0f
                                    : (now_ms - prev_update_ms_) / 1000.0f;
  prev_update_ms_ = now_ms;
  if (dt_s <= 0.0f) {
    return;
  }

  float error = target_f_ - current_f;

  // Rapid-heat: while still far below target, drive near-full power instead of
  // letting the PID ramp gently. Hand off to the PID once inside the band so
  // we approach target under control and don't overshoot.
  if (error > cfg::RAPID_HEAT_HANDOFF_F) {
    integral_ = 0.0f;       // don't accumulate windup during the open-loop dash
    prev_error_ = error;
    writeDuty(cfg::RAPID_HEAT_DUTY);
    return;
  }

  integral_ += error * dt_s;
  // Clamp integral so a long cold-start ramp can't windup the term into a
  // multi-second overshoot once the sensor catches up.
  integral_ = std::clamp(integral_, -200.0f, 200.0f);
  float derivative = (error - prev_error_) / dt_s;
  prev_error_ = error;

  float output = cfg::PID_KP * error + cfg::PID_KI * integral_ + cfg::PID_KD * derivative;
  writeDuty(std::clamp(output / 100.0f, 0.0f, 1.0f));
}

void HeaterControl::writeDuty(float duty_0_to_1) {
  duty_ = duty_0_to_1;
  uint32_t max_count = (1u << cfg::PWM_RESOLUTION_BITS) - 1;
  ledcWrite(cfg::PWM_CHANNEL, static_cast<uint32_t>(duty_0_to_1 * max_count));
}
