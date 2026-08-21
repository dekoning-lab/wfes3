#ifndef WFES_CLI_INITIAL_DISTRIBUTION_H
#define WFES_CLI_INITIAL_DISTRIBUTION_H

/**
 * @file initial_distribution.h
 * @brief Load a user-supplied initial state distribution, and check it.
 *
 * Every tool builds an initial vector over its own state space, and those
 * spaces differ: the transient states 1..2N-1 for time_dist, 0..2N-1 where a
 * boundary is retained, 0..2N for a non-absorbing model, and the concatenated
 * per-model blocks of a switching model. A file that is right for one tool is
 * wrong for another, and the failure mode for a wrong length is an out-of-range
 * read -- which in this codebase means an Eigen assertion naming neither the
 * file nor the tool (the same failure wfes_sequential used to give for a short
 * -u vector).
 *
 * So the length is checked against the space it will be used in, and the error
 * says what was expected and what that space is.
 */

#include <string>
#include <stdexcept>
#include <cmath>
#include <iostream>
#include "types.h"
#include "parsing.h"

namespace wfes {
namespace cli {

/**
 * @param path          CSV column of probabilities
 * @param expected_size number of states in the tool's own space
 * @param space_desc    what those states are, for the error message
 * @return the distribution, normalised to sum to 1
 */
inline dvec load_initial_distribution(const std::string &path,
                                      llong expected_size,
                                      const char *space_desc) {
    dvec p = load_csv_col_vector(path);

    if (p.size() != expected_size) {
        throw std::runtime_error(
            "Initial distribution (--initial) has " + std::to_string(p.size()) +
            " entries but this model has " + std::to_string(expected_size) +
            " states (" + space_desc + "). Supply one probability per state.");
    }
    if ((p.array() < 0).any()) {
        throw std::runtime_error(
            "Initial distribution (--initial) contains a negative entry; "
            "every entry must be a probability.");
    }

    const double total = p.sum();
    if (!std::isfinite(total) || total <= 0) {
        throw std::runtime_error(
            "Initial distribution (--initial) sums to " + std::to_string(total) +
            "; it must contain positive probability.");
    }
    // Renormalising silently would hide a malformed file, so say so.
    if (std::abs(total - 1.0) > 1e-9) {
        std::cerr << "Warning: initial distribution sums to " << total
                  << ", not 1; renormalising.\n";
        p /= total;
    }
    return p;
}

} // namespace cli
} // namespace wfes

#endif // WFES_CLI_INITIAL_DISTRIBUTION_H
