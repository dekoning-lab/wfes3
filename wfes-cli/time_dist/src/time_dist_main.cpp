#include <iostream>
#include <iomanip>
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

// Include the CLI utilities
#include "args_parser.hpp"
#include "output_formatter.hpp"
#include "initial_distribution.h"

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

// Namespace aliases for shorter code
namespace CLI = wfes::cli;
using namespace wfes;

int main(int argc, char const *argv[]) {
    time_point t_start, t_end;
    
    try {
        // Parse command-line arguments for time distribution tool
        CLI::CommandLineOptions options = CLI::Args_Parser::parse_time_dist_args(argc, argv);
        
        // Start timing if verbose
        if (options.verbose) {
            t_start = std::chrono::system_clock::now();
        }
        
        // Set thread count. The MKL branch alone left -t a silent no-op on any
        // build without Pardiso (i.e. every macOS build): OpenMP is the only
        // threading control that exists there, and wfes-lib's matrix assembly
        // is OpenMP-parallel regardless of the solver backend.
        if (options.n_threads > 0) {
#ifdef OMP
            omp_set_num_threads(options.n_threads);
#endif
#ifdef WFES_USE_MKL
            mkl_set_num_threads(options.n_threads);
#endif
        }
        
        // Display parameters
        if (options.verbose) {
            std::cout << "N = " << options.population_size << std::endl;
            std::cout << "s = " << options.selection_coefficient << std::endl;
            std::cout << "h = " << options.dominance << std::endl;
            std::cout << "u = " << options.backward_mutation << std::endl;
            std::cout << "v = " << options.forward_mutation << std::endl;
            std::cout << "a = " << options.alpha << std::endl;
            std::cout << "max_t = " << options.max_t << std::endl;
            std::cout << "integration_cutoff = " << options.integration_cutoff << std::endl;
            std::cout << "recurrent_mutation = " << (options.recurrent_mutation ? "true" : "false") << std::endl;
        }
        
        // Library to use
        std::string library = options.library;
        
        // How much mass each branch can ever accumulate.
        //
        // The loop below stops when both time distributions have reached
        // --distribution-cutoff of their own mass. It cannot test that against
        // the cutoff directly: cdf_ext converges to P_ext and cdf_fix to P_fix,
        // and those sum to 1, so for any cutoff above 0.5 at most one of them
        // can ever exceed it. The old condition (cdf_ext < cutoff || cdf_fix <
        // cutoff) was therefore never satisfiable and every run computed the
        // full --max-t regardless of how quickly it had actually converged.
        //
        // B = (I-Q)^-1 R gives the totals exactly, in one factorization, since
        // sum_t Q^t R = (I-Q)^-1 R. Scoped so the matrix it mutates is freed
        // before the iteration matrix is built: subtractIdentity() overwrites Q
        // with I-Q in place, and the loop needs Q itself, so this is a separate
        // assembly rather than an undo of that subtraction (undoing it would
        // reconstruct each diagonal as 1-(1-d), which silently loses small
        // entries in the matrix the whole run depends on).
        double P_ext_total = 0, P_fix_total = 0;
        bool have_totals = false;
        try {
            WF::Matrix wf_abs = WF::Single(
                options.population_size, options.population_size,
                WF::BOTH_ABSORBING,
                options.selection_coefficient, options.dominance,
                options.backward_mutation, options.forward_mutation,
                options.recurrent_mutation, options.alpha,
                false, options.block_size, library
            );
            wf_abs.Q->subtractIdentity();
            solver::Solver *abs_solver = solver::SolverFactory::createSolver(
                library, *wf_abs.Q, MKL_PARDISO_MATRIX_TYPE_REAL_UNSYMMETRIC,
                MKL_PARDISO_MSG_QUIET);
            abs_solver->preprocess();

            dvec R_ext = wf_abs.R.col(0);
            dvec R_fix = wf_abs.R.col(1);
            dvec B_ext = abs_solver->solve(R_ext, false);
            dvec B_fix = abs_solver->solve(R_fix, false);
            delete abs_solver;

            // Row 0: the iteration starts from one copy (c(0) = 1 below).
            P_ext_total = B_ext(0);
            P_fix_total = B_fix(0);
            have_totals = true;

            // Both boundaries absorb here, so the two must account for all of
            // the mass. If they do not, the factorization is not trustworthy
            // and neither is a stopping rule built on it.
            const double closure = P_ext_total + P_fix_total;
            if (!std::isfinite(closure) || std::abs(closure - 1.0) > 1e-6) {
                std::cerr << "Warning: absorption probabilities sum to " << closure
                          << ", not 1; falling back to --max-t as the only stopping"
                             " condition\n";
                have_totals = false;
            }
            if (options.verbose && have_totals) {
                std::cout << "P_ext (exact) = " << P_ext_total
                          << ", P_fix (exact) = " << P_fix_total << std::endl;
            }
        } catch (const std::exception &e) {
            std::cerr << "Warning: could not precompute absorption probabilities ("
                      << e.what() << "); falling back to --max-t as the only"
                         " stopping condition\n";
            have_totals = false;
        }

        // Create Wright-Fisher matrix with both absorbing states (BOTH_ABSORBING)
        WF::Matrix wf = WF::Single(
            options.population_size, options.population_size, 
            WF::BOTH_ABSORBING,
            options.selection_coefficient, options.dominance,
            options.backward_mutation, options.forward_mutation,
            options.recurrent_mutation, options.alpha,
            options.verbose, options.block_size, library
        );
        
        // Output matrices if requested
        if (!options.output_Q_path.empty()) {
            wf.Q->saveMarket(options.output_Q_path);
        }
        if (!options.output_R_path.empty()) {
            CLI::OutputFormatter::write_matrix_to_file(wf.R, options.output_R_path);
        }
        
        // Phase-type distribution matrix: [time, P_ext_t, P_fix_t, P_ext_t+P_fix_t, cdf_ext, cdf_fix, cdf_total]
        dmat PH(options.max_t, 7);
        
        // Initial state vector. Without --initial this is a point mass on the
        // first state, which is what the tool has always assumed; with it, the
        // user supplies the whole distribution over this model's states.
        dvec c = dvec::Zero(2 * options.population_size - 1);
        if (!options.initial_distribution_path.empty()) {
            c = CLI::load_initial_distribution(
                options.initial_distribution_path, 2 * options.population_size - 1,
                "the transient states, allele counts 1..2N-1");
        } else {
            c(0) = 1;
        }
        
        double cdf_ext = 0, cdf_fix = 0, cdf_total = 0;
        double mean_ext = 0, mean_fix = 0;
        double m2_ext = 0, m2_fix = 0;  // Second moments for variance calculation
        
        // Continue until BOTH time distributions have reached the cutoff
        // fraction OF THEIR OWN mass. Each target is the cutoff scaled by what
        // that branch converges to, which is the comparison the flag has always
        // meant; testing the unscaled cutoff made the condition unsatisfiable.
        // A branch of probability zero has target zero and is satisfied at once.
        //
        // Without the totals (the factorization failed, and the warning above
        // said so) the targets are unreachable by construction, which preserves
        // the previous behaviour of running to --max-t.
        const double target_ext = have_totals ? options.distribution_cutoff * P_ext_total : 2.0;
        const double target_fix = have_totals ? options.distribution_cutoff * P_fix_total : 2.0;

        llong i;
        for (i = 0; (cdf_ext < target_ext || cdf_fix < target_fix) && i < options.max_t; i++) {
            
            // Calculate extinction and fixation probabilities at time t
            double P_ext_t = wf.R.col(0).dot(c);  // Extinction column
            double P_fix_t = wf.R.col(1).dot(c);  // Fixation column
            
            // Update CDFs
            cdf_ext += P_ext_t;
            cdf_fix += P_fix_t;
            cdf_total = cdf_ext + cdf_fix;
            
            // Update moments for mean and variance calculations
            double t = i + 1;  // Time is 1-indexed
            mean_ext += t * P_ext_t;
            mean_fix += t * P_fix_t;
            m2_ext += t * t * P_ext_t;
            m2_fix += t * t * P_fix_t;
            
            // Store results in phase-type distribution matrix
            PH(i, 0) = t;                    // Time (1-indexed)
            PH(i, 1) = P_ext_t;             // P_ext at time t
            PH(i, 2) = P_fix_t;             // P_fix at time t  
            PH(i, 3) = P_ext_t + P_fix_t;   // Total absorption probability at time t
            PH(i, 4) = cdf_ext;             // CDF for extinction
            PH(i, 5) = cdf_fix;             // CDF for fixation
            PH(i, 6) = cdf_total;           // Total CDF
            
            // Advance to next time step: c = Q * c
            c = wf.Q->multiply(c, true);
        }
        
        // Did both branches finish, or did the run just hit --max-t? Same
        // disclosure as the other distribution tools: a truncated window makes
        // every moment computed from it a lower bound, and the loop said
        // nothing about which condition ended it.
        const bool reached_cutoff = have_totals && cdf_ext >= target_ext && cdf_fix >= target_fix;
        if (!reached_cutoff && i >= options.max_t) {
            std::cerr << "Warning: stopped at --max-t (" << options.max_t
                      << ") with " << cdf_ext << " of the extinction branch and "
                      << cdf_fix << " of the fixation branch absorbed; the cutoff "
                      << options.distribution_cutoff << " of each branch's own mass"
                      << " was not reached. Moments from this window are"
                      << " underestimates -- raise --max-t.\n";
        }

        // Normalize CDFs to get conditional distributions
        // The CDFs stored in PH should represent P(T <= t | event occurs)
        if (cdf_ext > 0 || cdf_fix > 0) {
            for (llong j = 0; j < i; j++) {
                if (cdf_ext > 0) {
                    PH(j, 4) = PH(j, 4) / cdf_ext;  // Normalize extinction CDF
                }
                if (cdf_fix > 0) {
                    PH(j, 5) = PH(j, 5) / cdf_fix;  // Normalize fixation CDF
                }
                if (cdf_total > 0) {
                    PH(j, 6) = PH(j, 6) / cdf_total;  // Normalize total CDF
                }
            }
        }
        
        // Calculate standard deviations
        // Var(T) = E[T^2] - (E[T])^2
        // But we need to normalize by the total probability for conditional expectations
        double std_ext = 0, std_fix = 0;
        if (cdf_ext > 0) {
            double mean_ext_cond = mean_ext / cdf_ext;  // Conditional mean given extinction
            double m2_ext_cond = m2_ext / cdf_ext;      // Conditional second moment
            std_ext = std::sqrt(m2_ext_cond - mean_ext_cond * mean_ext_cond);
        }
        if (cdf_fix > 0) {
            double mean_fix_cond = mean_fix / cdf_fix;  // Conditional mean given fixation
            double m2_fix_cond = m2_fix / cdf_fix;      // Conditional second moment
            std_fix = std::sqrt(m2_fix_cond - mean_fix_cond * mean_fix_cond);
        }
        
        // Resize to actual number of computed time steps
        PH.conservativeResize(i, 7);
        
        // Output phase-type distribution if requested
        if (!options.output_P_path.empty()) {
            CLI::OutputFormatter::write_matrix_to_file(PH, options.output_P_path);
        }
        
        // Print results based on output format
        if (options.json_output) {
            // JSON output with statistics and distribution data
            std::cout << "{" << std::endl;
            std::cout << "  \"model\": \"time_dist\"," << std::endl;
            std::cout << "  \"parameters\": {" << std::endl;
            std::cout << "    \"population_size\": " << options.population_size << "," << std::endl;
            std::cout << "    \"selection_coefficient\": " << options.selection_coefficient << "," << std::endl;
            std::cout << "    \"dominance\": " << options.dominance << "," << std::endl;
            std::cout << "    \"backward_mutation\": " << options.backward_mutation << "," << std::endl;
            std::cout << "    \"forward_mutation\": " << options.forward_mutation << "," << std::endl;
            std::cout << "    \"alpha\": " << options.alpha << "," << std::endl;
            std::cout << "    \"integration_cutoff\": " << options.integration_cutoff << "," << std::endl;
            std::cout << "    \"max_t\": " << options.max_t << std::endl;
            std::cout << "  }," << std::endl;
            std::cout << "  \"statistics\": {" << std::endl;
            std::cout << "    \"time_steps_computed\": " << i << "," << std::endl;
            std::cout << "    \"distribution_cutoff\": " << options.distribution_cutoff << "," << std::endl;
            std::cout << "    \"reached_cutoff\": " << (reached_cutoff ? "true" : "false") << "," << std::endl;
            std::cout << "    \"total_probability_extinction\": " << cdf_ext << "," << std::endl;
            std::cout << "    \"total_probability_fixation\": " << cdf_fix << "," << std::endl;
            std::cout << "    \"total_probability_absorption\": " << cdf_total << "," << std::endl;
            if (cdf_ext > 0) {
                std::cout << "    \"mean_extinction\": " << mean_ext / cdf_ext << "," << std::endl;
                std::cout << "    \"std_extinction\": " << std_ext << "," << std::endl;
            }
            if (cdf_fix > 0) {
                std::cout << "    \"mean_fixation\": " << mean_fix / cdf_fix << "," << std::endl;
                std::cout << "    \"std_fixation\": " << std_fix << "," << std::endl;
            }
            std::cout << "    \"final_time\": " << i << std::endl;
            std::cout << "  }," << std::endl;
            std::cout << "  \"distribution\": [" << std::endl;
            for (llong j = 0; j < i; j++) {
                std::cout << "    {";
                std::cout << "\"time\": " << PH(j, 0) << ", ";
                std::cout << "\"P_ext\": " << PH(j, 1) << ", ";
                std::cout << "\"P_fix\": " << PH(j, 2) << ", ";
                std::cout << "\"P_total\": " << PH(j, 3) << ", ";
                std::cout << "\"cdf_ext\": " << PH(j, 4) << ", ";
                std::cout << "\"cdf_fix\": " << PH(j, 5) << ", ";
                std::cout << "\"cdf_total\": " << PH(j, 6);
                std::cout << "}";
                if (j < i - 1) std::cout << ",";
                std::cout << std::endl;
            }
            std::cout << "  ]" << std::endl;
            std::cout << "}" << std::endl;
        } else if (options.csv_output) {
            // CSV output
            std::cout << "time,P_ext,P_fix,P_total,cdf_ext,cdf_fix,cdf_total" << std::endl;
            for (llong j = 0; j < i; j++) {
                std::cout << PH(j, 0) << "," << PH(j, 1) << "," << PH(j, 2) << "," 
                         << PH(j, 3) << "," << PH(j, 4) << "," << PH(j, 5) << "," << PH(j, 6) << std::endl;
            }
        } else {
            // Check if we should output human-readable statistics (when verbose flag is set)
            if (options.verbose) {
                // Human-readable output with statistics
                std::cout << "Time distribution statistics:" << std::endl;
                std::cout << "================================" << std::endl;
                if (cdf_ext > 0) {
                    std::cout << "Extinction:" << std::endl;
                    std::cout << "  Mean time: " << mean_ext / cdf_ext << std::endl;
                    std::cout << "  Std deviation: " << std_ext << std::endl;
                    std::cout << "  Probability: " << cdf_ext << std::endl;
                }
                if (cdf_fix > 0) {
                    std::cout << "Fixation:" << std::endl;
                    std::cout << "  Mean time: " << mean_fix / cdf_fix << std::endl;
                    std::cout << "  Std deviation: " << std_fix << std::endl;
                    std::cout << "  Probability: " << cdf_fix << std::endl;
                }
                std::cout << "Total absorption probability: " << cdf_total << std::endl;
                std::cout << "Time steps computed: " << i << std::endl;
                std::cout << std::endl;
                
                std::cout << "Time distribution table (first 10 and last 5 time points):" << std::endl;
                std::cout << "Time\tP_ext\tP_fix\tP_total\tCDF_ext\tCDF_fix\tCDF_total" << std::endl;
            
                // Show first 10 rows
                llong show_first = std::min(10LL, i);
                for (llong j = 0; j < show_first; j++) {
                    std::cout << std::fixed << std::setprecision(0) << PH(j, 0) << "\t"
                             << std::scientific << std::setprecision(6) 
                             << PH(j, 1) << "\t" << PH(j, 2) << "\t" 
                             << PH(j, 3) << "\t" << PH(j, 4) << "\t"
                             << PH(j, 5) << "\t" << PH(j, 6) << std::endl;
                }
                
                // Show last 5 rows if we have more than 15 total
                if (i > 15) {
                    std::cout << "..." << std::endl;
                    for (llong j = std::max(10LL, i-5); j < i; j++) {
                        std::cout << std::fixed << std::setprecision(0) << PH(j, 0) << "\t"
                                 << std::scientific << std::setprecision(6) 
                                 << PH(j, 1) << "\t" << PH(j, 2) << "\t" 
                                 << PH(j, 3) << "\t" << PH(j, 4) << "\t"
                                 << PH(j, 5) << "\t" << PH(j, 6) << std::endl;
                    }
                }
            } else {
                // Default output - simple matrix format for GUI compatibility
                // Output format: time P_ext P_fix P_total cdf_ext cdf_fix cdf_total
                for (llong j = 0; j < i; j++) {
                    std::cout << PH(j, 0) << " " << PH(j, 1) << " " << PH(j, 2) << " " 
                             << PH(j, 3) << " " << PH(j, 4) << " " << PH(j, 5) << " " << PH(j, 6) << std::endl;
                }
            }
        }
        
        // Print timing information
        if (options.verbose) {
            t_end = std::chrono::system_clock::now();
            time_diff dt = t_end - t_start;
            std::cout << "Total execution time: " << dt.count() << " s" << std::endl;
        }
        
    } catch (const std::exception& e) {
        std::cerr << "Error: " << e.what() << std::endl;
        return EXIT_FAILURE;
    }
    
    return EXIT_SUCCESS;
}