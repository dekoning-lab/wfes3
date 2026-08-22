#include <iostream>
#include <iomanip>
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
        // Parse command-line arguments for phase-type distribution tool
        CLI::CommandLineOptions options = CLI::Args_Parser::parse_phase_type_dist_args(argc, argv);
        
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
        
        // Phase-type distribution matrix: [time, P_abs_t, cdf] (3 columns for fixation-only)
        dmat PH(options.max_t, 3);
        
        // Initial state vector. Without --initial this is a point mass on the
        // first state, which is what the tool has always assumed; with it, the
        // user supplies the whole distribution over this model's states.
        dvec c = dvec::Zero(2 * options.population_size);
        if (!options.initial_distribution_path.empty()) {
            c = CLI::load_initial_distribution(
                options.initial_distribution_path, 2 * options.population_size,
                "allele counts 0..2N-1 in the fixation-only model");
        } else {
            c(0) = 1;
        }
        
        // Create Wright-Fisher matrix with fixation-only absorbing state (FIXATION_ONLY)
        WF::Matrix wf = WF::Single(
            options.population_size, options.population_size, 
            WF::FIXATION_ONLY,
            options.selection_coefficient, options.dominance,
            options.backward_mutation, options.forward_mutation,
            options.recurrent_mutation, options.alpha,
            options.verbose, options.block_size, library
        );
        
        // Get fixation column (first and only column for FIXATION_ONLY)
        dvec R = wf.R.col(0);

        // --output-Q / --output-R. Both were offered by the GUI and accepted by
        // nothing; the matrices they name are right here.
        if (!options.output_Q_path.empty()) {
            wf.Q->saveMarket(options.output_Q_path);
        }
        if (!options.output_R_path.empty()) {
            CLI::OutputFormatter::write_matrix_to_file(wf.R, options.output_R_path);
        }
        
        double cdf = 0;
        llong i;
        for (i = 0; cdf < options.distribution_cutoff && i < options.max_t; i++) {
            
            // Calculate absorption (fixation) probability at time t
            double P_abs_t = R.dot(c);
            cdf += P_abs_t;
            
            // Store results in phase-type distribution matrix
            PH(i, 0) = i + 1;      // Time (1-indexed)
            PH(i, 1) = P_abs_t;   // P_abs at time t
            PH(i, 2) = cdf;       // Cumulative distribution function
            
            // Advance to next time step: c = Q * c
            c = wf.Q->multiply(c, true);
        }
        

        // Did the run actually finish, or did it just run out of generations?
        //
        // The loop above stops on EITHER the cutoff or --max-t, and said
        // nothing about which. Hitting max_t truncates the distribution, and
        // every moment computed from it is then a lower bound: at N=100, s=0
        // with the GUI's own defaults this captured 91.8% of the mass and put
        // the mean at 311,065 against an exact 400,793 from
        // phase_type_moments -- 22% low, reported as if complete.
        const bool reached_cutoff = cdf >= options.distribution_cutoff;
        if (!reached_cutoff) {
            std::cerr << "Warning: stopped at --max-t (" << options.max_t
                      << ") with only " << cdf << " of the distribution's mass;"
                      << " the cutoff " << options.distribution_cutoff
                      << " was not reached. Moments computed from this window are"
                      << " underestimates -- raise --max-t, or use"
                      << " phase_type_moments for exact moments.\n";
        }

        // Resize to actual number of computed time steps
        PH.conservativeResize(i, 3);
        
        // Output phase-type distribution if requested
        if (!options.output_P_path.empty()) {
            CLI::OutputFormatter::write_matrix_to_file(PH, options.output_P_path);
        }
        
        // Print summary statistics
        if (options.verbose) {
            std::cout << "Computed " << i << " time steps" << std::endl;
            std::cout << "Final CDF: " << cdf << std::endl;
            if (i > 0) {
                std::cout << "Last absorption probability: " << PH(i-1, 1) << std::endl;
            }
        }
        
        // Structured output. --json and --csv were declared and validated by the
        // parser but never consumed here, so both flags were silently ignored
        // and the tool always emitted the truncated table below (preceded by the
        // ASCII banner, now suppressed for structured output). That is why the
        // GUI's phase-type distribution view could never populate: it parsed for
        // comma-delimited rows while the tool emitted tab-delimited text.
        //
        // Columns of PH: 0 time, 1 P_abs, 2 CDF.
        if (options.json_output) {
            std::cout << "{" << std::endl;
            std::cout << "  \"model\": \"phase_type_dist\"," << std::endl;
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
            std::cout << "    \"final_cdf\": " << (i > 0 ? PH(i - 1, 2) : 0.0) << "," << std::endl;
            std::cout << "    \"distribution_cutoff\": " << options.distribution_cutoff << "," << std::endl;
            std::cout << "    \"reached_cutoff\": " << (reached_cutoff ? "true" : "false") << std::endl;
            std::cout << "  }," << std::endl;
            std::cout << "  \"distribution\": [" << std::endl;
            for (llong j = 0; j < i; j++) {
                std::cout << "    {";
                std::cout << "\"time\": " << PH(j, 0) << ", ";
                std::cout << "\"P_abs\": " << PH(j, 1) << ", ";
                std::cout << "\"cdf\": " << PH(j, 2);
                std::cout << "}";
                if (j < i - 1) std::cout << ",";
                std::cout << std::endl;
            }
            std::cout << "  ]" << std::endl;
            std::cout << "}" << std::endl;
        } else if (options.csv_output) {
            std::cout << "time,P_abs,cdf" << std::endl;
            for (llong j = 0; j < i; j++) {
                std::cout << PH(j, 0) << "," << PH(j, 1) << "," << PH(j, 2) << std::endl;
            }
        }
        // Default output: show first few and last few rows of the distribution
        else if (options.output_P_path.empty() && !options.verbose) {
            std::cout << "Phase-type distribution of absorption times (fixation-only model):" << std::endl;
            std::cout << "Time\tP_abs\tCDF" << std::endl;
            
            // Show first 10 rows
            llong show_first = std::min(10LL, i);
            for (llong j = 0; j < show_first; j++) {
                std::cout << std::fixed << std::setprecision(0) << PH(j, 0) << "\t"
                         << std::scientific << std::setprecision(6) 
                         << PH(j, 1) << "\t" << PH(j, 2) << std::endl;
            }
            
            // Show last 5 rows if we have more than 15 total
            if (i > 15) {
                std::cout << "..." << std::endl;
                for (llong j = std::max(10LL, i-5); j < i; j++) {
                    std::cout << std::fixed << std::setprecision(0) << PH(j, 0) << "\t"
                             << std::scientific << std::setprecision(6) 
                             << PH(j, 1) << "\t" << PH(j, 2) << std::endl;
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