#include "../../include/wright_fisher.h"

namespace wfes {
namespace wright_fisher {

wfes::wrightfisher::absorption_type WrightFisher::to_absorption_type(ModelType model_type) {
    switch (model_type) {
        case ModelType::ABSORPTION:
            return wfes::wrightfisher::BOTH_ABSORBING;
        case ModelType::FIXATION:
            return wfes::wrightfisher::FIXATION_ONLY;
        case ModelType::NON_ABSORBING:
            return wfes::wrightfisher::NON_ABSORBING;
        case ModelType::ESTABLISHMENT:
        case ModelType::FUNDAMENTAL:
        case ModelType::EQUILIBRIUM:
        case ModelType::ALLELE_AGE:
            // These modes use BOTH_ABSORBING matrices internally
            return wfes::wrightfisher::BOTH_ABSORBING;
        default:
            throw std::runtime_error("Unknown model type");
    }
}

} // namespace wright_fisher
} // namespace wfes