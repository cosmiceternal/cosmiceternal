#include "state_machine.h"

#include <Arduino.h>
#include <algorithm>

#include "config.h"

void StateMachine::begin() {
  profiles::begin();
  stats_.begin();
  temp_sensor_.begin();
  heater_.begin();
  battery_.begin();
  atomizer_.begin();
  draw_sensor_.begin();
}

void StateMachine::enter(State next, uint32_t now_ms) {
  state_ = next;
  state_entered_ms_ = now_ms;
}

bool StateMachine::canStart() const {
  return state_ == State::kIdle && !battery_.isLockedOut() && atomizer_.present();
}

void StateMachine::requestStart(uint8_t profile_slot) {
  // Requests can arrive from a BLE callback between control ticks; anchor to
  // real time so session timing doesn't ride on a stale cached now_ms_.
  now_ms_ = millis();
  if (!canStart()) {
    return;
  }
  profile_slot_ = std::min<uint8_t>(profile_slot, profiles::totalSlots() - 1);
  const SessionProfile& p = profiles::get(profile_slot_);
  active_target_f_ = p.start_f;   // guided profiles begin at start_f
  session_peak_f_ = temp_sensor_.temperatureF();
  heater_.setTarget(active_target_f_);
  heater_.setEnabled(true);
  safety_.armForSession(now_ms_);
  enter(State::kHeating, now_ms_);
}

void StateMachine::requestStop() {
  now_ms_ = millis();
  if (state_ == State::kIdle || state_ == State::kFault) {
    return;
  }
  // A completed session (reached Ready or beyond) counts toward usage/cleaning.
  if (state_ == State::kReady || state_ == State::kActiveSession) {
    uint32_t duration = now_ms_ - state_entered_ms_;
    stats_.recordSession(session_peak_f_, duration, day_index_);
  }
  heater_.setEnabled(false);
  safety_.disarm();
  enter(State::kCooldown, now_ms_);
}

void StateMachine::acknowledgeFault() {
  now_ms_ = millis();
  if (state_ != State::kFault) {
    return;
  }
  safety_.clearFault();
  enter(State::kIdle, now_ms_);
}

float StateMachine::readEnclosureF() const {
  // Placeholder: real code reads the body NTC on PIN_ENCLOSURE_NTC and applies
  // a Steinhart-Hart conversion. Ambient default keeps safety well-behaved.
  return 75.0f;
}

SafetyInputs StateMachine::gatherSafetyInputs() const {
  SafetyInputs in;
  in.pack_volts = battery_.volts();
  in.heater_amps = 0.0f;  // hook: current-sense ADC read on PIN_HEATER_ISENSE
  in.enclosure_f = readEnclosureF();
  in.atomizer_ohms = atomizer_.ohms();
  in.heater_energized = heater_.isEnergized();
  return in;
}

float StateMachine::heatingProgress() const {
  if (state_ != State::kHeating) {
    return state_ == State::kReady || state_ == State::kActiveSession ? 1.0f : 0.0f;
  }
  float start = 75.0f;  // roughly ambient
  float span = active_target_f_ - start;
  if (span <= 0.0f) {
    return 1.0f;
  }
  return std::clamp((temp_sensor_.temperatureF() - start) / span, 0.0f, 1.0f);
}

void StateMachine::update(uint32_t now_ms) {
  now_ms_ = now_ms;
  temp_sensor_.update(now_ms);
  battery_.update(now_ms);
  atomizer_.update(now_ms);
  draw_sensor_.update(now_ms);

  if (temp_sensor_.temperatureF() > session_peak_f_) {
    session_peak_f_ = temp_sensor_.temperatureF();
  }

  // Safety is checked every tick whenever the heater could be on, independent
  // of sub-state. A fault here always wins and force-shuts the heater.
  if (state_ == State::kHeating || state_ == State::kReady ||
      state_ == State::kActiveSession) {
    if (safety_.check(temp_sensor_, gatherSafetyInputs(), now_ms)) {
      heater_.setEnabled(false);
      safety_.disarm();
      enter(State::kFault, now_ms);
      return;
    }
  }

  const SessionProfile& p = profiles::get(profile_slot_);

  switch (state_) {
    case State::kIdle:
      break;

    case State::kHeating:
      heater_.update(temp_sensor_.temperatureF(), now_ms);
      if (temp_sensor_.temperatureF() >= p.start_f - 5.0f) {
        enter(State::kReady, now_ms);
      }
      break;

    case State::kReady: {
      uint32_t hold_elapsed = now_ms - state_entered_ms_;
      // Guided profiles walk the target across the hold window.
      active_target_f_ = profiles::targetAtHoldElapsed(p, hold_elapsed);
      heater_.setTarget(active_target_f_);
      heater_.update(temp_sensor_.temperatureF(), now_ms);

      // React to an inhale: count the hit (if under the daily limit) and slip
      // into the active-session sub-state for as long as the draw lasts.
      if (draw_sensor_.drawStarted() && stats_.canHit(day_index_)) {
        stats_.recordHit(day_index_);
        enter(State::kActiveSession, now_ms);
        break;
      }
      if (hold_elapsed >= p.hold_ms) {
        requestStop();
      }
      break;
    }

    case State::kActiveSession: {
      uint32_t hold_elapsed = now_ms - state_entered_ms_;
      active_target_f_ = profiles::targetAtHoldElapsed(p, hold_elapsed);
      heater_.setTarget(active_target_f_);
      heater_.update(temp_sensor_.temperatureF(), now_ms);
      if (draw_sensor_.drawEnded()) {
        enter(State::kReady, now_ms);
      }
      break;
    }

    case State::kCooldown:
      // Passive: heater off, wait for temp to drop before another session so
      // we don't stack sessions on a still-hot bowl.
      if (temp_sensor_.temperatureF() <= 150.0f) {
        enter(State::kIdle, now_ms);
      }
      break;

    case State::kFault:
      break;  // stays until acknowledgeFault()
  }
}
