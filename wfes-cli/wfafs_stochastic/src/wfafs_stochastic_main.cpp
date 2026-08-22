#include <iostream>
#include <vector>
#include <string>
#include <fstream>
#include <sstream>
#include <utility>
#include <chrono>
#include <cmath>
#include <iomanip>
#include <limits>
#include <stdexcept>
#include "backend_config.h"
#ifdef WFES_USE_MKL
#include <mkl.h>
#endif

#ifdef OMP
// Declarations for omp_set_num_threads. This currently arrives transitively via
// Eigen/Core (which includes <omp.h> whenever _OPENMP is defined), but relying
// on that is fragile -- it would break silently if Eigen stopped doing it or if
// the include order changed. Ask for it directly.
#include <omp.h>
#endif

// Include the CLI utilities
#include "args_parser.hpp"
#include "output_formatter.hpp"

// Include the core library components
#include "types.h"

// Platform-agnostic constants
#ifndef WFES_USE_MKL
    constexpr llong MKL_PARDISO_MATRIX_TYPE_REAL_UNSYMMETRIC = 11;
    constexpr llong MKL_PARDISO_MSG_VERBOSE = 1;
    constexpr llong MKL_PARDISO_MSG_QUIET = 0;
#endif
#include "wright_fisher.h"

// Include direct references to core library components with CLI adaptations
#include "model/wright-fisher/wrightFisher.h"
#include "model/sparse-matrix/sparseMatrixFactory.h"
#include "model/solver/solverFactory.h"

// For loading CSV files and utilities (CLI versions)
#include "parsing.h"
#include "utils.h"

namespace WF = wrightfisher;
using namespace std;
using namespace wfes;
using namespace wfes::cli;

// Type aliases for common types
using time_point = std::chrono::time_point<std::chrono::system_clock>;
using time_diff = std::chrono::duration<double>;

/**
 * Parse a vector of longs from a comma-separated string
 * Format: "100,200,300" -> lvec([100, 200, 300])
 */
lvec parse_long_vector(const std::string& str) {
    std::vector<llong> values;
    std::stringstream ss(str);
    std::string item;
    
    while (std::getline(ss, item, ',')) {
        // Trim whitespace
        item.erase(0, item.find_first_not_of(" \t"));
        item.erase(item.find_last_not_of(" \t") + 1);
        if (!item.empty()) {
            values.push_back(std::stoll(item));
        }
    }
    
    lvec result(values.size());
    for (size_t i = 0; i < values.size(); ++i) {
        result(i) = values[i];
    }
    return result;
}

/**
 * Parse a vector of doubles from a comma-separated string
 * Format: "1.0,2.0,3.0" -> dvec([1.0, 2.0, 3.0])
 */
dvec parse_vector(const std::string& str) {
    std::vector<double> values;
    std::stringstream ss(str);
    std::string item;
    
    while (std::getline(ss, item, ',')) {
        // Trim whitespace
        item.erase(0, item.find_first_not_of(" \t"));
        item.erase(item.find_last_not_of(" \t") + 1);
        if (!item.empty()) {
            values.push_back(std::stod(item));
        }
    }
    
    dvec result(values.size());
    for (size_t i = 0; i < values.size(); ++i) {
        result(i) = values[i];
    }
    return result;
}

/**
 * Format a double at round-trip precision.
 *
 * std::to_string fixes 6 decimal places, which renders every realistic
 * mutation rate as "0.000000" -- useless in a diagnostic whose whole job is to
 * show the user the offending number. Matches num_str() in
 * wfafs_deterministic_main.cpp and wfes_sequential_main.cpp.
 */
static std::string num_str(double x) {
    std::ostringstream os;
    os << std::setprecision(std::numeric_limits<double>::max_digits10) << x;
    return os.str();
}

/**
 * Refuse a model whose Wright-Fisher matrix cannot be built.
 *
 * Copied from require_usable_matrix() in wfafs_deterministic_main.cpp, where
 * the same NON_ABSORBING failure mode was found first. (It is static there, so
 * there is nothing to call; lifting it into a shared header is the clean move
 * and is recorded as a wish rather than done here, because that header belongs
 * to another change in flight.)
 *
 * Unlike the absorbing models, this tool builds every matrix with
 * WF::NON_ABSORBING, which keeps all 2N+1 rows -- including the two boundary
 * rows that wfes_single and friends drop out of Q. wfes-lib builds each row in
 * log space (wrightFisher.cpp, binom_row): it starts from
 * ld_binom(start, size, p), whose terms are k*log(p) and (size-k)*log1p(-p),
 * and steps along the row by adding log(p) - log(1-p). Both are defined only
 * for a success probability strictly inside (0, 1):
 *
 *   - p = 0 makes k*log(p) the product 0 * -inf, i.e. nan;
 *   - p = 1 makes the row's first term -inf while the step is +inf, and
 *     -inf + inf is nan.
 *
 * Either way the row sums to nan, `r.Q /= r.weight` turns every entry of the
 * row nan, and the nan then reaches every state of the spectrum -- the sparse
 * product multiplies the poisoned row by a coefficient of 0, and 0 * nan is
 * nan, not 0.
 *
 * psi_diploid() returns exactly v for row 0 and exactly 1-u for row 2N, so the
 * boundary rows are degenerate precisely when v is zero, or when 1-u rounds to
 * 1.0. That second case is the one worth being careful about: it is NOT just
 * u == 0. Any u below about 1.1e-16 -- 1e-17, 1e-30, values every range check
 * in this tool accepts as an ordinary small mutation rate -- rounds 1-u to
 * exactly 1.0 and produced an all-nan spectrum. So the test is on the psi
 * value the matrix builder will actually see, not on u and v.
 *
 * Non-finite s or h are refused for a related but distinct reason: psi_diploid
 * clamps the two fitnesses with fmax(w, 1e-30), and fmax returns its non-NaN
 * operand, so `--selection nan` was silently computed as a lethal homozygote
 * (s = -1) and reported at exit 0 as though it were the model asked for. An
 * infinite s instead drives w_bar to inf and every psi to nan.
 *
 * `Nx` is narrowed to int here because WF::Single() takes int, so this checks
 * exactly the value the builder will use.
 *
 * `where` carries the one thing a caller in THIS tool must get right: which
 * set of rates it is checking. There are two matrices and they are built from
 * different numbers -- see the two call sites in main().
 */
static void require_usable_matrix(llong Nx, double s, double h, double u,
                                  double v, const std::string& where) {
    auto bad = [&where](const std::string& msg) {
        throw std::runtime_error("Cannot build the " + where +
                                 " transition matrix: " + msg);
    };

    if (!std::isfinite(s)) {
        bad("selection coefficient s = " + num_str(s) + " is not a finite "
            "number. psi_diploid() clamps the fitnesses with fmax(), which "
            "discards a NaN rather than propagating it, so this would be "
            "computed as some other model's answer. Check --selection (-s).");
    }
    if (!std::isfinite(h)) {
        bad("dominance coefficient h = " + num_str(h) + " is not a finite "
            "number. psi_diploid() clamps the fitnesses with fmax(), which "
            "discards a NaN rather than propagating it, so this would be "
            "computed as some other model's answer. Check --dominance (-h).");
    }
    if (!std::isfinite(u)) {
        bad("backward mutation rate u = " + num_str(u) +
            " is not a finite number. Check --backward-mu (-u).");
    }
    if (!std::isfinite(v)) {
        bad("forward mutation rate v = " + num_str(v) +
            " is not a finite number. Check --forward-mu (-v).");
    }

    const int N = static_cast<int>(Nx);
    const int last = 2 * N;

    // Row 0: psi is exactly v. Zero forward mutation means a lost allele can
    // never reappear, which is a perfectly sensible model -- but not one this
    // matrix builder can express, so refuse rather than print its nan.
    const double psi_lost = WF::psi_diploid(0, N, s, h, u, v);
    if (!std::isfinite(psi_lost) || psi_lost <= 0.0) {
        bad("the row for 0 copies has binomial success probability " +
            num_str(psi_lost) + ", which is not strictly inside (0, 1), so "
            "wfes-lib's log-space row construction yields nan for that row "
            "and nan then spreads to the whole spectrum. That probability is "
            "the forward mutation rate v = " + num_str(v) + " exactly; this "
            "NON_ABSORBING model keeps the 0-copy row and so needs v > 0. "
            "Give --forward-mu (-v) a positive rate.");
    }

    // Row 2N: psi is exactly 1-u, and 1-u == 1.0 for every u below ~1.1e-16.
    const double psi_fixed = WF::psi_diploid(last, N, s, h, u, v);
    if (!std::isfinite(psi_fixed) || psi_fixed >= 1.0) {
        bad("the row for " + std::to_string(last) +
            " copies has binomial success probability " + num_str(psi_fixed) +
            ", which is not strictly inside (0, 1), so wfes-lib's log-space "
            "row construction yields nan for that row and nan then spreads to "
            "the whole spectrum. That probability is 1 - u for the backward "
            "mutation rate u = " + num_str(u) + "; 1 - u rounds to exactly 1 "
            "for any u below about 1.1e-16. This NON_ABSORBING model keeps "
            "the fixed row and so needs a --backward-mu (-u) large enough "
            "that 1 - u is representably below 1.");
    }

    // The interior rows cannot reach 0 or 1 for finite parameters, but they
    // are cheap to check (O(N) against the builder's O(N^2)) and a bad one
    // here would be exactly as invisible as the two above.
    for (int i = 1; i < last; ++i) {
        const double psi = WF::psi_diploid(i, N, s, h, u, v);
        if (!std::isfinite(psi) || psi <= 0.0 || psi >= 1.0) {
            bad("the row for " + std::to_string(i) +
                " copies has binomial success probability " + num_str(psi) +
                ", which is not strictly inside (0, 1), so wfes-lib's "
                "log-space row construction yields nan for that row and nan "
                "then spreads to the whole spectrum. Check --selection (-s), "
                "--dominance (-h), --backward-mu (-u) and --forward-mu (-v) "
                "for this model.");
        }
    }
}

dvec load_initial_distribution(const string& filename) {
    ifstream file(filename);
    if (!file.is_open()) {
        throw std::runtime_error("Error: Cannot open initial distribution file: " + filename);
    }
    
    vector<double> values;
    string line;
    while (getline(file, line)) {
        if (!line.empty()) {
            values.push_back(std::stod(line));
        }
    }
    
    dvec result(values.size());
    for (size_t i = 0; i < values.size(); ++i) {
        result(i) = values[i];
    }
    return result;
}

int main(int argc, char const *argv[]) {
    try {
        // Parse command line arguments using unified parser
        CommandLineOptions options = Args_Parser::parse_wfafs_stochastic_args(argc, argv);

        // Four of the output flags the shared parser offers name quantities this
        // model does not have. wfafs_stochastic builds a NON_ABSORBING switching
        // chain (WF::Switching below), so it has no absorbing state: W.R is
        // (size x 0), and extinction-, fixation- and timeout-conditional sojourn
        // times are undefined for a chain that never absorbs. The parser accepted
        // and stored all four paths and nothing ever read them, so the run exited
        // 0 having written no file -- indistinguishable, to a script, from having
        // written one. Refuse instead. (The Qt-era wfafs.cpp reached the same
        // conclusion: its R and B writes are commented out for this model.)
        const std::pair<const std::string*, const char*> unsupported_outputs[] = {
            {&options.output_R_path,     "--output-R (transient-to-absorbing matrix R)"},
            {&options.output_N_ext_path, "--output-N-ext (extinction-conditional sojourn times)"},
            {&options.output_N_fix_path, "--output-N-fix (fixation-conditional sojourn times)"},
            {&options.output_N_tmo_path, "--output-N-tmo (timeout-conditional sojourn times)"},
        };
        for (const auto& [path, description] : unsupported_outputs) {
            if (!path->empty()) {
                throw std::runtime_error(
                    std::string(description) + " is not produced by this tool: "
                    "wfafs_stochastic builds a non-absorbing Wright-Fisher chain "
                    "(no extinction or fixation state), so this quantity does not "
                    "exist for its model.");
            }
        }

        // Start timer if verbose
        time_point t_start, t_end;
        if (options.verbose) {
            t_start = std::chrono::system_clock::now();
        }
        
        // Parse vector parameters
        lvec population_sizes = parse_long_vector(options.population_sizes_str);
        dvec generations = parse_vector(options.generations_str);
        dvec factors = parse_vector(options.factors_str);
        llong n_models = population_sizes.size();
        
        // Parse optional vector parameters with defaults
        dvec s_unsc = options.selection_coefficients_str.empty() ? 
                      dvec::Constant(n_models, 0.0) : 
                      parse_vector(options.selection_coefficients_str);
        dvec h = options.dominance_coefficients_str.empty() ? 
                 dvec::Constant(n_models, 0.6) :  // Note: original uses 0.6 as default
                 parse_vector(options.dominance_coefficients_str);
        dvec u_unsc = options.backward_mutations_str.empty() ? 
                      dvec::Constant(n_models, 1e-9) : 
                      parse_vector(options.backward_mutations_str);
        dvec v_unsc = options.forward_mutations_str.empty() ? 
                      dvec::Constant(n_models, 1e-9) : 
                      parse_vector(options.forward_mutations_str);
        
        // One value per model.
        //
        // Nothing checked these lengths, and this was the only multi-model
        // tool in the suite where nothing did -- wfes_switching (:354),
        // wfes_sequential (:304), wfafs_deterministic and time_dist_sgv all
        // refuse a short vector by name. The shared parser knows about the
        // gap and defers to a check here that did not exist
        // ("Length disagreements are left to the main's require_len"), so the
        // advisory pass returned silently and no one else looked.
        //
        // Every line below is an Eigen coefficient-wise op or an indexed read
        // against n_models, so a short vector is an out-of-bounds read: an
        // assert-enabled build aborts with a raw Eigen assertion (exit 134,
        // naming no argument), and an NDEBUG build -- where that assert is
        // compiled out -- reads garbage rates, writes a nan-bearing
        // --output-Q file and then fails in the solver with "matrix is
        // singular", which points at the wrong thing entirely.
        //
        // The test is equality, not ">=": a LONG vector was the worst case of
        // the set, exiting 0 with plausible output and the extra value
        // silently discarded.
        auto require_len = [&](llong got, const char *flag, const char *name) {
            if (got != n_models) {
                throw std::runtime_error(
                    std::string(name) + " (" + flag + ") has " +
                    std::to_string(got) + " value(s) but there are " +
                    std::to_string(n_models) + " models (-N gave " +
                    std::to_string(n_models) + " population sizes). Supply one "
                    "comma-separated value per model");
            }
        };
        require_len(generations.size(), "-G", "Generations");
        require_len(factors.size(),     "-f", "Factors");
        require_len(s_unsc.size(),      "-s", "Selection coefficients");
        require_len(h.size(),           "-h", "Dominance coefficients");
        require_len(u_unsc.size(),      "-u", "Backward mutation rates");
        require_len(v_unsc.size(),      "-v", "Forward mutation rates");

        // Every factor divides N and G immediately below; a zero or
        // non-finite factor makes that inf, and casting inf to llong is
        // undefined behaviour (observed: exit 134 inside binom_row).
        for (llong i = 0; i < n_models; ++i) {
            if (!(factors(i) > 0) || !std::isfinite(factors(i))) {
                throw std::runtime_error(
                    "Scaling factor (-f) for model " + std::to_string(i + 1) +
                    " is " + num_str(factors(i)) +
                    "; each factor must be a finite positive number (N/f and "
                    "G/f are the model this tool actually solves)");
            }
        }

        // Apply scaling factors
        dvec ps_tmp = population_sizes.cast<double>().array() / factors.array();
        population_sizes = ps_tmp.cast<llong>();
        dvec t_tmp = generations.array() / factors.array();
        generations = t_tmp;
        
        // Scale mutation and selection by factors
        dvec s = s_unsc.array() * factors.array();
        dvec u = u_unsc.array() * factors.array();
        dvec v = v_unsc.array() * factors.array();

        // Starting copies (-p), against the state space this tool ACTUALLY
        // builds. The `initial[options.initial_count] = 1.0` branch ~150 lines
        // below subscripts a dvec of length 2*population_sizes[0] + 1 and
        // nothing bounded the subscript. Measured on the pre-fix binary at
        // -N 10 -G 100 -f 1 (state space 0..20): `-p 21` and `-p 100` each
        // exited 0 with an EMPTY stderr and an all-zero spectrum, byte-
        // identical to one another (md5 67a8cdc09afc78de4a47a3996ec264b5) --
        // so the number printed did not depend on what was asked for, and
        // nothing in the run said so. Under NDEBUG, which is how these
        // binaries ship, the write itself lands outside the vector.
        //
        // The bound has to be read off the RESCALED size, which is exactly why
        // it cannot sit in the parser beside its wfes_single sibling (see the
        // note at the matching site in args_parser.cpp): population_sizes has
        // already been divided by -f four lines above, and `-N 100 -f 10 -p
        // 150` is inside the typed 2N = 200 while indexing 150 into a 21-entry
        // vector. The parser refuses the half it can decide without the model
        // (a negative -p, which used to collide with the "flag absent"
        // sentinel); this is the half that needs the model.
        //
        // Valid counts are 0..2N INCLUSIVE. This tool builds WF::NON_ABSORBING,
        // which keeps every one of the 2N+1 rows, so the boundary counts 0 and
        // 2N are ordinary states here -- unlike the both-absorbing models,
        // where wfes_single's parser refuses -p 0 as an absorbing start.
        //
        // Conditioned on -p being the start this run will actually use, which
        // is the same predicate the branch below tests: --initial wins over -p
        // there, and a supplied distribution carries its own support (the same
        // split wfafs_deterministic makes). Placed before the first matrix is
        // built, so a refused run leaves no --output-Q file behind. Not
        // --force-bypassable: an out-of-range state index is an indexing
        // error, not a judgement call.
        if (options.initial_distribution_path.empty() && options.initial_count >= 0) {
            const llong max_count = 2 * population_sizes[0];
            if (options.initial_count > max_count) {
                throw std::runtime_error(
                    "Starting copies (-p) must be between 0 and 2N = " +
                    std::to_string(max_count) + ", got " +
                    std::to_string(options.initial_count) +
                    ". N here is the -f-rescaled size of the first model (" +
                    std::to_string(population_sizes[0]) +
                    "), so this model's states are the allele counts 0.." +
                    std::to_string(max_count));
            }
        }

        // Per-model domain checks, on the FACTOR-SCALED values that actually
        // reach the Wright-Fisher matrix rather than on what the user typed.
        // The scaling is what can push a legitimate-looking rate out of range.
        Args_Parser::validate_model_domain_vectors(
            population_sizes, s, h, u, v, options.alpha);

        // Psi boundary rows, at BOTH sites that build a matrix.
        //
        // Placement is load-bearing: --output-Q writes W.Q immediately after
        // WF::Switching returns and before the solve, so a check any later
        // still leaves a nan-bearing file on disk. It did: the four psi faults
        // below each wrote 16 nan entries into --output-Q and only then failed
        // with "matrix is singular".
        //
        // (A) The switching matrix, one call per model, on the -f-RESCALED
        // rates. WF::Switching evaluates
        // psi_diploid(im, N(i), s(j), h(j), u(j), v(j)) for every ordered pair
        // of models -- state index and population size from model i, rates
        // from model j -- so the boundary condition (psi is exactly v(j) at
        // im == 0 and exactly 1 - u(j) at im == 2N(i)) is per-rate-model, one
        // check per j. It has to be on the rescaled rates and not on what the
        // user typed, because the two genuinely disagree: `-f 0.5 -u 1e-16` is
        // degenerate (u*f = 5e-17) and a typed-value check MISSES it, while
        // `-u 1e-17` with a rescaled u*f of 1e-15 is fine and a typed-value
        // check would FALSELY REFUSE it.
        //
        // Scope, stated plainly: the two BOUNDARY rows are covered exactly,
        // for every ordered pair, because psi there depends only on j. The
        // interior sweep inside require_usable_matrix pairs each model's
        // states with its own rates, so the n_models^2 - n_models MIXED
        // interior pairs are not exhaustively checked. Interior psi cannot
        // reach 0 or 1 for finite parameters, and the non-finite s/h/u/v that
        // could break that are refused per model above, so the gap is
        // theoretical -- but it is a gap, not a proof.
        for (llong i = 0; i < n_models; ++i) {
            require_usable_matrix(population_sizes(i), s(i), h(i), u(i), v(i),
                                  "model " + std::to_string(i + 1) +
                                  " (rates shown are -f-rescaled)");
        }

        // (B) The up-projection at the end builds a SECOND NON_ABSORBING
        // matrix -- WF::Single(..., s_unsc[lt], h[lt], u_unsc[lt], v_unsc[lt])
        // -- with the UNSCALED rates, because it maps onto the real
        // population. Its boundary rows are degenerate independently of the
        // rescaled ones, which is what makes this site easy to miss:
        // `-N 1000 -G 10 -f 100 -u 1e-17` writes a completely CLEAN Q
        // (u*f = 1e-15 passes (A)) and produced nan in the spectrum anyway.
        //
        // The guard must fire on exactly the runs that build that second
        // matrix and no others: an f == 1 run must not be refused for a matrix
        // it never builds, and an f != 1 run must not slip past. Whether the
        // matrix gets built is decided ~160 lines below, at the projection
        // block near the bottom of main(). Two independently written `!= 1.0`
        // tests would state that agreement in a comment and rely on both being
        // edited together; one shared predicate makes it structural. Both
        // sites read projects_up -- do not reintroduce a second test.
        const bool projects_up = (factors(n_models - 1) != 1.0);
        if (projects_up) {
            const llong lt = n_models - 1;
            require_usable_matrix(population_sizes(lt), s_unsc(lt), h(lt),
                                  u_unsc(lt), v_unsc(lt),
                                  "up-projection (model " +
                                  std::to_string(lt + 1) +
                                  ", rates as typed, NOT -f-rescaled)");
        }

        // Set thread count
#ifdef OMP
        omp_set_num_threads(options.num_threads);
#endif
#ifdef WFES_USE_MKL
        mkl_set_num_threads(options.num_threads);
#endif
        
        llong msg_level = options.verbose ? MKL_PARDISO_MSG_VERBOSE : MKL_PARDISO_MSG_QUIET;
        
        // Create switching matrix
        dmat switching = dmat::Zero(n_models, n_models);
        for (llong i = 0; i < n_models - 1; i++) {
            switching(i, i) = 1.0 - (1.0 / generations[i]);
            switching(i, i + 1) = 1.0 / generations[i];
        }
        switching(n_models - 1, n_models - 1) = 1.0 - (1.0 / generations[n_models - 1]);
        
        if (options.verbose) {
            cout << "Creating switching Wright-Fisher matrix with " << n_models << " models" << endl;
        }
        
        // Create Wright-Fisher switching matrix
        WF::Matrix W = WF::Switching(population_sizes, WF::NON_ABSORBING,
                                   s, h, u, v, switching, options.alpha, 
                                   options.verbose, 100, options.library);
        
        // Output Q matrix if requested
        if (!options.output_Q_path.empty()) {
            W.Q->saveMarket(options.output_Q_path);
        }
        
        // Subtract identity
        W.Q->subtractIdentity();
        
        // Set up initial distribution
        dvec initial;
        if (!options.initial_distribution_path.empty()) {
            // This tool's own loader reads whatever length the file happens to
            // have, so a wrong length reached the solver and failed there rather
            // than here. Checked against the state space, like every other tool.
            initial = load_initial_distribution(options.initial_distribution_path);
            const llong expected = 2 * population_sizes[0] + 1;
            if (initial.size() != expected) {
                throw std::runtime_error(
                    "Initial distribution (--initial) has " + std::to_string(initial.size()) +
                    " entries but this model has " + std::to_string(expected) +
                    " states (allele counts 0..2N in the first epoch). Supply one "
                    "probability per state.");
            }
            const double total = initial.sum();
            if (!(total > 0)) {
                throw std::runtime_error(
                    "Initial distribution (--initial) must contain positive probability.");
            }
            if (std::abs(total - 1.0) > 1e-9) {
                std::cerr << "Warning: initial distribution sums to " << total
                          << ", not 1; renormalising.\n";
                initial /= total;
            }
        } else if (options.initial_count >= 0) {
            initial = dvec::Zero(2 * population_sizes[0] + 1);
            initial[options.initial_count] = 1.0;
        } else if (options.integration_cutoff >= 0) {
            // The starting-copy distribution a new mutation produces, as the
            // other tools build it: row 0 of the first epoch's matrix,
            // conditioned on at least one copy, truncated at the cutoff.
            WF::Row row = WF::binom_row(
                2 * population_sizes[0],
                WF::psi_diploid(0, population_sizes[0], s[0], h[0], u[0], v[0]),
                options.alpha);
            if (row.Q(0) >= 1.0) {
                throw std::invalid_argument(
                    "Error: no mutation reaches one copy (forward mutation rate is zero?); "
                    "--integration-cutoff has nothing to integrate over.");
            }
            dvec tail = row.Q.tail(row.Q.size() - 1);
            // Renormalize by the tail's OWN sum, not by 1 - row.Q(0): binom_row
            // sum-normalizes the row, so the two are the same quantity, but the
            // subtraction cancels to roundoff (row.Q(0) = 1 - O(2Nv)). See the
            // long note at the wfes_single site (wfes_single_main.cpp).
            tail /= tail.sum();
            initial = dvec::Zero(2 * population_sizes[0] + 1);
            llong z = 0;
            if (options.integration_cutoff > 0) {
                while (z < tail.size() && tail(z) > options.integration_cutoff) z++;
            } else {
                z = tail.size();
            }
            if (z == 0) {
                throw std::invalid_argument(
                    "Error: --integration-cutoff is above every starting-copy probability; "
                    "nothing would be integrated over.");
            }
            for (llong i = 0; i < z; i++) {
                llong state = row.start + 1 + i;
                if (state < initial.size()) initial(state) = tail(i);
            }
            initial /= initial.sum();
        } else {
            // Use equilibrium distribution
            // options.library must be forwarded: WF::Equilibrium's own default
            // is "Pardiso", which does not exist on Apple Silicon, so omitting
            // it made this default code path (no -i and no -p) fail even when
            // the user passed --library Accelerate.
            initial = WF::Equilibrium(population_sizes[0], s[0], h[0],
                                    u[0], v[0], options.alpha, options.verbose,
                                    options.library);
        }
        
        llong n_rhs = 2 * population_sizes[0] + 1;
        llong size = (2 * population_sizes.sum()) + n_models;
        
        // Create solver.
        //
        // n_rhs MUST be forwarded here. Pardiso sizes its internal workspace as
        // (order * n_rhs) at construction and passes that same count to every
        // pardiso_64 call, so a solver built with the default n_rhs = 1 and then
        // handed the (n_rhs x size) identity below solves only the first
        // right-hand side and leaves the rest of the result matrix
        // uninitialised -- silently wrong output, not a crash. SuiteSparse and
        // Accelerate ignore n_rhs (they loop over the rows themselves), which is
        // why this omission was invisible on macOS. The Qt-era
        // The Qt-era wfes-lib/source/model/executables/wfafs/wfafs.cpp did
        // forward it and the CLI port dropped it. That file has since been
        // removed with the rest of the Qt lineage (it lives on in the public
        // WFES2-GUI repo), so this comment is the only remaining record of
        // where the omission came from.
        solver::Solver* solver_ptr = solver::SolverFactory::createSolver(
            options.library, *W.Q, MKL_PARDISO_MATRIX_TYPE_REAL_UNSYMMETRIC, msg_level,
            "GMRes", "", n_rhs
        );
        solver_ptr->preprocess();
        
        // Create identity matrix for solving
        dmat id = dmat::Identity(n_rhs, size);
        
        // Solve the system
        dmat B = solver_ptr->solve_multiple(id, true);
        
        // Output N matrix if requested
        if (!options.output_N_path.empty()) {
            OutputFormatter::write_matrix_to_file(B, options.output_N_path);
        }
        
        // Scale by final generation time
        B /= generations[n_models - 1];
        
        // Output B matrix if requested
        if (!options.output_B_path.empty()) {
            OutputFormatter::write_matrix_to_file(B, options.output_B_path);
        }
        
        // Extract final distribution
        llong nk = 2 * population_sizes[n_models - 1] + 1;
        dvec d = initial.transpose() * B.transpose().rightCols(nk);
        
        // Apply projection if factors differ from 1.
        //
        // The scaled-down state space is projected UP to the real population
        // size, then back DOWN onto the model's own states for output.
        // --no-project ("Do not project the distribution down") turns off the
        // second step only -- that is what the inner `else` below is for.
        // The outer condition used to read `factors[lt] != 1.0 &&
        // !options.no_project`, which skipped the up-projection as well and
        // left that `else` unreachable, so the flag returned the un-projected
        // scaled-size spectrum rather than the full-resolution one its help
        // promises. The Qt-era wfafs.cpp gates only on the factor; that is the
        // behaviour restored here. Runs without the flag are unaffected.
        //
        // projects_up is the same predicate the psi guard (B) above is gated
        // on, computed once near that guard. The two must agree exactly -- the
        // guard exists to keep this block from building a nan-bearing matrix
        // -- so they read one bool rather than each testing the factor.
        llong lt = n_models - 1;
        if (projects_up) {
            llong n = 2 * population_sizes[lt] + 1;
            llong m = 2 * static_cast<llong>(population_sizes[lt] * factors[lt]) + 1;
            
            WF::Matrix sw_up = WF::Single(population_sizes[lt], 
                                        static_cast<llong>(population_sizes[lt] * factors[lt]),
                                        WF::NON_ABSORBING, s_unsc[lt], h[lt],
                                        u_unsc[lt], v_unsc[lt], true, options.alpha,
                                        options.verbose, 100, options.library);
            
            // Project up
            dvec prj_u = sw_up.Q->multiply(d, true);
            
            if (!options.no_project) {
                // Project down: SUM the fine states into each coarse bin.
                //
                // The map is a partition. Every one of the m-2 interior states
                // of prj_u lands in exactly one of the n-2 interior bins
                // (j = floor(i / diag_f) is monotone and ranges over 0 ..
                // n-3), and the two boundary classes are carried across
                // verbatim below. A partition of a probability vector is
                // summed, not averaged, so sum(prj_d) == sum(prj_u) exactly --
                // the same accounting the up-projection above already obeys
                // (its rows are binom_row, each summing to 1).
                //
                // It used to divide each contribution by the number of states
                // in its bin:
                //
                //     prj_d[j+1] += prj_u[i+1] / row_integral_counts[j+1];
                //
                // which reports the MEAN of each bin, not its mass, and so
                // discarded about (1 - 1/bin-count) of the SEGREGATING
                // probability. Measured on that code, comparing against the
                // same run's --no-project output (which is prj_u itself, i.e.
                // the input to this block):
                //
                //   -N 20,10 -G 10,5 -f 2,2         segregating 2.1798e-07
                //                                            -> 1.0059e-07
                //   -N 2000,200,1000 ... -f 10,10,10 segregating 3.4641e-05
                //                                            -> 3.4327e-06
                //
                // It survived this long because the two boundary classes carry
                // ~0.5 each under the mutation-drift models this tool solves,
                // so the published total still read 0.99999988 and 0.99996879
                // -- close enough to 1 to pass for roundoff. Nothing
                // downstream renormalised it: print_wfafs_stochastic_results
                // writes d out entry by entry, so the deficit was published.
                //
                // Changing this MOVES the default f != 1 spectrum. That is the
                // point, and it was approved as such (task CX-proj). Runs with
                // f == 1 never enter this block, and --no-project takes the
                // else branch, so both are unaffected byte for byte.
                // baseline_tests/test_degenerate_wfafs_stochastic.py's
                // test_down_projection_conserves_mass asserts the invariant
                // directly, by straddling this block with --no-project.
                dvec prj_d = dvec::Zero(n);
                double diag_f = static_cast<double>(m - 2) / (n - 2);

                prj_d[0] = prj_u[0];
                prj_d[prj_d.size() - 1] = prj_u[prj_u.size() - 1];
                for (llong i = 0; i < m - 2; i++) {
                    llong j = static_cast<llong>(i / diag_f);
                    prj_d[j + 1] += prj_u[i + 1];
                }
                d = prj_d;
            } else {
                d = prj_u;
            }
        }
        
        // Print results using OutputFormatter
        OutputFormatter::print_wfafs_stochastic_results(options, d, n_models);
        
        // Print timing information
        if (options.verbose) {
            t_end = std::chrono::system_clock::now();
            time_diff dt = t_end - t_start;
            cout << "Total runtime: " << dt.count() << " s" << endl;
        }
        
        // Clean up
        delete solver_ptr;
        
    } catch (const std::exception& e) {
        cerr << "Error: " << e.what() << endl;
        return EXIT_FAILURE;
    }
    
    return EXIT_SUCCESS;
}