#include <iostream>
#include <vector>
#include <string>
#include <fstream>
#include <sstream>
#include <utility>
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
        
        // Apply scaling factors
        dvec ps_tmp = population_sizes.cast<double>().array() / factors.array();
        population_sizes = ps_tmp.cast<llong>();
        dvec t_tmp = generations.array() / factors.array();
        generations = t_tmp;
        
        // Scale mutation and selection by factors
        dvec s = s_unsc.array() * factors.array();
        dvec u = u_unsc.array() * factors.array();
        dvec v = v_unsc.array() * factors.array();

        // Per-model domain checks, on the FACTOR-SCALED values that actually
        // reach the Wright-Fisher matrix rather than on what the user typed.
        // The scaling is what can push a legitimate-looking rate out of range.
        Args_Parser::validate_model_domain_vectors(
            population_sizes, s, h, u, v, options.alpha);

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
            tail /= 1 - row.Q(0);
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
        llong lt = n_models - 1;
        if (factors[lt] != 1.0) {
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
                // Project down
                dvec prj_d = dvec::Zero(n);
                double diag_f = static_cast<double>(m - 2) / (n - 2);
                
                // Count how many states are integrated into each projected state
                dvec row_integral_counts = dvec::Zero(n);
                for (llong i = 0; i < m - 2; i++) {
                    llong j = static_cast<llong>(i / diag_f);
                    row_integral_counts[j + 1]++;
                }
                
                // Project the distribution
                prj_d[0] = prj_u[0];
                prj_d[prj_d.size() - 1] = prj_u[prj_u.size() - 1];
                for (llong i = 0; i < m - 2; i++) {
                    llong j = static_cast<llong>(i / diag_f);
                    prj_d[j + 1] += prj_u[i + 1] / row_integral_counts[j + 1];
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