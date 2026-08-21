#include <iostream>
#include <iomanip>
#include <string>
#include <vector>
#include <chrono>
#include <cstdlib>  // for setenv
#include <limits>
#include "backend_config.h"
#ifdef WFES_USE_MKL
#include <mkl.h>
#endif
#ifdef OMP
#include <omp.h>
#endif

// MKL constants are provided by the library

// Include the CLI utilities
#include "args_parser.hpp"
#include "output_formatter.hpp"
#include "initial_distribution.h"
#include "banner.h"

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
    time_point t_start, t_end;
    
    try {
        // Parse command-line arguments for time distribution SGV tool
        CLI::CommandLineOptions options = CLI::Args_Parser::parse_time_dist_sgv_args(argc, argv);
        
        // Start timing if verbose
        if (options.verbose) {
            t_start = std::chrono::system_clock::now();
        }
        
        // Set thread count
        #ifdef OMP
            omp_set_num_threads(options.n_threads);
        #endif
        #ifdef WFES_USE_MKL
            mkl_set_num_threads(options.n_threads);
        #endif
        
        // Parse vector parameters
        dvec selection_coefficient = parse_vector(options.selection_coefficients_str);
        llong n_models = selection_coefficient.size();
        
        dvec h = options.dominance_coefficients_str.empty() ? 
                 dvec::Constant(n_models, 0.5) : 
                 parse_vector(options.dominance_coefficients_str);
        dvec u = options.backward_mutations_str.empty() ? 
                 dvec::Constant(n_models, 1e-9) : 
                 parse_vector(options.backward_mutations_str);
        dvec v = options.forward_mutations_str.empty() ?
                 dvec::Constant(n_models, 1e-9) :
                 parse_vector(options.forward_mutations_str);

        // The SGV model is structurally two-phase: the switching matrix below is
        // a hardcoded 2x2 (standing variation -> selected phase, with the second
        // phase absorbing). Anything other than exactly two values per parameter
        // is not a smaller or larger SGV model, it is a malformed one.
        //
        // Without this, `-s 0` alone reached WF::NonAbsorbingToFixationOnly and
        // tripped assert(s.size() == 2) -- SIGABRT, exit 134, nothing on stdout.
        // That assert compiles out under NDEBUG, so a release build would have
        // read past the end of the parameter vectors instead of aborting.
        auto require_two = [](const dvec& vecval, const char* flag, const char* name) {
            if (vecval.size() != 2) {
                throw std::runtime_error(
                    std::string(name) + " (" + flag + ") has " +
                    std::to_string(vecval.size()) + " value(s), but the SGV model "
                    "always has exactly 2 phases. Supply two comma-separated "
                    "values, e.g. " + flag + " 0,0.01");
            }
        };
        require_two(selection_coefficient, "-s", "Selection coefficients");
        require_two(h, "-h", "Dominance coefficients");
        require_two(u, "-u", "Backward mutation rates");
        require_two(v, "-v", "Forward mutation rates");

        // Population size is a scalar here and shared by both phases.
        for (llong k = 0; k < 2; k++) {
            CLI::Args_Parser::validate_model_domain(
                options.population_size, selection_coefficient(k), h(k), u(k), v(k),
                options.alpha, "phase " + std::to_string(k + 1));
        }

        // Display parameters
        if (options.verbose) {
            std::cout << "N = " << options.population_size << std::endl;
            std::cout << "lambda = " << options.lambda << std::endl;
            std::cout << "s = [" << selection_coefficient.transpose() << "]" << std::endl;
            std::cout << "h = [" << h.transpose() << "]" << std::endl;
            std::cout << "u = [" << u.transpose() << "]" << std::endl;
            std::cout << "v = [" << v.transpose() << "]" << std::endl;
            std::cout << "a = " << options.alpha << std::endl;
            std::cout << "max_t = " << options.max_t << std::endl;
            std::cout << "integration_cutoff = " << options.integration_cutoff << std::endl;
            std::cout << "recurrent_mutation = " << (options.recurrent_mutation ? "true" : "false") << std::endl;
        }
        
        // Library to use
        std::string library = options.library;
        
        // Create switching matrix for SGV
        double l = options.lambda;
        dmat switching(2, 2);
        switching << 1 - l, l, 0, 1;
        
        // Create Wright-Fisher NonAbsorbingToFixationOnly matrix
        WF::Matrix wf = WF::NonAbsorbingToFixationOnly(
            options.population_size, selection_coefficient, h, u, v, 
            switching, options.alpha, options.verbose, 
            options.block_size, library
        );
        
        // Output matrices if requested
        if (!options.output_Q_path.empty()) {
            wf.Q->saveMarket(options.output_Q_path);
        }
        if (!options.output_R_path.empty()) {
            CLI::OutputFormatter::write_matrix_to_file(wf.R, options.output_R_path);
        }
        
        // Phase-type distribution matrix: [time, P_abs_t, cdf] (3 columns for SGV)
        dmat PH(options.max_t, 3);
        
        // Initial state vector. Without --initial this is a point mass on the
        // first state, which is what the tool has always assumed; with it, the
        // user supplies the whole distribution over this model's states.
        dvec c = dvec::Zero(4 * options.population_size + 1);
        if (!options.initial_distribution_path.empty()) {
            c = CLI::load_initial_distribution(
                options.initial_distribution_path, 4 * options.population_size + 1,
                "the two concatenated SGV component blocks");
        } else {
            c(0) = 1;
        }
        
        // Get fixation column (first column)
        dvec R = wf.R.col(0);
        
        double cdf = 0;
        llong i;
        for (i = 0; cdf < options.distribution_cutoff && i < options.max_t; i++) {
            
            // Calculate absorption probability at time t
            double P_abs_t = R.dot(c);
            cdf += P_abs_t;
            
            // Store results in phase-type distribution matrix
            PH(i, 0) = i + 1;      // Time (1-indexed)
            PH(i, 1) = P_abs_t;   // P_abs at time t
            PH(i, 2) = cdf;       // Cumulative distribution function
            
            // Advance to next time step: c = Q * c
            c = wf.Q->multiply(c, true);
        }
        
        // Resize to actual number of computed time steps
        PH.conservativeResize(i, 3);
        
        // Normalize CDF to get conditional distribution
        // The CDF should represent P(T <= t | absorption occurs)
        if (cdf > 0) {
            for (llong j = 0; j < i; j++) {
                PH(j, 2) = PH(j, 2) / cdf;  // Normalize CDF
            }
        }
        
        // Output phase-type distribution if requested
        if (!options.output_P_path.empty()) {
            CLI::OutputFormatter::write_matrix_to_file(PH, options.output_P_path);
        }
        

        // Did the run finish, or just run out of generations? The loop stops on
        // EITHER the cutoff or --max-t and said nothing about which. Hitting
        // max_t truncates the distribution, and every moment computed from it
        // is then a lower bound.
        const bool reached_cutoff = cdf >= options.distribution_cutoff;
        if (!reached_cutoff) {
            std::cerr << "Warning: stopped at --max-t (" << options.max_t
                      << ") with only " << cdf << " of the distribution's mass;"
                      << " the cutoff " << options.distribution_cutoff
                      << " was not reached. Moments computed from this window are"
                      << " underestimates -- raise --max-t.\n";
        }

        // Print summary statistics
        if (options.verbose) {
            std::cout << "Computed " << i << " time steps" << std::endl;
            std::cout << "Final CDF: " << cdf << std::endl;
            if (i > 0) {
                std::cout << "Last absorption probability: " << PH(i-1, 1) << std::endl;
            }
        }
        
        // Output results based on format
        if (options.output_P_path.empty()) {
            if (options.json_output) {
                // JSON output
                std::cout << "{" << std::endl;
                std::cout << "  \"model\": \"time_dist_sgv\"," << std::endl;
                std::cout << "  \"mode\": \"fixation\"," << std::endl;
                std::cout << "  \"population_size\": " << options.population_size << "," << std::endl;
                std::cout << "  \"lambda\": " << options.lambda << "," << std::endl;
                std::cout << "  \"selection_coefficients\": [";
                for (llong k = 0; k < selection_coefficient.size(); k++) {
                    if (k > 0) std::cout << ", ";
                    std::cout << selection_coefficient(k);
                }
                std::cout << "]," << std::endl;
                std::cout << "  \"time_steps\": " << i << "," << std::endl;
                std::cout << "  \"final_cdf\": " << cdf << "," << std::endl;
                std::cout << "  \"distribution_cutoff\": " << options.distribution_cutoff << "," << std::endl;
                std::cout << "  \"reached_cutoff\": " << (reached_cutoff ? "true" : "false") << "," << std::endl;
                std::cout << "  \"distribution\": {" << std::endl;
                std::cout << "    \"time\": [";
                for (llong j = 0; j < i; j++) {
                    if (j > 0) std::cout << ", ";
                    std::cout << static_cast<llong>(PH(j, 0));
                }
                std::cout << "]," << std::endl;
                std::cout << "    \"pdf\": [";
                for (llong j = 0; j < i; j++) {
                    if (j > 0) std::cout << ", ";
                    std::cout << std::setprecision(std::numeric_limits<double>::max_digits10) << PH(j, 1);
                }
                std::cout << "]," << std::endl;
                std::cout << "    \"cdf\": [";
                for (llong j = 0; j < i; j++) {
                    if (j > 0) std::cout << ", ";
                    std::cout << std::setprecision(std::numeric_limits<double>::max_digits10) << PH(j, 2);
                }
                std::cout << "]" << std::endl;
                std::cout << "  }" << std::endl;
                std::cout << "}" << std::endl;
            } else if (options.csv_output) {
                // CSV output
                std::cout << "time,pdf,cdf" << std::endl;
                for (llong j = 0; j < i; j++) {
                    std::cout << static_cast<llong>(PH(j, 0)) << ","
                             << std::setprecision(std::numeric_limits<double>::max_digits10) 
                             << PH(j, 1) << "," << PH(j, 2) << std::endl;
                }
            } else if (!options.verbose) {
                // Default output: show first few and last few rows of the distribution
                std::cout << "Standing genetic variation time distribution of fixation (first 10 and last 5 time points):" << std::endl;
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