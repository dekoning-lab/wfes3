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
 * Parse a matrix from a comma/semicolon-separated string
 * Format: "1,2;3,4" -> matrix [[1,2],[3,4]]
 */
dmat parse_matrix(const std::string& str) {
    std::vector<std::vector<double>> rows;
    std::stringstream ss(str);
    std::string row_str;
    
    while (std::getline(ss, row_str, ';')) {
        std::vector<double> row;
        std::stringstream row_ss(row_str);
        std::string item;
        
        while (std::getline(row_ss, item, ',')) {
            item.erase(0, item.find_first_not_of(" \t"));
            item.erase(item.find_last_not_of(" \t") + 1);
            if (!item.empty()) {
                row.push_back(std::stod(item));
            }
        }
        if (!row.empty()) {
            rows.push_back(row);
        }
    }
    
    if (rows.empty()) return dmat();

    size_t n_rows = rows.size();
    size_t n_cols = rows[0].size();

    // Reject jagged input. The column count was taken from the first row and
    // then used to index every row, so a short row (e.g. "0.9,0.1;0.1") read
    // past the end of its std::vector and filled the matrix with garbage --
    // silently, with exit status 0.
    for (size_t i = 1; i < n_rows; ++i) {
        if (rows[i].size() != n_cols) {
            throw std::runtime_error(
                "Malformed matrix: row " + std::to_string(i) + " has " +
                std::to_string(rows[i].size()) + " entries but row 0 has " +
                std::to_string(n_cols) +
                ". Rows are separated by ';' and entries within a row by ','");
        }
    }

    dmat result(n_rows, n_cols);
    for (size_t i = 0; i < n_rows; ++i) {
        for (size_t j = 0; j < n_cols; ++j) {
            result(i, j) = rows[i][j];
        }
    }
    return result;
}

int main(int argc, char const *argv[]) {
    time_point t_start, t_end;
    
    try {
        // Parse command-line arguments for switching model
        CLI::CommandLineOptions options = CLI::Args_Parser::parse_wfes_switching_args(argc, argv);
        
        // Start timing if verbose
        if (options.verbose) {
            t_start = std::chrono::system_clock::now();
        }
        
        // Set thread count. The MKL branch alone left -t a silent no-op on any
        // build without Pardiso (i.e. every macOS build): OpenMP is the only
        // threading control that exists there, and wfes-lib's matrix assembly
        // is OpenMP-parallel regardless of the solver backend.
        if (options.num_threads > 0) {
#ifdef OMP
            omp_set_num_threads(options.num_threads);
#endif
#ifdef WFES_USE_MKL
            mkl_set_num_threads(options.num_threads);
#endif
        }
        
        // Parse the switching model specific parameters
        lvec population_sizes = parse_long_vector(options.population_sizes_str);
        llong n_models = population_sizes.size();
        
        // Parse vector parameters or use defaults
        dvec s = options.selection_coefficients_str.empty() ? 
                 dvec::Constant(n_models, 0) : 
                 parse_vector(options.selection_coefficients_str);
        dvec h = options.dominance_coefficients_str.empty() ? 
                 dvec::Constant(n_models, 0.5) : 
                 parse_vector(options.dominance_coefficients_str);
        dvec u = options.backward_mutations_str.empty() ? 
                 dvec::Constant(n_models, 1e-9) : 
                 parse_vector(options.backward_mutations_str);
        dvec v = options.forward_mutations_str.empty() ? 
                 dvec::Constant(n_models, 1e-9) : 
                 parse_vector(options.forward_mutations_str);
        dvec p = options.starting_probabilities_str.empty() ? 
                 dvec::Constant(n_models, 1.0 / (double)n_models) : 
                 parse_vector(options.starting_probabilities_str);
        
        // Parse switching matrix or use default (uniform)
        dmat switching = options.switching_matrix_str.empty() ?
                        dmat::Ones(n_models, n_models) :
                        parse_matrix(options.switching_matrix_str);

        // Validate that every per-model vector actually has one entry per model,
        // and that the switching matrix is n_models x n_models.
        //
        // Without these checks, a malformed input did not produce an error: it
        // indexed out of bounds and aborted with a raw Eigen assertion
        // ("index >= 0 && index < size()", exit 134) from deep inside the
        // computation, with no indication of which argument was wrong. Both
        // failure modes were reachable from plausible command lines -- the
        // switching matrix uses ';' between rows and ',' within them, so the
        // natural-looking "-r 0.9,0.1,0.1,0.9" silently parses as a 1x4 matrix,
        // and "-p 1" supplies one starting probability for a two-model run.
        // (Note these asserts compile out under NDEBUG, in which case the same
        // inputs would read and write out of bounds instead of aborting.)
        auto require_len = [&](const dvec &vecval, const char *flag, const char *name) {
            if (vecval.size() != n_models) {
                throw std::runtime_error(
                    std::string(name) + " (" + flag + ") has " +
                    std::to_string(vecval.size()) + " value(s) but there are " +
                    std::to_string(n_models) + " models (-N gave " +
                    std::to_string(n_models) + " population sizes). Supply one "
                    "comma-separated value per model");
            }
        };
        require_len(s, "-s", "Selection coefficients");
        require_len(h, "-h", "Dominance coefficients");
        require_len(u, "-u", "Backward mutation rates");
        require_len(v, "-v", "Forward mutation rates");
        require_len(p, "-p", "Starting probabilities");

        // Per-model domain checks. The shared parser only sees the raw comma
        // separated strings for this tool, so the numeric validation the
        // single-model tools get in validate_*_parameters has to happen here,
        // once the vectors exist and their lengths agree.
        CLI::Args_Parser::validate_model_domain_vectors(
            population_sizes, s, h, u, v, options.alpha);

        // In --fixation there is only one absorbing state, so there is no
        // extinction to condition on and these two outputs do not exist. They
        // were previously accepted here and silently produced nothing.
        if (options.model_type == CLI::ModelType::FIXATION &&
            (!options.output_N_ext_path.empty() || !options.output_N_fix_path.empty())) {
            throw std::runtime_error(
                "--output-N-ext and --output-N-fix are not defined for --fixation: "
                "that model has a single absorbing state, so there is no "
                "extinction/fixation split to condition on. Use --absorption");
        }

        if (switching.rows() != n_models || switching.cols() != n_models) {
            throw std::runtime_error(
                "Switching matrix (-r) is " + std::to_string(switching.rows()) +
                "x" + std::to_string(switching.cols()) + " but must be " +
                std::to_string(n_models) + "x" + std::to_string(n_models) +
                ". Rows are separated by ';' and entries within a row by ',', "
                "e.g. -r \"0.9,0.1;0.1,0.9\" for two models");
        }
        for (llong i = 0; i < n_models; i++) {
            if (switching.row(i).sum() <= 0.0) {
                throw std::runtime_error(
                    "Switching matrix (-r) row " + std::to_string(i) +
                    " sums to zero; rows are normalised to probabilities and "
                    "must have a positive sum");
            }
        }
        
        // Normalize switching matrix rows
        dvec row_sums = switching.rowwise().sum();
        for (llong i = 0; i < n_models; i++) {
            for (llong j = 0; j < n_models; j++) {
                switching(i, j) /= row_sums(i);
            }
        }
        
        // Set message level for solvers
        llong msg_level = options.verbose ? MKL_PARDISO_MSG_VERBOSE : MKL_PARDISO_MSG_QUIET;
        
        // Library to use
        std::string library = options.library;
        
        // Display parameters (only for plain text output)
        if (!options.csv_output && !options.json_output) {
            std::cout << "N = [" << population_sizes.transpose() << "]" << std::endl;
            std::cout << "s = [" << s.transpose() << "]" << std::endl;
            std::cout << "h = [" << h.transpose() << "]" << std::endl;
            std::cout << "u = [" << u.transpose() << "]" << std::endl;
            std::cout << "v = [" << v.transpose() << "]" << std::endl;
            std::cout << "p = [" << p.transpose() << "]" << std::endl;
            std::cout << "a = " << options.alpha << std::endl;
        }
        
        // Dispatch based on model type
        if (options.model_type == CLI::ModelType::FIXATION) {
            
            // Create Wright-Fisher switching matrix for fixation only
            WF::Matrix W = WF::Switching(
                population_sizes, WF::FIXATION_ONLY, 
                s, h, u, v, switching, options.alpha, 
                options.verbose, 1, library
            );
            
            // Output matrices if requested
            if (!options.output_Q_path.empty()) {
                W.Q->saveMarket(options.output_Q_path);
            }
            if (!options.output_R_path.empty()) {
                CLI::OutputFormatter::write_matrix_to_file(W.R, options.output_R_path);
            }
            
            // Subtract identity for solving
            W.Q->subtractIdentity();
            
            llong size = (2 * population_sizes.sum());
            
            // Create solver
            solver::Solver* solver = solver::SolverFactory::createSolver(
                library, *W.Q, MKL_PARDISO_MATRIX_TYPE_REAL_UNSYMMETRIC, msg_level
            );
            solver->preprocess();
            
            // Calculate starting state indices for each model
            lvec start_state_index(n_models);
            start_state_index(0) = 0;
            for (llong i = 1; i < n_models; i++) {
                start_state_index(i) = (2 * population_sizes(i - 1)) + start_state_index(i - 1);
            }
            
            // Solve for the starting state.
            //
            // By default that is the first state of each model -- count 0, since
            // fixation-only keeps it transient -- weighted by the probability of
            // starting in that model. --initial replaces both with one supplied
            // distribution over the whole concatenated space, so it becomes a
            // single solve. Without this branch the flag was accepted here and
            // silently ignored: every distribution gave the same answer as
            // passing none.
            dmat N(n_models, size);
            dvec id(size);

            if (!options.initial_distribution_path.empty()) {
                dvec alpha_vec = CLI::load_initial_distribution(
                    options.initial_distribution_path, size,
                    "the concatenated states of all models (counts 0..2N_i-1 per model)");
                N.setZero();
                N.row(0) = solver->solve(alpha_vec, true);
            } else {
                for (llong i = 0; i < n_models; i++) {
                    id.setZero();
                    id(start_state_index(i)) = 1;
                    N.row(i) = solver->solve(id, true);
                    N.row(i) *= p(i);
                }
            }
            
            // Calculate fixation time and rate
            double T_fix = N.sum();
            double rate = 1.0 / T_fix;
            
            // Calculate B matrix if needed
            dmat B(size, n_models);
            for (llong i = 0; i < n_models; i++) {
                dvec R_col = W.R.col(i);
                B.col(i) = solver->solve(R_col, false);
            }
            
            // Output results
            if (!options.output_N_path.empty()) {
                CLI::OutputFormatter::write_matrix_to_file(N, options.output_N_path);
            }
            if (!options.output_B_path.empty()) {
                CLI::OutputFormatter::write_matrix_to_file(B, options.output_B_path);
            }
            
            // Print results.
            // FIXATION mode had no JSON branch at all, so --json silently fell
            // through to the plain-text else and emitted "T_fix = ..." lines --
            // unlike ABSORPTION mode, which delegates to OutputFormatter and
            // does emit JSON. Any caller requesting JSON (the GUI included) got
            // unparseable text back.
            if (options.json_output) {
                std::cout << "{" << std::endl;
                std::cout << "  \"model\": \"switching_fixation\"," << std::endl;
                std::cout << "  \"parameters\": {" << std::endl;
                std::cout << "    \"n_models\": " << n_models << "," << std::endl;
                std::cout << "    \"population_sizes\": [";
                for (llong i = 0; i < n_models; i++) {
                    std::cout << population_sizes(i);
                    if (i < n_models - 1) std::cout << ", ";
                }
                std::cout << "]," << std::endl;
                std::cout << "    \"selection_coefficients\": [";
                for (llong i = 0; i < n_models; i++) {
                    std::cout << s(i);
                    if (i < n_models - 1) std::cout << ", ";
                }
                std::cout << "]," << std::endl;
                std::cout << "    \"dominance_coefficients\": [";
                for (llong i = 0; i < n_models; i++) {
                    std::cout << h(i);
                    if (i < n_models - 1) std::cout << ", ";
                }
                std::cout << "]," << std::endl;
                std::cout << "    \"alpha\": " << options.alpha << std::endl;
                std::cout << "  }," << std::endl;
                std::cout << "  \"results\": {" << std::endl;
                std::cout << "    \"T_fix\": " << T_fix << "," << std::endl;
                std::cout << "    \"rate\": " << rate << std::endl;
                std::cout << "  }" << std::endl;
                std::cout << "}" << std::endl;
            } else if (options.csv_output) {
                // CSV format: N1,N2,s1,s2,h1,h2,u1,u2,v1,v2,p1,p2,a,T_fix,rate
                for (llong i = 0; i < n_models; i++) {
                    std::cout << population_sizes(i);
                    if (i < n_models - 1) std::cout << ",";
                }
                std::cout << ",";
                for (llong i = 0; i < n_models; i++) {
                    std::cout << s(i);
                    if (i < n_models - 1) std::cout << ",";
                }
                std::cout << ",";
                for (llong i = 0; i < n_models; i++) {
                    std::cout << h(i);
                    if (i < n_models - 1) std::cout << ",";
                }
                std::cout << ",";
                for (llong i = 0; i < n_models; i++) {
                    std::cout << u(i);
                    if (i < n_models - 1) std::cout << ",";
                }
                std::cout << ",";
                for (llong i = 0; i < n_models; i++) {
                    std::cout << v(i);
                    if (i < n_models - 1) std::cout << ",";
                }
                std::cout << ",";
                for (llong i = 0; i < n_models; i++) {
                    std::cout << p(i);
                    if (i < n_models - 1) std::cout << ",";
                }
                std::cout << ",";
                std::cout << options.alpha << ",";
                std::cout << T_fix << ",";
                std::cout << rate << std::endl;
            } else {
                std::cout << "T_fix = " << std::setprecision(10) << T_fix << std::endl;
                std::cout << "Rate = " << std::setprecision(10) << rate << std::endl;
            }
            
            // Clean up
            delete solver;
            
        } else if (options.model_type == CLI::ModelType::ABSORPTION) {
            
            // Create Wright-Fisher switching matrix with both absorbing boundaries
            wfes::wrightfisher::Matrix W = wfes::wrightfisher::Switching(
                population_sizes, 
                wfes::wrightfisher::BOTH_ABSORBING,
                s, h, u, v, switching, options.alpha, 
                options.verbose, 100, options.library
            );
            
            // Get matrix dimensions
            llong size = (2 * population_sizes.sum()) - n_models;
            
            // Calculate starting state indices for each model
            lvec start_state_index(n_models);
            start_state_index(0) = 0;
            for (llong i = 1; i < n_models; i++) {
                start_state_index(i) = start_state_index(i - 1) + (2 * population_sizes(i - 1) - 1);
            }
            
            // Output Q and R matrices if requested
            if (!options.output_Q_path.empty()) {
                CLI::OutputFormatter::write_matrix_to_file(W.Q->dense(), options.output_Q_path);
            }
            if (!options.output_R_path.empty()) {
                CLI::OutputFormatter::write_matrix_to_file(W.R, options.output_R_path);
            }
            
            // Convert to solving matrix (Q := I - Q)
            // Note: subtractIdentity() computes I - Q, not Q - I
            W.Q->subtractIdentity();
            
            // Create solver
            solver::Solver* solver = solver::SolverFactory::createSolver(
                options.library, *W.Q, MKL_PARDISO_MATRIX_TYPE_REAL_UNSYMMETRIC, msg_level
            );
            solver->preprocess();
            
            // Get initial probabilities for each model (similar to original)
            lvec nnz_p0(n_models);
            std::vector<dvec> p0(n_models);
            for (llong i = 0; i < n_models; i++) {
                llong pop_size = population_sizes(i);
                wfes::wrightfisher::Row first_row = wfes::wrightfisher::binom_row(
                    2 * pop_size, 
                    wfes::wrightfisher::psi_diploid(0, pop_size, s(i), h(i), u(i), v(i)), 
                    options.alpha
                );
                p0[i] = first_row.Q.tail(first_row.Q.size() - 1) / (1 - first_row.Q(0));
                nnz_p0[i] = (p0[i].array() > options.integration_cutoff).count();
            }
            
            // Calculate B matrix (extinction and fixation probabilities)
            dmat B(size, n_models * 2);
            for (llong i = 0; i < n_models * 2; i++) {
                dvec R_col = W.R.col(i);
                B.col(i) = solver->solve(R_col, false);
            }
            
            // The starting states to integrate over, with their weights.
            //
            // By default the weight of a state is the probability that a new
            // mutation starts there (p0 within its model) times the probability
            // of starting in that model (-p), and only states above the
            // integration cutoff are visited. --initial replaces both factors
            // with a distribution the user supplies over the whole concatenated
            // state space, so one list serves both cases and everything
            // downstream reads the weight rather than reconstructing it.
            std::vector<std::pair<llong, double>> start_weights;
            if (!options.initial_distribution_path.empty()) {
                dvec alpha_vec = CLI::load_initial_distribution(
                    options.initial_distribution_path, size,
                    "the concatenated transient states of all models");
                for (llong idx = 0; idx < size; idx++) {
                    if (alpha_vec(idx) > options.integration_cutoff) {
                        start_weights.emplace_back(idx, alpha_vec(idx));
                    }
                }
                if (start_weights.empty()) {
                    throw std::runtime_error(
                        "Initial distribution (--initial) has no state above the integration "
                        "cutoff; lower -c or supply a distribution with more mass.");
                }
            } else {
                for (llong i_ = 0; i_ < start_state_index.size(); i_++) {
                    for (llong o_ = 0; o_ < nnz_p0[i_]; o_++) {
                        start_weights.emplace_back(start_state_index(i_) + o_,
                                                   p0[i_](o_) * p(i_));
                    }
                }
            }

            // Calculate mean sojourn times for each starting state
            std::map<llong, dvec> N_rows;
            dvec id(size);
            for (const auto &sw : start_weights) {
                id.setZero();
                id(sw.first) = 1;
                N_rows[sw.first] = solver->solve(id, true);
            }
            
            // Output B matrix if requested
            if (!options.output_B_path.empty()) {
                CLI::OutputFormatter::write_matrix_to_file(B, options.output_B_path);
            }
            
            // Output N matrix if requested
            if (!options.output_N_path.empty()) {
                // Convert map to matrix for output
                dmat N_matrix(size, N_rows.size());
                llong col_idx = 0;
                for (const auto& pair : N_rows) {
                    N_matrix.col(col_idx++) = pair.second;
                }
                CLI::OutputFormatter::write_matrix_to_file(N_matrix, options.output_N_path);
            }
            
            // Calculate overall absorption probabilities weighted by initial distribution
            double P_ext = 0.0;
            double P_fix = 0.0;
            double T_ext = 0.0;
            double T_fix = 0.0;
            dvec P_cond_ext = dvec::Zero(n_models);
            dvec P_cond_fix = dvec::Zero(n_models);
            
            // Summarize extinction and fixation absorption vectors
            dvec B_fix = dvec::Zero(size);
            dvec B_ext = dvec::Zero(size);
            for(llong k = 0; k < n_models; k++) { 
                B_ext += B.col(k * 2);      // Sum all extinction columns
                B_fix += B.col(k * 2 + 1);  // Sum all fixation columns
            }
            
            dvec E_ext = dvec::Zero(size);
            dvec E_fix = dvec::Zero(size);
            dvec E_uncond = dvec::Zero(size);
            
            for (const auto &sw : start_weights) {
                {
                    llong state_idx = sw.first;
                    double iw = sw.second; // integration weight
                    
                    // Calculate extinction and fixation probabilities for this starting state
                    double P_ext_i = 0.0;
                    double P_fix_i = 0.0;
                    for (llong k = 0; k < n_models; k++) {
                        P_ext_i += B(state_idx, k * 2);
                        P_fix_i += B(state_idx, k * 2 + 1);
                        P_cond_ext(k) += B(state_idx, k * 2) * iw;
                        P_cond_fix(k) += B(state_idx, k * 2 + 1) * iw;
                    }
                    P_ext += P_ext_i * iw;
                    P_fix += P_fix_i * iw;
                    
                    // Calculate conditional expected times
                    E_uncond += iw * N_rows[state_idx];
                    
                    dvec E_ext_i = B_ext.array() * N_rows[state_idx].array() / B_ext(state_idx);
                    dvec E_fix_i = B_fix.array() * N_rows[state_idx].array() / B_fix(state_idx);
                    T_ext += iw * E_ext_i.sum();
                    T_fix += iw * E_fix_i.sum();
                    E_ext += iw * E_ext_i;
                    E_fix += iw * E_fix_i;
                }
            }

            // --output-N-ext / --output-N-fix were declared and parsed into
            // options, but nothing ever read them: both flags were accepted,
            // exited 0, and wrote no file. The conditional sojourn vectors they
            // name are E_ext and E_fix, computed immediately above.
            if (!options.output_N_ext_path.empty()) {
                CLI::OutputFormatter::write_vector_to_file(E_ext, options.output_N_ext_path);
            }
            if (!options.output_N_fix_path.empty()) {
                CLI::OutputFormatter::write_vector_to_file(E_fix, options.output_N_fix_path);
            }

            // Time spent in each model conditional on absorbing in a particular state
            dvec T_cond_fix = dvec::Zero(n_models);
            dvec T_cond_ext = dvec::Zero(n_models);
            dvec T_uncond = dvec::Zero(n_models);
            for(llong i = 0; i < n_models; i++){
                llong start = start_state_index(i);
                llong length = (i < n_models - 1) ? 
                    start_state_index(i+1) - start : 
                    size - start;
                T_cond_ext(i) = E_ext.segment(start, length).sum();
                T_cond_fix(i) = E_fix.segment(start, length).sum();
                T_uncond(i) = E_uncond.segment(start, length).sum();
            }
            
            // Print results using OutputFormatter
            CLI::OutputFormatter::print_switching_absorption_results(
                options, n_models, population_sizes.cast<double>(), s, h, u, v, p,
                P_ext, P_fix, T_ext, T_fix,
                P_cond_ext, P_cond_fix, T_uncond, T_cond_ext, T_cond_fix
            );
            
            // Clean up
            delete solver;
            
        } else {
            std::cerr << "Unsupported model type for switching" << std::endl;
            return EXIT_FAILURE;
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