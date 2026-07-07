#include "state_machine.h"

#include "config.h"

void StateMachine::begin() {
  temp_sensor_.begin();
  heater_.begin();
  battery_.begin();
}

void StateMachine::enter(State next, uint32_t now_ms) {
  state_ = next;
  state_entered_ms_ = now_ms;
}

void StateMachine::requestStart(ProfileId profile) {
  if (state_ != State::kIdle) {
    return;
  }
  profile_ = profile;
  const SessionProfile& p = profiles::get(profile_);
  heater_.setTarget(p.target_f);
  heater_.setEnabled(true);
  safety_.armForSession(state_entered_ms_);
  enter(State::kHeating, state_entered_ms_);
}

void StateMachine::requestStop() {
  if (state_ == State::kIdle || state_ == State::kFault) {
    return;
  }
  heater_.setEnabled(false);
  safety_.disarm();
  enter(State::kCooldown, state_entered_ms_);
}

void StateMachine::acknowledgeFault() {
  if (state_ != State::kFault) {
    return;
  }
  safety_.clearFault();
  enter(State::kIdle, state_entered_ms_);
}

void StateMachine::update(uint32_t now_ms) {
  temp_sensor_.update(now_ms);
  battery_.update(now_ms);

  // Safety is checked every tick while the heater could plausibly be on,
  // independent of which sub-state we're in — a fault here always wins.
  if (state_ == State::kHeating || state_ == State::kReady || state_ == State::kActiveSession) {
    if (safety_.check(temp_sensor_, now_ms)) {
      heater_.setEnabled(false);
      safety_.disarm();
      enter(State::kFault, now_ms);
      return;
    }
  }

  switch (state_) {
    case State::kIdle:
      break;

    case State::kHeating: {
      heater_.update(temp_sensor_.temperatureF(), now_ms);
      const SessionProfile& p = profiles::get(profile_);
      if (temp_sensor_.temperatureF() >= p.target_f - 5.0f) {
        enter(State::kReady, now_ms);
      }
      break;
    }

    case State::kReady: {
      heater_.update(temp_sensor_.temperatureF(), now_ms);
      // A real build would transition to kActiveSession on an inhale sensor
      // (pressure/flow switch) or a button press; left as a hook here.
      const SessionProfile& p = profiles::get(profile_);
      if (now_ms - state_entered_ms_ >= p.hold_ms) {
        requestStop();
      }
      break;
    }

    case State::kActiveSession: {
      heater_.update(temp_sensor_.temperatureF(), now_ms);
      break;
    }

    case State::kCooldown: {
      // Passive: heater is off, just wait for temp to drop before allowing
      // another session (avoids stacking sessions on a still-hot bowl).
      if (temp_sensor_.temperatureF() <= 150.0f) {
        enter(State::kIdle, now_ms);
      }
      break;
    }

    case State::kFault:
      // Stays here until acknowledgeFault() is called (e.g. via BLE/button).
      break;
  }
}
