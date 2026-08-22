#include <algorithm>
#include <iostream>
#include <iomanip>
#include <sstream>
#include <string>
#include <vector>
#include <chrono>
#include <cmath>
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

#include "types.h"

// Platform-agnostic constants for PARDISO. Typed constants guarded on
// WFES_USE_MKL, exactly as time_dist does it -- these must NOT be macros: as
// #defines they textually rewrote the `const llong MKL_PARDISO_MSG_VERBOSE`
// declarations in MKL_Consts.h, which only Linux includes, so this file
// compiled on macOS for months and failed on the first Linux build.
#ifndef WFES_USE_MKL
    constexpr llong MKL_PARDISO_MATRIX_TYPE_REAL_UNSYMMETRIC = 11;
    constexpr llong MKL_PARDISO_MSG_VERBOSE = 1;
    constexpr llong MKL_PARDISO_MSG_QUIET = 0;
#endif

// Include the CLI utilities
#include "args_parser.hpp"
#include "output_formatter.hpp"
#include "initial_distribution.h"

// Include the core library components
#include "types.h"
#include "wright_fisher.h"

// Include direct references to core library components
#include "model/wright-fisher/wrightFisher.h"
#include "model/sparse-matrix/sparseMatrixFactory.h"
#include "model/solver/solverFactory.h"

// For utilities
#include "parsing.h"
#include "utils.h"

// Namespace aliases for shorter code
namespace CLI = wfes::cli;
using namespace wfes;

int main(int argc, char const *argv[]) {
    time_point t_start, t_end;
    
    try {
        // Parse command-line arguments for phase-type moments tool
        CLI::CommandLineOptions options = CLI::Args_Parser::parse_phase_type_moments_args(argc, argv);
        
        // Start timing if verbose
        if (options.verbose) {
            t_start = std::chrono::system_clock::now();
        }
        
        // Set thread count
        if (options.n_threads > 0) {
            #ifdef WFES_USE_MKL
            mkl_set_num_threads(options.n_threads);
            #endif
            #ifdef OMP
            omp_set_num_threads(options.n_threads);
            #endif
        }
        
        // Get size for fixation-only model
        llong size = 2 * options.population_size;
        
        // Build Wright-Fisher matrix (fixation-only model)
        wrightfisher::Matrix wf_mat = wrightfisher::Single(
            options.population_size,
            options.population_size,
            wrightfisher::FIXATION_ONLY,
            options.selection_coefficient,
            options.dominance,
            options.backward_mutation,
            options.forward_mutation,
            options.recurrent_mutation,  // -m/--no-recurrent-mu; was hardcoded true
            options.alpha,
            options.verbose,
            options.block_size,
            options.library
        );
        
        // Build sparse matrix from Wright-Fisher matrix
        SparseMatrix& Q = *wf_mat.Q;

        // --output-Q / --output-R; see the note in the args parser. Written
        // before subtractIdentity() below so the file holds Q itself, not (Q-I).
        if (!options.output_Q_path.empty()) {
            wf_mat.Q->saveMarket(options.output_Q_path);
        }
        if (!options.output_R_path.empty()) {
            CLI::OutputFormatter::write_matrix_to_file(wf_mat.R, options.output_R_path);
        }
        
        // Subtract identity (Q := Q - I)
        Q.subtractIdentity();
        
        // Create solver
        solver::Solver* solver = solver::SolverFactory::createSolver(
            options.library, Q, MKL_PARDISO_MATRIX_TYPE_REAL_UNSYMMETRIC,
            options.verbose ? MKL_PARDISO_MSG_VERBOSE : MKL_PARDISO_MSG_QUIET
        );
        
        // Preprocess the matrix (analyze and factorize)
        solver->preprocess();
        
        // Get number of moments to calculate (default to 20)
        llong k = options.n_moments > 0 ? options.n_moments : 20;

        // The tool always reports a standard deviation, which needs the second
        // raw moment -- so with `-k 1` the m.col(2) read below indexed one past
        // the end of the moment matrix. In a debug build that is an Eigen
        // assertion (SIGABRT, exit 134, nothing on stdout); under NDEBUG the
        // assertion compiles out and the same read returns whatever is in
        // memory, which would be printed as the standard deviation. Compute one
        // extra moment internally instead; only the k the user asked for are
        // reported.
        const llong k_internal = std::max(k, 2LL);

        // Initialize z vector for moment calculation algorithm
        dvec z = dvec::Zero(k_internal + 1);
        z(0) = 1;
        z(1) = -1;

        // Initialize right-hand side and moment matrix
        dvec rhs = dvec::Ones(size);
        dmat m = dmat::Zero(size, k_internal + 1);
        m.col(0) = rhs;
        m.col(1) = solver->solve(rhs, false);

        // Calculate moments using the recursive formula
        for (llong i = 1; i < k_internal; i++) {
            z(i + 1) = -1;
            for (llong j = i; j > 0; j--) {
                z(j) = z(j - 1) - z(j);
            }
            z(0) = -z(0);
            
            rhs.setZero();
            for (llong j = 0; j < i + 1; j++) {
                rhs += z(j) * m.col(j);
            }
            
            // Solve for the next moment
            m.col(i + 1) = solver->solve(rhs, false);
        }
        
        // Initial state distribution. m.col(k) holds the kth moment for every
        // starting state; the reported moment is that vector averaged over the
        // initial distribution. Without --initial the distribution is a point
        // mass on state 0, which reproduces the m(0, k) this used to read.
        dvec alpha_vec = dvec::Zero(size);
        if (!options.initial_distribution_path.empty()) {
            alpha_vec = CLI::load_initial_distribution(
                options.initial_distribution_path, size,
                "the transient states of the fixation-only model");
        } else {
            alpha_vec(0) = 1;
        }
        auto moment = [&](llong k) { return alpha_vec.dot(m.col(k)); };

        // Extract mean and standard deviation
        double m1 = moment(1);
        double m2 = moment(2);
        double mean = m1;
        double std_dev = std::sqrt(m2 - (m1 * m1));

        // Raw absorption-time moments grow roughly like k! * E[T]^k, so for any
        // realistic E[T] they run out of double precision after a few tens of
        // orders. Past that point the recursion produces inf, then inf - inf =
        // nan, and every later moment is nan. This used to be printed verbatim:
        // `-N 10 -k 50 --csv` exited 0 with moments 31-50 all "nan" and not a
        // word on stderr, and the JSON path emitted bare `nan` tokens, which is
        // not JSON at all -- any strict parser fails on the whole document
        // rather than on the affected field.
        //
        // A moment that overflowed is not a small number and not a large one;
        // it is a number this arithmetic cannot represent. Refuse, and say how
        // far the computation did get.
        llong last_finite = 0;
        for (llong idx = 1; idx <= k; idx++) {
            if (!std::isfinite(moment(idx))) break;
            last_finite = idx;
        }
        if (last_finite < k) {
            std::ostringstream msg;
            msg << "Raw moment " << (last_finite + 1) << " of " << k
                << " is not finite: the moments of this model overflow double "
                   "precision beyond order " << last_finite;
            if (last_finite >= 1) {
                msg << " (moment " << last_finite << " = " << moment(last_finite) << ")";
                msg << ". Rerun with -k " << last_finite << " or smaller.";
            } else {
                // last_finite == 0: even the first moment overflows, so there
                // is no smaller-but-still-positive -k to suggest (-k must be
                // >= 1; the parser rejects -k 0 outright).
                msg << ". This model has no representable moments in double precision.";
            }
            throw std::runtime_error(msg.str());
        }
        if (!std::isfinite(mean) || !std::isfinite(std_dev)) {
            std::ostringstream msg;
            msg << "The reported summary statistics are not finite (mean = " << mean
                << ", std_dev = " << std_dev << "): the variance m2 - m1^2 = "
                << (m2 - m1 * m1) << " could not be evaluated in double precision"
                   " for these parameters. No results are reported.";
            throw std::runtime_error(msg.str());
        }

        // Print results
        if (options.json_output) {
            // JSON format
            std::cout << "{" << std::endl;
            std::cout << "  \"model\": \"phase_type_moments\"," << std::endl;
            std::cout << "  \"parameters\": {" << std::endl;
            // Solver-backend provenance: what was ASKED FOR and what actually
            // ran. SolverFactory serves a "--library Accelerate" request with
            // SuiteSparse whenever this build has it, so the request alone is not
            // a record of the run. See output_formatter.hpp.
            std::cout << wfes::cli::OutputFormatter::library_provenance_json(options.library);
            std::cout << "    \"population_size\": " << options.population_size << "," << std::endl;
            std::cout << "    \"selection_coefficient\": " << options.selection_coefficient << "," << std::endl;
            std::cout << "    \"dominance\": " << options.dominance << "," << std::endl;
            std::cout << "    \"backward_mutation\": " << options.backward_mutation << "," << std::endl;
            std::cout << "    \"forward_mutation\": " << options.forward_mutation << "," << std::endl;
            std::cout << "    \"alpha\": " << options.alpha << "," << std::endl;
            std::cout << "    \"n_moments\": " << k << std::endl;
            std::cout << "  }," << std::endl;
            std::cout << "  \"results\": {" << std::endl;
            std::cout << "    \"mean\": " << mean << "," << std::endl;
            std::cout << "    \"std_dev\": " << std_dev << "," << std::endl;
            std::cout << "    \"raw_moments\": [";
            for (llong i = 1; i <= k; i++) {
                std::cout << moment(i);
                if (i < k) std::cout << ", ";
            }
            std::cout << "]" << std::endl;
            std::cout << "  }" << std::endl;
            std::cout << "}" << std::endl;
        } else if (options.csv_output) {
            // CSV format
            std::cout << "moment,value" << std::endl;
            std::cout << "mean," << mean << std::endl;
            std::cout << "std_dev," << std_dev << std::endl;
            for (llong i = 1; i <= k; i++) {
                std::cout << i << "," << moment(i) << std::endl;
            }
        } else {
            // Human-readable format
            std::cout << "Mean: " << mean << std::endl;
            std::cout << "Standard deviation: " << std_dev << std::endl;
            std::cout << "Raw moments: " << std::endl;
            for (llong i = 1; i <= k; i++) {
                std::cout << i << "\t" << moment(i) << std::endl;
            }
        }
        
        // Output to file if requested
        if (!options.output_N_path.empty()) {
            CLI::OutputFormatter::write_matrix_to_file(m, options.output_N_path);
        }
        
        // Print timing information if verbose
        if (options.verbose) {
            t_end = std::chrono::system_clock::now();
            time_diff dt = t_end - t_start;
            std::cout << "Total runtime: " << dt.count() << " s" << std::endl;
        }
        
        // Clean up
        delete solver;
        
    } catch (const args::Help&) {
        // Help was requested, which already printed the help message
        return EXIT_SUCCESS;
    } catch (const args::Error& e) {
        std::cerr << "Argument parsing error: " << e.what() << std::endl;
        return EXIT_FAILURE;
    } catch (const std::exception& e) {
        std::cerr << "Error: " << e.what() << std::endl;
        return EXIT_FAILURE;
    }
    
    return EXIT_SUCCESS;
}