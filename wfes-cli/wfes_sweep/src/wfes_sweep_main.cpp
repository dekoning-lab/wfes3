#include <cmath>
#include <iostream>
#include <limits>
#include <iomanip>
#include <sstream>
#include <string>
#include <vector>
#include <chrono>
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
#include "initial_distribution.h"

// Include the core library components
#include "types.h"
#include "wright_fisher.h"

// Platform-agnostic constants
#ifndef WFES_USE_MKL
    constexpr llong MKL_PARDISO_MATRIX_TYPE_REAL_UNSYMMETRIC = 11;
    constexpr llong MKL_PARDISO_MSG_VERBOSE = 1;
    constexpr llong MKL_PARDISO_MSG_QUIET = 0;
#endif

// Include direct references to core library components with CLI adaptations
#include "model/wright-fisher/wrightFisher.h"
#include "model/sparse-matrix/sparseMatrixFactory.h"
#include "model/solver/solverFactory.h"

// For loading CSV files and utilities (CLI versions)
#include "parsing.h"
#include "utils.h"
#include "banner.h"

// Namespace aliases for shorter code
namespace CLI = wfes::cli;
using namespace wfes;

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

int main(int argc, char const *argv[]) {
    args::ArgumentParser parser("WFES-SWEEP");
    parser.helpParams.width = 120;
    parser.helpParams.helpindent = 50;
    parser.helpParams.flagindent = 2;

    // Model type - for now just support fixation (as in original)
    args::Flag fixation_f(parser, "fixation", "Only fixation state is absorbing", {"fixation"});

    // Required arguments
    args::ValueFlag<llong> population_size_f(parser, "int", "Size of the population", 
                                             {'N', "pop-size"}, args::Options::Required);
    args::ValueFlag<std::string> selection_coefficient_f(parser, "s1,s2", "Selection coefficients (comma-separated)", 
                                                          {'s', "selection"}, args::Options::Required);
    args::ValueFlag<double> lambda_f(parser, "float", "Transition probability", 
                                     {'l', "lambda"}, args::Options::Required);

    // Optional arguments with defaults
    args::ValueFlag<std::string> dominance_f(parser, "h1,h2", "Dominance coefficients (comma-separated)", 
                                              {'h', "dominance"});
    args::ValueFlag<std::string> backward_mutation_f(parser, "u1,u2", "Backward mutation rates (comma-separated)", 
                                                      {'u', "backward-mu"});
    args::ValueFlag<std::string> forward_mutation_f(parser, "v1,v2", "Forward mutation rates (comma-separated)", 
                                                     {'v', "forward-mu"});
    args::ValueFlag<double> alpha_f(parser, "float", "Tail truncation weight", {'a', "alpha"});
    args::ValueFlag<std::string> initial_f(parser, "path",
        "Path to initial state distribution CSV (one probability per state)", {'i', "initial"});
    args::ValueFlag<llong> n_threads_f(parser, "int", "Number of threads", {'t', "num-threads"});
    args::ValueFlag<double> integration_cutoff_f(parser, "float", "Starting number of copies integration cutoff", 
                                                  {'c', "integration-cutoff"});
    args::ValueFlag<llong> starting_copies_f(parser, "int", "Starting number of copies - no integration", 
                                              {'p', "starting-copies"});

    // Output options
    args::ValueFlag<std::string> output_Q_f(parser, "path", "Output Q matrix to file", {"output-Q"});
    args::ValueFlag<std::string> output_R_f(parser, "path", "Output R vectors to file", {"output-R"});
    args::ValueFlag<std::string> output_N_f(parser, "path", "Output N matrix to file", {"output-N"});
    args::ValueFlag<std::string> output_B_f(parser, "path",
        "Output absorption probability vector B to file", {"output-B"});
    args::ValueFlag<std::string> output_I_f(parser, "path", "Output Initial probability distribution", {"output-I"});

    args::Flag csv_f(parser, "csv", "Output results in CSV format", {"csv"});
    args::Flag json_f(parser, "json", "Output results in JSON format", {"json"});
    args::Flag force_f(parser, "force", "Do not perform parameter checks", {"force"});
    args::Flag verbose_f(parser, "verbose", "Verbose solver output", {"verbose"});
    args::ValueFlag<std::string> library_f(parser, "library", "Library (Pardiso, ViennaCL, Accelerate, SuiteSparse, or ParU). Note: on macOS, Accelerate uses UMFPACK for the factorization", {"library"});
    args::HelpFlag help_f(parser, "help", "Display this help menu", {"help"});

    // Parse arguments
    try {
        parser.ParseCLI(argc, argv);
    } catch (args::Help &) {
        // Only display banner if not JSON output
        if (!json_f && !csv_f) {
            wfes::banner::displayBanner("wfes_sweep");
        }
        // An explicit --help is a successful invocation: print the usage to
        // STDOUT and exit 0. This used to write to stderr and exit 1, which
        // makes `wfes_single --help` look like a crash to anything that checks
        // status -- packaging smoke tests, CI, `make check`, a shell `&&`
        // chain -- and puts the help text on the wrong stream for piping into
        // a pager or grep. A genuine PARSE ERROR still goes to stderr with a
        // nonzero exit; that is the args::Error branch below.
        std::cout << parser;
        return EXIT_SUCCESS;
    } catch (args::Error &e) {
        // Only display banner if not JSON output
        if (!json_f && !csv_f) {
            wfes::banner::displayBanner("wfes_sweep");
        }
        std::cerr << e.what() << std::endl;
        std::cerr << parser;
        return EXIT_FAILURE;
    }

    // Display banner for successful parsing (unless JSON output is requested)
    if (!json_f && !csv_f) {
        wfes::banner::displayBanner("wfes_sweep");
    }

    // Require fixation mode for now
    if (!fixation_f) {
        std::cerr << "Error: --fixation flag is required" << std::endl;
        return EXIT_FAILURE;
    }

    auto t_start = std::chrono::system_clock::now();

    try {
        // Parse required parameters
        llong population_size = args::get(population_size_f);
        dvec selection_coefficient = parse_vector(args::get(selection_coefficient_f));
        double lambda = args::get(lambda_f);

        // Parse optional parameters with defaults
        dvec h = dominance_f ? parse_vector(args::get(dominance_f)) : dvec::Constant(2, 0.5);
        dvec u = backward_mutation_f ? parse_vector(args::get(backward_mutation_f)) : dvec::Constant(2, 1e-9);
        dvec v = forward_mutation_f ? parse_vector(args::get(forward_mutation_f)) : dvec::Constant(2, 1e-9);
        double a = alpha_f ? args::get(alpha_f) : 1e-20;
        llong n_threads = n_threads_f ? args::get(n_threads_f) : 1;
        double integration_cutoff = integration_cutoff_f ? args::get(integration_cutoff_f) : 1e-10;
        // -p is a copy COUNT. Phase 1 of this model keeps count 0 as a transient
        // state (index == count), exactly as in wfes_single --fixation, so the
        // count is used directly rather than shifted by one; -p 0 is meaningful
        // and is the natural "time between fixations" starting point. Omitting
        // -p integrates over the mutational injection distribution instead.
        llong starting_copies = -1; // -1 means use integration
        if (starting_copies_f) {
            starting_copies = args::get(starting_copies_f);
            llong max_count = 2 * population_size;
            if (starting_copies < 0 || starting_copies > max_count) {
                std::cerr << "Error: Starting copies (-p) must be between 0 and 2N = "
                          << max_count << " for wfes_sweep (count 0 is a transient "
                          << "state in the pre-adaptive phase)" << std::endl;
                return EXIT_FAILURE;
            }
        }

        // Validate vector sizes
        if (selection_coefficient.size() != 2) {
            std::cerr << "Error: Selection coefficient vector should be of length 2" << std::endl;
            return EXIT_FAILURE;
        }
        if (h.size() != 2) {
            std::cerr << "Error: Dominance vector should be of length 2" << std::endl;
            return EXIT_FAILURE;
        }
        if (u.size() != 2) {
            std::cerr << "Error: Backward mutation vector should be of length 2" << std::endl;
            return EXIT_FAILURE;
        }
        if (v.size() != 2) {
            std::cerr << "Error: Forward mutation vector should be of length 2" << std::endl;
            return EXIT_FAILURE;
        }

        // Per-regime domain checks. This tool builds its own parser rather than
        // going through Args_Parser, so it does not inherit the validation the
        // other tools get; run the same checks explicitly on both regimes.
        CLI::Args_Parser::validate_model_domain(population_size, selection_coefficient(0),
                                                h(0), u(0), v(0), a, "regime 1");
        CLI::Args_Parser::validate_model_domain(population_size, selection_coefficient(1),
                                                h(1), u(1), v(1), a, "regime 2");

        // Set number of threads
#ifdef WFES_USE_MKL
        mkl_set_num_threads(n_threads);
#endif
        #ifdef _OPENMP
            omp_set_num_threads(n_threads);
        #endif
        
        // Parameter validation (unless forced)
        if (!force_f) {
            if (population_size > 500000) {
                std::cerr << "Error: Population size is quite large - the computations will take a long time. Use --force to ignore" << std::endl;
                return EXIT_FAILURE;
            }
            double max_mu = std::max(u.maxCoeff(), v.maxCoeff());
            if (4 * population_size * max_mu > 1) {
                std::cerr << "Error: The mutation rate might violate the Wright-Fisher assumptions. Use --force to ignore" << std::endl;
                return EXIT_FAILURE;
            }
            if (selection_coefficient.minCoeff() <= -1) {
                std::cerr << "Error: The selection coefficient is quite negative. Fixations might be impossible. Use --force to ignore" << std::endl;
                return EXIT_FAILURE;
            }
            if (a > 1e-5) {
                std::cerr << "Error: Zero cutoff value is quite high. This might produce inaccurate results. Use --force to ignore" << std::endl;
                return EXIT_FAILURE;
            }
        }

        // Create switching matrix
        dmat switching(2, 2); 
        switching << 1 - lambda, lambda, 0, 1;

        // Set up Wright-Fisher calculation
        llong msg_level = verbose_f ? MKL_PARDISO_MSG_VERBOSE : MKL_PARDISO_MSG_QUIET;
        // Platform-aware default, matching every tool that uses the shared
        // parser. Hardcoding "Pardiso" made wfes_sweep fail out of the box on
        // Apple Silicon, where MKL/Pardiso does not exist.
        std::string library = library_f ? args::get(library_f)
                                        : CLI::Args_Parser::get_default_library();

        // JSON is machine-consumed: emit round-trip precision rather than the
        // stream default of 6 significant figures.
        if (json_f) std::cout << std::setprecision(std::numeric_limits<double>::max_digits10);

        // Calculate initial distribution for integration
        dvec first_row = wrightfisher::binom_row(2 * population_size, 
                                       wrightfisher::psi_diploid(0, population_size, selection_coefficient(0), h(0), u(0), v(0)), 
                                       a).Q;
        dvec starting_copies_p = first_row.tail(first_row.size() - 1);
        starting_copies_p /= 1 - first_row(0); // renormalize

        // Snapshot the freshly-computed distribution for --output-I. The
        // actual file write happens after the z == 0 refusal below (so a
        // refused run leaves no file), but it must still write exactly what
        // this call would have written before that move: the raw computed
        // distribution, not whatever starting_copies_p becomes if the
        // "no integration" branch just below overwrites it in place.
        const dvec initial_distribution_for_output = starting_copies_p;

        // Determine integration range
        llong z = 0;
        if (integration_cutoff <= 0) {
            z = 1;
            starting_copies_p = dvec::Zero(starting_copies_p.size());
            if (starting_copies_p.size() > 0) {
                starting_copies_p(0) = 1;
            }
        } else {
            for (llong i = 0; i < starting_copies_p.size() && starting_copies_p(i) > integration_cutoff; i++, z++);
        }
        if (starting_copies_f) z = 1;

        // Refuse rather than integrate over nothing. When -c sits above every
        // starting-copy probability the loop above leaves z == 0, the fill loop
        // further down never runs, and the "initial distribution" handed to the
        // solver is all zeros -- which solves to all zeros, so T_fix = 0 and
        // rate = 1/0 = inf were printed as if they were results, with exit 0
        // and an empty stderr. Only the integration path consumes z; --initial
        // and -p supply their own starting state and are unaffected.
        if (!initial_f && !starting_copies_f && z == 0) {
            const double largest = starting_copies_p.size() > 0
                                 ? starting_copies_p.maxCoeff() : 0.0;
            // Full precision for both numbers: the largest probability is
            // typically just under 1 here, and at the stream default of six
            // significant figures it prints as "1", which makes the comparison
            // the message is explaining look like a contradiction.
            std::ostringstream detail;
            detail << std::setprecision(std::numeric_limits<double>::max_digits10)
                   << "-c " << integration_cutoff << " exceeds every starting-copy "
                      "probability (the largest is " << largest << ")";
            std::cerr << "Error: no state above the integration cutoff -- "
                      << detail.str() << ", so there is nothing to integrate "
                         "over. Lower -c, or give a fixed starting count with -p."
                      << std::endl;
            return EXIT_FAILURE;
        }

        // Output initial distribution if requested. Written here, after the
        // z == 0 refusal above, rather than at the point of computation: a
        // refused degenerate run (e.g. -c 1 exceeding every starting-copy
        // probability) must leave no file behind, not even the initial
        // distribution. See initial_distribution_for_output above for why
        // the content is unaffected by the move.
        if (output_I_f) {
            CLI::OutputFormatter::write_vector_to_file(initial_distribution_for_output, args::get(output_I_f));
        }

        // Create Wright-Fisher matrix
        WF::Matrix wf = WF::NonAbsorbingToFixationOnly(population_size, selection_coefficient, h, u, v, switching, a, verbose_f, 1, library);
        
        // Output matrices if requested
        if (output_Q_f) {
            wf.Q->saveMarket(args::get(output_Q_f));
        }
        if (output_R_f) {
            CLI::OutputFormatter::write_matrix_to_file(wf.R, args::get(output_R_f));
        }

        // Subtract identity for solving
        wf.Q->subtractIdentity();

        // Create solver
        solver::Solver* solver = solver::SolverFactory::createSolver(library, *wf.Q, MKL_PARDISO_MATRIX_TYPE_REAL_UNSYMMETRIC, msg_level);
        solver->preprocess();

        // B = (I - Q)^-1 R: the probability of ending in the one absorbing
        // state (fixation, in phase 2) from each transient state, the same
        // quantity and the same call wfes_single writes for its --output-B.
        // This model has a single absorbing state, so every entry is 1 in
        // exact arithmetic -- row sums of [Q|R] are exactly 1.0, so no alpha
        // tail truncation mass is missing. Measured for -N 10: 40 of 41
        // entries land strictly ABOVE 1 (max 1.0000000121, none below) --
        // truncation loss can only discard probability mass, which would
        // pull entries below 1, so an above-1 deviation cannot be truncation
        // and is instead solver conditioning/roundoff: (I-Q)^-1 has entries
        // of order T_fix, so double-precision error reaches the solved
        // vector at about T_fix * eps. That is what makes the vector worth
        // having: not a truncation-loss readout, but the absorption
        // probabilities themselves, accurate to solver tolerance. The flag
        // was parsed and then never used, so asking for it silently
        // produced no file.
        if (output_B_f) {
            if (wf.R.cols() < 1) {
                std::cerr << "Error: this model has no absorbing state, so there "
                             "is no absorption probability vector B to write"
                          << std::endl;
                delete solver;
                return EXIT_FAILURE;
            }
            dvec R_fix = wf.R.col(0);
            dvec B = solver->solve(R_fix, false);
            CLI::OutputFormatter::write_vector_to_file(B, args::get(output_B_f));
        }

        // The NonAbsorbingToFixationOnly system has (2N+1) + 2N = 4N+1 states:
        //   indices 0 .. 2N       phase 1 (pre-adaptive), counts 0..2N
        //   indices 2N+1 .. 4N    phase 2 (adaptive),     counts 0..2N-1
        // (the single absorbing state, count 2N in phase 2, is held in R).
        //
        // This was previously sized 2*N. UMFPACK takes its order from the
        // factorized matrix, not from the vector, so every solve read 2N+1
        // doubles past the end of `id` and wrote 2N+1 doubles past the end of
        // the solution buffer -- heap corruption on EVERY run, making the
        // reported numbers undefined behaviour rather than merely inaccurate.
        llong size = (4 * population_size) + 1;
        dvec id = dvec::Zero(size);
        if (initial_f) {
            // A supplied distribution replaces both the fixed starting count and
            // the integration over the mutation-generated one, over this model's
            // own concatenated two-phase state space.
            id = CLI::load_initial_distribution(
                args::get(initial_f), size,
                "the concatenated pre-adaptive and adaptive phase states");
        } else if (starting_copies >= 0) {
            // Phase 1 keeps count 0 as a transient state, so index == count here
            // (the same convention as wfes_single --fixation).
            id(starting_copies) = 1;
        } else {
            // starting_copies_p(i) is P(count i+1 | at least one copy), so it
            // belongs at phase-1 index i+1, not index i. The previous off-by-one
            // put the mass for 1 copy onto the 0-copy state.
            for (llong i = 0; i < z && i < starting_copies_p.size() && (i + 1) < id.size(); i++) {
                id(i + 1) = starting_copies_p(i);
            }
        }

        // Solve for expected sojourn times
        dvec N = solver->solve(id, true);

        // Time between fixations is the total expected sojourn across BOTH
        // phases: T_b.fix = sum_j N(start, j) (about/wfes_sweep.md). The previous
        // N.tail(2N) summed only the phase-2 block. Cross-checked against an
        // independent dense reference and against time_dist_sgv, which builds
        // the same matrix.
        double T_fix = N.sum();

        // Per-regime decomposition of the substitution time: phase 1 spans
        // indices 0..2N (counts 0..2N, pre-adaptive), phase 2 spans
        // 2N+1..4N (counts 0..2N-1, adaptive). Their sum is T_fix, so this
        // splits "waiting under the standing-variation regime" from "sweeping
        // under the adaptive regime" -- the quantity this two-regime model
        // exists to separate.
        double T_regime1 = N.head(2 * population_size + 1).sum();
        double T_regime2 = N.tail(2 * population_size).sum();

        // Never divide blindly, and never let a non-finite value reach an
        // output format. An expected sojourn time that is zero, negative or
        // non-finite means the solve failed or the model is degenerate, and
        // 1/T_fix then prints as a bare `inf`: not valid JSON -- python's
        // json.load and node's JSON.parse both reject it -- while jq silently
        // coerces it to 1.7976931348623157e+308, a plausible-looking number
        // that is not a result. Refuse rather than publish one.
        if (!std::isfinite(T_fix) || T_fix <= 0 ||
            !std::isfinite(T_regime1) || !std::isfinite(T_regime2)) {
            std::cerr << "Error: the expected time to fixation is not a usable "
                         "positive finite number (T_fix = " << T_fix
                      << ", T_regime1 = " << T_regime1
                      << ", T_regime2 = " << T_regime2
                      << "). The linear solve failed or the model is degenerate; "
                         "no substitution rate can be reported." << std::endl;
            delete solver;
            return EXIT_FAILURE;
        }

        double rate = 1.0 / T_fix;

        // Belt and braces. The check above requires T_fix finite and > 0,
        // but that does not guarantee 1.0 / T_fix is finite: a subnormal
        // T_fix (denormal, near the ~1e-308 bottom of double's normal range)
        // divides out to inf despite passing every prior test. Catch that
        // edge too, before rate reaches any output format.
        if (!std::isfinite(rate)) {
            std::cerr << "Error: the substitution rate 1/T_fix is not a usable "
                         "finite number (T_fix = " << T_fix << ", rate = " << rate
                      << "). T_fix is likely a subnormal value from a degenerate "
                         "solve; no substitution rate can be reported." << std::endl;
            delete solver;
            return EXIT_FAILURE;
        }

        // Output results
        if (output_N_f) {
            CLI::OutputFormatter::write_vector_to_file(N, args::get(output_N_f));
        }

        // Check that only one output format is specified
        if (csv_f && json_f) {
            std::cerr << "Error: Cannot specify both --csv and --json output formats" << std::endl;
            return EXIT_FAILURE;
        }

        if (json_f) {
            std::cout << "{" << std::endl;
            std::cout << "  \"model\": \"sweep_fixation\"," << std::endl;
            std::cout << "  \"parameters\": {" << std::endl;
            std::cout << "    \"population_size\": " << population_size << "," << std::endl;
            std::cout << "    \"selection_coefficients\": [" << selection_coefficient(0) << ", " << selection_coefficient(1) << "]," << std::endl;
            std::cout << "    \"dominance\": [" << h(0) << ", " << h(1) << "]," << std::endl;
            std::cout << "    \"backward_mutation\": [" << u(0) << ", " << u(1) << "]," << std::endl;
            std::cout << "    \"forward_mutation\": [" << v(0) << ", " << v(1) << "]," << std::endl;
            std::cout << "    \"lambda\": " << lambda << "," << std::endl;
            std::cout << "    \"alpha\": " << a << std::endl;
            std::cout << "  }," << std::endl;
            std::cout << "  \"results\": {" << std::endl;
            std::cout << "    \"T_fix\": " << T_fix << "," << std::endl;
            std::cout << "    \"rate\": " << rate << "," << std::endl;
            std::cout << "    \"T_regime1\": " << T_regime1 << "," << std::endl;
            std::cout << "    \"T_regime2\": " << T_regime2 << std::endl;
            std::cout << "  }" << std::endl;
            std::cout << "}" << std::endl;
        } else if (csv_f) {
            std::cout << population_size << ",";
            for (int i = 0; i < selection_coefficient.size(); ++i) {
                std::cout << selection_coefficient(i);
                if (i < selection_coefficient.size() - 1) std::cout << ",";
            }
            std::cout << ",";
            for (int i = 0; i < h.size(); ++i) {
                std::cout << h(i);
                if (i < h.size() - 1) std::cout << ",";
            }
            std::cout << ",";
            for (int i = 0; i < u.size(); ++i) {
                std::cout << u(i);
                if (i < u.size() - 1) std::cout << ",";
            }
            std::cout << ",";
            for (int i = 0; i < v.size(); ++i) {
                std::cout << v(i);
                if (i < v.size() - 1) std::cout << ",";
            }
            std::cout << "," << lambda << "," << a << "," << T_fix << "," << rate << "," << T_regime1 << "," << T_regime2 << std::endl;
        } else {
            std::cout << "N = " << population_size << std::endl;
            std::cout << "s = [" << selection_coefficient.transpose() << "]" << std::endl;
            std::cout << "h = [" << h.transpose() << "]" << std::endl;
            std::cout << "u = [" << u.transpose() << "]" << std::endl;
            std::cout << "v = [" << v.transpose() << "]" << std::endl;
            std::cout << "lambda = " << lambda << std::endl;
            std::cout << "a = " << a << std::endl;
            std::cout << "T_fix = " << T_fix << std::endl;
            std::cout << "Rate = " << rate << std::endl;
            std::cout << "T_regime1 = " << T_regime1 << " (pre-adaptive)" << std::endl;
            std::cout << "T_regime2 = " << T_regime2 << " (adaptive)" << std::endl;
        }

        delete solver;

    } catch (const std::exception& e) {
        std::cerr << "Error: " << e.what() << std::endl;
        return EXIT_FAILURE;
    }

    if (verbose_f) {
        auto t_end = std::chrono::system_clock::now();
        auto duration = std::chrono::duration_cast<std::chrono::milliseconds>(t_end - t_start);
        std::cout << "Total runtime: " << duration.count() / 1000.0 << " s" << std::endl;
    }

    return EXIT_SUCCESS;
}