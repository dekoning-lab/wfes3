#include <iostream>
#include <iomanip>
#include <sstream>
#include <string>
#include <vector>
#include <chrono>
#include <cmath>
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

        // -r/--no-recurrent-mu is declared by the parser for every tool that
        // builds a Wright-Fisher matrix, but the SGV model is assembled by
        // WF::NonAbsorbingToFixationOnly, whose signature has no
        // recurrent-mutation argument. The flag therefore never reached the
        // model: output was byte-identical with and without it, while
        // --verbose cheerfully echoed "recurrent_mutation = false". Accepting a
        // parameter and ignoring it is the worst of the three options; wiring
        // it is a model change. Refuse.
        //
        // options.recurrent_mutation defaults to true and is set false only by
        // this flag, so this test is exactly "was -r supplied".
        if (!options.recurrent_mutation) {
            throw std::runtime_error(
                "-r/--no-recurrent-mu is not supported for time_dist_sgv: the SGV "
                "model (NonAbsorbingToFixationOnly) takes no recurrent-mutation "
                "argument, so the flag would be accepted and silently ignored. It "
                "is supported by time_dist and time_dist_dual.");
        }

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
            // No integration_cutoff echo: this tool's parser hardcodes
            // options.integration_cutoff to 1e-10 and routes the user's -c to
            // distribution_cutoff, so echoing it printed a constant that the
            // computation never reads and that ignored what the user typed. The
            // value that actually governs the run is reported instead.
            //
            // No recurrent_mutation echo either -- see the refusal above: the
            // SGV model has no such parameter, so there is nothing honest to
            // report here.
            std::cout << "distribution_cutoff = " << options.distribution_cutoff << std::endl;
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
            wf.Q->saveSparseCsv(options.output_Q_path);
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

        // A stopping rule that is already satisfied before the first generation
        // ends the loop with zero rows. `-d -1` did exactly that: exit 0, a
        // header-only CSV, and completely empty stderr -- a header-only
        // "success" is indistinguishable, to anything downstream, from a model
        // in which fixation never happens. There is no distribution here to
        // report, so refuse.
        //
        // (This tool's parser range-checks options.integration_cutoff, which is
        // a hardcoded constant, instead of the distribution_cutoff the user
        // actually set, which is why a negative -d reaches this far at all.
        // Fixing that check belongs to the parser; refusing to publish an empty
        // table belongs here regardless.)
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
                "The accumulated fixation mass is not finite; the iteration has"
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
        // signature of a complete distribution -- so `-m 40` captured 8.7e-09
        // of the mass and still printed a CDF ending in 1, which in the CSV and
        // plain-text paths (neither of which carries reached_cutoff) was
        // indistinguishable from a converged run. Left raw, the partial CDF
        // discloses its own truncation in every output format and stays
        // consistent with final_cdf.
        // Named once so the JSON disclosure below (task CX-disclose, PI
        // decision "Rescale + disclose") can never drift out of sync with
        // the renormalisation it is disclosing -- it is the exact condition
        // that gates the division, not a separately-derived equivalent.
        const bool cdf_was_rescaled = reached_cutoff && cdf > 0;
        if (cdf_was_rescaled) {
            for (llong j = 0; j < i; j++) {
                PH(j, 2) = PH(j, 2) / cdf;  // Normalize CDF
            }
        }

        // Disclose the rescale itself when the cutoff that drove it is far
        // enough from 1 to matter for interpretation. See time_dist_main.cpp
        // for the full rationale behind the 0.99 threshold: at or below it,
        // the rescale discards a modeling-relevant slice of the tail rather
        // than cleaning up residual truncation noise near the ~1e-8-of-1
        // default, and the resulting "CDF -> 1" is conditional on fixation
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
                         " distribution is therefore conditional on fixation"
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
                std::cout << "Last absorption probability: " << PH(i-1, 1) << std::endl;
            }
        }
        
        // Output results based on format.
        //
        // --output-P used to gate this whole block, so `--output-P f --json`
        // exited 0 having written 0 bytes to stdout (1783 without the flag) --
        // a caller that asked for machine-readable output got silence and no
        // indication why. Writing a file and emitting a stream are independent
        // requests; only the human-readable table below is still suppressed
        // when a file was asked for, since that would merely echo the file's
        // contents to the terminal (this is what time_dist_dual does too).
        {
            if (options.json_output) {
                // JSON output
                std::cout << "{" << std::endl;
                std::cout << "  \"model\": \"time_dist_sgv\"," << std::endl;
                std::cout << "  \"mode\": \"fixation\"," << std::endl;
                // Solver-backend provenance: what was ASKED FOR and what
                // actually ran. SolverFactory serves a "--library Accelerate"
                // request with SuiteSparse whenever this build has it, so the
                // request alone is not a record of the run. See
                // output_formatter.hpp.
                //
                // Emitted at TOP LEVEL, not inside a "parameters" object: this
                // is the one tool of the eleven that publishes its parameters
                // flat, beside population_size and lambda, and inventing a
                // nested block for two fields would change this document's
                // shape for every existing reader. The fields sit with the
                // other parameters, which is where the tool keeps them.
                std::cout << wfes::cli::OutputFormatter::library_provenance_json(
                    options.library, "  ");
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
                // Additive disclosure fields -- see time_dist_dual_main.cpp
                // for the full rationale; identical pattern, flat rather than
                // nested under "statistics" because this tool already
                // publishes everything flat (see the provenance comment
                // above). Present exactly when cdf_was_rescaled actually
                // divided the CDF column down to end at 1.0; a run that
                // stopped at --max-t instead has neither key, honestly
                // ABSENT rather than printed with a false/null sentinel.
                if (cdf_was_rescaled) {
                    std::cout << "  \"cdf_rescaled\": true," << std::endl;
                    std::cout << "  \"cdf_pre_rescale_mass\": " << cdf << "," << std::endl;
                }
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
            } else if (!options.verbose && options.output_P_path.empty()) {
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