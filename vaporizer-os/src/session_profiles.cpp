#include "session_profiles.h"

namespace {
constexpr SessionProfile kProfiles[] = {
    {"Flavor",   440.0f, 15000, 20000},
    {"Standard", 500.0f, 12000, 25000},
    {"Boost",    575.0f, 9000,  15000},
};
}  // namespace

const SessionProfile& profiles::get(ProfileId id) {
  return kProfiles[static_cast<uint8_t>(id)];
}
