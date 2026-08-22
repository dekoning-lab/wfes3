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

// MKL constants are provided by the library

// Include the CLI utilities
#include "args_parser.hpp"
#include "output_formatter.hpp"
#include "initial_distribution.h"

// Include the core library components
#include "types.h"
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
        // Parse command-line arguments for time distribution dual tool
        CLI::CommandLineOptions options = CLI::Args_Parser::parse_time_dist_dual_args(argc, argv);
        
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
            // No integration_cutoff echo: this tool's parser hardcodes
            // options.integration_cutoff to 1e-10 and routes the user's -c to
            // distribution_cutoff, so echoing it printed a constant that the
            // computation never reads and that ignored what the user typed. The
            // value that actually governs the run is reported instead.
            std::cout << "distribution_cutoff = " << options.distribution_cutoff << std::endl;
            std::cout << "recurrent_mutation = " << (options.recurrent_mutation ? "true" : "false") << std::endl;
        }
        
        // Library to use
        std::string library = options.library;
        
        // Create Wright-Fisher dual mutation matrix
        WF::Matrix wf = WF::DualMutation(
            options.population_size, options.population_size, 
            options.selection_coefficient, options.dominance,
            options.backward_mutation, options.forward_mutation,
            options.recurrent_mutation, options.alpha,
            options.verbose, options.block_size, library
        );
        
        // Output matrices if requested
        if (!options.output_Q_path.empty()) {
            wf.Q->saveSparseCsv(options.output_Q_path);
        }
        if (!options.output_R_path.empty()) {
            CLI::OutputFormatter::write_matrix_to_file(wf.R, options.output_R_path);
        }
        
        // Phase-type distribution matrix: [time, P_ext_t, P_fix_t, P_ext_t+P_fix_t, cdf]
        dmat PH(options.max_t, 5);
        
        // Initial state vector. Without --initial this is a point mass on the
        // first state, which is what the tool has always assumed; with it, the
        // user supplies the whole distribution over this model's states.
        dvec c = dvec::Zero(2 * options.population_size);
        if (!options.initial_distribution_path.empty()) {
            c = CLI::load_initial_distribution(
                options.initial_distribution_path, 2 * options.population_size,
                "allele counts 0..2N-1, starting from 0 copies");
        } else {
            c(0) = 1;
        }
        
        double cdf = 0;
        llong i;
        for (i = 0; cdf < options.distribution_cutoff && i < options.max_t; i++) {
            
            // Calculate extinction and fixation probabilities at time t
            double P_ext_t = wf.R.col(0).dot(c);  // Extinction column
            double P_fix_t = wf.R.col(1).dot(c);  // Fixation column
            cdf += P_fix_t + P_ext_t;
            
            // Store results in phase-type distribution matrix
            PH(i, 0) = i + 1;          // Time (1-indexed)
            PH(i, 1) = P_ext_t;       // P_ext at time t
            PH(i, 2) = P_fix_t;       // P_fix at time t  
            PH(i, 3) = P_ext_t + P_fix_t; // Total absorption probability at time t
            PH(i, 4) = cdf;           // Cumulative distribution function
            
            // Advance to next time step: c = Q * c
            c = wf.Q->multiply(c, true);
        }
        
        // Resize to actual number of computed time steps
        PH.conservativeResize(i, 5);

        // A stopping rule that is already satisfied before the first generation
        // (--distribution-cutoff 0) ends the loop with zero rows. That used to
        // be an exit-0 "success" whose entire output was a CSV header --
        // indistinguishable, to anything downstream, from a model in which
        // absorption never happens. There is no distribution here to report.
        if (i == 0) {
            std::ostringstream msg;
            msg << "No time steps were computed: --distribution-cutoff ("
                << options.distribution_cutoff << ") was already satisfied before"
                   " the first generation, so there is no time distribution to"
                   " report. Use a cutoff greater than 0 (and at most 1).";
            throw std::runtime_error(msg.str());
        }
        if (!std::isfinite(cdf)) {
            throw std::runtime_error(
                "The accumulated absorption mass is not finite; the iteration has"
                " broken down and no distribution can be reported.");
        }

        // Did the run finish, or just run out of generations? The loop stops on
        // EITHER the cutoff or --max-t and said nothing about which. Hitting
        // max_t truncates the distribution, and every moment computed from it
        // is then a lower bound.
        //
        // Computed before the normalisation below, which depends on it.
        const bool reached_cutoff = cdf >= options.distribution_cutoff;
        if (!reached_cutoff) {
            std::cerr << "Warning: stopped at --max-t (" << options.max_t
                      << ") with only " << cdf << " of the distribution's mass;"
                      << " the cutoff " << options.distribution_cutoff
                      << " was not reached. Moments computed from this window are"
                      << " underestimates -- raise --max-t.\n";
        }

        // Normalize CDF to get conditional distribution
        // The CDF should represent P(T <= t | absorption occurs)
        //
        // ONLY when the run actually converged. Dividing a truncated CDF by the
        // mass it happened to capture makes it end at exactly 1.0, which is the
        // signature of a complete distribution -- so a run that captured
        // 3.4e-06 of its mass printed a CDF ending in 1 and was, in the CSV and
        // plain-text paths (neither of which carries reached_cutoff),
        // indistinguishable from a converged one. Left raw, the partial CDF
        // discloses its own truncation in every output format and stays
        // consistent with final_cdf.
        // Named once so the JSON disclosure below (task CX-disclose, PI
        // decision "Rescale + disclose") can never drift out of sync with
        // the renormalisation it is disclosing -- it is the exact condition
        // that gates the division, not a separately-derived equivalent.
        const bool cdf_was_rescaled = reached_cutoff && cdf > 0;
        if (cdf_was_rescaled) {
            for (llong j = 0; j < i; j++) {
                PH(j, 4) = PH(j, 4) / cdf;  // Normalize CDF
            }
        }

        // Disclose the rescale itself when the cutoff that drove it is far
        // enough from 1 to matter for interpretation. See time_dist_main.cpp
        // for the full rationale behind the 0.99 threshold: at or below it,
        // the rescale discards a modeling-relevant slice of the tail rather
        // than cleaning up residual truncation noise near the ~1e-8-of-1
        // default, and the resulting "CDF -> 1" is conditional on absorption
        // occurring within the captured window, not the unconditional
        // statement it looks like. CSV and plain text carry no
        // reached_cutoff or cdf_rescaled field at all, so this stderr note
        // -- printed before the --json/--csv/plain branch below, hence
        // format-agnostic -- is their only disclosure channel; JSON gets
        // both.
        if (cdf_was_rescaled && options.distribution_cutoff <= 0.99) {
            std::cerr << "Note: --distribution-cutoff " << options.distribution_cutoff
                      << " is well below 1, so the CDF was rescaled to end at 1.0"
                         " from the captured mass " << cdf << "; the reported"
                         " distribution is therefore conditional on absorption"
                         " occurring within the computed time window, not an"
                         " unconditional probability.\n";
        }

        // Output phase-type distribution if requested
        if (!options.output_P_path.empty()) {
            CLI::OutputFormatter::write_matrix_to_file(PH, options.output_P_path);
        }

        // Print summary statistics
        if (options.verbose) {
            std::cout << "Computed " << i << " time steps" << std::endl;
            std::cout << "Final CDF: " << cdf << std::endl;
            if (i > 0) {
                std::cout << "Last extinction probability: " << PH(i-1, 1) << std::endl;
                std::cout << "Last fixation probability: " << PH(i-1, 2) << std::endl;
            }
        }
        
        // Structured output. --json and --csv were declared and validated by the
        // parser but never consumed here, so the flags were silently ignored and
        // the tool always emitted the truncated human-readable table below. That
        // is also why the GUI could only fall back to scraping that table, which
        // mislabelled its 4th column and dropped the CDF entirely.
        //
        // Columns of PH: 0 time, 1 P_ext, 2 P_fix, 3 P_total, 4 CDF.
        if (options.json_output) {
            std::cout << "{" << std::endl;
            std::cout << "  \"model\": \"time_dist_dual\"," << std::endl;
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
            std::cout << "    \"max_t\": " << options.max_t << std::endl;
            std::cout << "  }," << std::endl;
            std::cout << "  \"statistics\": {" << std::endl;
            std::cout << "    \"time_steps_computed\": " << i << "," << std::endl;
            std::cout << "    \"final_cdf\": " << cdf << "," << std::endl;
            std::cout << "    \"distribution_cutoff\": " << options.distribution_cutoff << "," << std::endl;
            std::cout << "    \"reached_cutoff\": " << (reached_cutoff ? "true" : "false");
            // Additive disclosure fields (task CX-disclose, PI decision
            // "Rescale + disclose"): present exactly when cdf_was_rescaled --
            // see the comment at that block, above -- actually divided
            // final_cdf's column down to end at 1.0; a run that stopped at
            // --max-t instead has neither key, honestly ABSENT rather than
            // printed with a false/null sentinel. cdf_pre_rescale_mass
            // mirrors final_cdf's own value verbatim (the scalar cdf is
            // never itself divided, only the PH column is) -- a by-name
            // convenience so a reader does not have to already know that
            // final_cdf happens to equal the pre-rescale mass.
            if (cdf_was_rescaled) {
                std::cout << "," << std::endl;
                std::cout << "    \"cdf_rescaled\": true," << std::endl;
                std::cout << "    \"cdf_pre_rescale_mass\": " << cdf;
            }
            std::cout << std::endl;
            std::cout << "  }," << std::endl;
            std::cout << "  \"distribution\": [" << std::endl;
            for (llong j = 0; j < i; j++) {
                std::cout << "    {";
                std::cout << "\"time\": " << PH(j, 0) << ", ";
                std::cout << "\"P_ext\": " << PH(j, 1) << ", ";
                std::cout << "\"P_fix\": " << PH(j, 2) << ", ";
                std::cout << "\"P_total\": " << PH(j, 3) << ", ";
                std::cout << "\"cdf_total\": " << PH(j, 4);
                std::cout << "}";
                if (j < i - 1) std::cout << ",";
                std::cout << std::endl;
            }
            std::cout << "  ]" << std::endl;
            std::cout << "}" << std::endl;
        } else if (options.csv_output) {
            std::cout << "time,P_ext,P_fix,P_total,cdf_total" << std::endl;
            for (llong j = 0; j < i; j++) {
                std::cout << PH(j, 0) << "," << PH(j, 1) << "," << PH(j, 2) << ","
                          << PH(j, 3) << "," << PH(j, 4) << std::endl;
            }
        }
        // Default output: show first few and last few rows of the distribution
        else if (options.output_P_path.empty() && !options.verbose) {
            std::cout << "Dual mutation time distribution of fixation/extinction (first 10 and last 5 time points):" << std::endl;
            std::cout << "Time\tP_ext\tP_fix\tP_total\tCDF" << std::endl;
            
            // Show first 10 rows
            llong show_first = std::min(10LL, i);
            for (llong j = 0; j < show_first; j++) {
                std::cout << std::fixed << std::setprecision(0) << PH(j, 0) << "\t"
                         << std::scientific << std::setprecision(6) 
                         << PH(j, 1) << "\t" << PH(j, 2) << "\t" 
                         << PH(j, 3) << "\t" << PH(j, 4) << std::endl;
            }
            
            // Show last 5 rows if we have more than 15 total
            if (i > 15) {
                std::cout << "..." << std::endl;
                for (llong j = std::max(10LL, i-5); j < i; j++) {
                    std::cout << std::fixed << std::setprecision(0) << PH(j, 0) << "\t"
                             << std::scientific << std::setprecision(6) 
                             << PH(j, 1) << "\t" << PH(j, 2) << "\t" 
                             << PH(j, 3) << "\t" << PH(j, 4) << std::endl;
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