#include <iostream>
#include <iomanip>
#include <sstream>
#include <string>
#include <utility>
#include <vector>
#include <chrono>
#include <cmath>
#include <limits>
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
 * Format a double at full precision for a diagnostic.
 *
 * std::to_string fixes six decimal places, which renders every value this
 * function is asked about ("what did the vector actually sum to?", "what was
 * the cutoff?") as "0.000000" -- useless in a message whose whole job is to
 * show the user the offending number.
 */
static std::string num_str(double x) {
    std::ostringstream os;
    os << std::setprecision(std::numeric_limits<double>::max_digits10) << x;
    return os.str();
}

/**
 * Escape a string for use as a JSON string value.
 *
 * Only file paths go through this, but a path may legitimately contain a
 * backslash or a quote, and one of those in the parameters block would make
 * the whole document unparseable.
 */
static std::string json_escape(const std::string &raw) {
    std::string out;
    out.reserve(raw.size());
    for (char c : raw) {
        if (c == '"' || c == '\\') {
            out.push_back('\\');
            out.push_back(c);
        } else if (static_cast<unsigned char>(c) < 0x20) {
            std::ostringstream os;
            os << "\\u" << std::hex << std::setw(4) << std::setfill('0')
               << static_cast<int>(static_cast<unsigned char>(c));
            out += os.str();
        } else {
            out.push_back(c);
        }
    }
    return out;
}

/**
 * Validate the epoch starting-probability vector (-p) and normalise it to sum 1.
 *
 * -p was used raw as the weight on each epoch's starting states, so it never
 * had to be a probability vector for the run to report a result: `-p 1,1`
 * gave P_ext = 1.8261973686, and a negative entry gave negative
 * "probabilities" -- with exit status 0, and with numbers a reader would take
 * for probabilities.
 *
 * The rules and the wording follow the --initial check in
 * initial_distribution.h (and wfes_switching, which has the same flag): a
 * negative entry or a non-positive (or non-finite) sum is a hard error, and a
 * sum that is not 1 is renormalised out loud rather than silently, since
 * renormalising without saying so hides a malformed command line.
 */
static void normalise_starting_probabilities(dvec &p, const char *name) {
    if ((p.array() < 0).any()) {
        throw std::runtime_error(
            std::string(name) + " (-p) contain a negative entry; "
            "every entry must be a probability.");
    }
    const double total = p.sum();
    if (!std::isfinite(total) || total <= 0) {
        throw std::runtime_error(
            std::string(name) + " (-p) sum to " + num_str(total) +
            "; they must contain positive probability.");
    }
    if (std::abs(total - 1.0) > 1e-9) {
        std::cerr << "Warning: starting probabilities (-p) sum to " << num_str(total)
                  << ", not 1; renormalising.\n";
        p /= total;
    }
}

/**
 * One CSV row, built as (column name, formatted value) pairs.
 *
 * This branch used to emit a bare data row whose column order lived in a
 * comment -- and that comment had drifted: it documented 21 columns for a row
 * that emits 13k + 10 of them (36 for a two-epoch run). Adding the name and
 * the value together, and printing both lines from the same list, is what
 * stops a header from drifting the same way.
 *
 * Values are formatted through a stream that copies std::cout's formatting
 * state, so the numbers are exactly what a direct `std::cout << value` wrote.
 */
struct CsvRow {
    std::vector<std::pair<std::string, std::string>> cols;

    template <typename T>
    void add(const std::string &name, const T &value) {
        std::ostringstream os;
        os.copyfmt(std::cout);
        os << value;
        cols.emplace_back(name, os.str());
    }

    template <typename V>
    void add_per_model(const std::string &prefix, const V &values) {
        for (llong i = 0; i < values.size(); i++) {
            add(prefix + std::to_string(i), values(i));
        }
    }

    // Same column names as add_per_model, so the schema (and column count)
    // stays identical whether or not this run consumed `values` -- but with
    // empty fields in place of numbers when `used` is false, so a column
    // that played no part in the result does not carry a number a reader
    // would take for one that did.
    template <typename V>
    void add_per_model_or_empty(const std::string &prefix, const V &values, bool used) {
        for (llong i = 0; i < values.size(); i++) {
            if (used) {
                add(prefix + std::to_string(i), values(i));
            } else {
                cols.emplace_back(prefix + std::to_string(i), std::string());
            }
        }
    }

    void print() const {
        for (size_t i = 0; i < cols.size(); i++) {
            std::cout << (i ? "," : "") << cols[i].first;
        }
        std::cout << std::endl;
        for (size_t i = 0; i < cols.size(); i++) {
            std::cout << (i ? "," : "") << cols[i].second;
        }
        std::cout << std::endl;
    }
};

int main(int argc, char const *argv[]) {
    time_point t_start, t_end;
    
    try {
        // Parse command-line arguments for sequential model
        CLI::CommandLineOptions options = CLI::Args_Parser::parse_wfes_sequential_args(argc, argv);
        
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
        
        // Parse the sequential model specific parameters
        lvec population_sizes = parse_long_vector(options.population_sizes_str);
        dvec expected_times = parse_vector(options.expected_times_str);
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
        
        // Default starting probabilities for sequential: p = [1, 0, 0, ...]
        dvec p;
        if (!options.starting_probabilities_str.empty()) {
            p = parse_vector(options.starting_probabilities_str);
        } else {
            p = dvec::Zero(n_models);
            p(0) = 1.0;
        }

        // Length checks, before anything indexes these vectors.
        //
        // Supplying one value where the run has several epochs -- "-u 1e-9"
        // against "-N 100,100", which reads as a perfectly reasonable command
        // line -- used to walk off the end of the vector and abort with a raw
        // Eigen assertion ("index >= 0 && index < size()", exit 134) naming
        // neither the flag nor the epoch. wfes_switching already checks the
        // identical mistake; this is the same check in the same words, with
        // "epoch" for "model".
        //
        // Every epoch needs its own --exp-time: the last entry is not spare,
        // it sets the terminal state's self-loop and the timeout vector Z
        // (lines below), so a short vector is a real error rather than a
        // harmless omission.
        //
        // (These asserts compile out under NDEBUG, where the same inputs would
        // read out of bounds instead of aborting.)
        auto require_len = [&](const dvec &vecval, const char *flag, const char *name) {
            if (vecval.size() != n_models) {
                throw std::runtime_error(
                    std::string(name) + " (" + flag + ") has " +
                    std::to_string(vecval.size()) + " value(s) but there are " +
                    std::to_string(n_models) + " epochs (-N gave " +
                    std::to_string(n_models) + " population sizes). Supply one "
                    "comma-separated value per epoch");
            }
        };
        require_len(expected_times, "--exp-time", "Expected times");
        require_len(s, "-s", "Selection coefficients");
        require_len(h, "-h", "Dominance coefficients");
        require_len(u, "-u", "Backward mutation rates");
        require_len(v, "-v", "Forward mutation rates");
        require_len(p, "-p", "Epoch starting probabilities");

        // Per-model domain checks. The shared parser only sees the raw
        // comma-separated strings for this tool, so the numeric validation the
        // single-model tools get in validate_*_parameters happens here instead.
        CLI::Args_Parser::validate_model_domain_vectors(
            population_sizes, s, h, u, v, options.alpha);

        // -p is a probability distribution over the epochs, not a free weight
        // -- but only when the run actually starts from it. --initial and
        // --starting-copies each replace it entirely (see the three-way
        // branch below that picks start_weights), so whenever either is set
        // -p is dead input: validating or renormalising it would refuse, or
        // warn about renormalising, a vector the run never reads.
        //
        // Done before the echo below and before any use, so what is printed
        // and recorded is what the run actually integrates with.
        if (options.initial_distribution_path.empty() && options.starting_copies < 0) {
            normalise_starting_probabilities(p, "Epoch starting probabilities");
        }

        // Set message level for solvers
        llong msg_level = options.verbose ? MKL_PARDISO_MSG_VERBOSE : MKL_PARDISO_MSG_QUIET;
        
        // Library to use
        std::string library = options.library;
        
        // Display parameters. This must be suppressed for --json as well as
        // --csv: the echo went to stdout ahead of the JSON document, so
        // `wfes_sequential --json` did not emit parseable JSON at all.
        if (!options.csv_output && !options.json_output) {
            std::cout << "N = [" << population_sizes.transpose() << "]" << std::endl;
            std::cout << "t = [" << expected_times.transpose() << "]" << std::endl;
            std::cout << "s = [" << s.transpose() << "]" << std::endl;
            std::cout << "h = [" << h.transpose() << "]" << std::endl;
            std::cout << "u = [" << u.transpose() << "]" << std::endl;
            std::cout << "v = [" << v.transpose() << "]" << std::endl;
            std::cout << "p = [" << p.transpose() << "]" << std::endl;
            std::cout << "a = " << options.alpha << std::endl;
        }
        
        // Build sequential switching matrix
        dmat switching = dmat::Zero(n_models, n_models);
        for(llong i = 0; i < n_models - 1; i++) {
            switching(i, i) = 1 - (1 / expected_times(i));
            switching(i, i+1) = 1 / expected_times(i);
        }
        switching(n_models - 1, n_models - 1) = 1 - (1 / expected_times(n_models - 1));
        
        // Size of the combined system (excluding absorbing states)
        llong size = (2 * population_sizes.sum()) - n_models;
        
        // Create timeout vector Z
        dvec Z = dvec::Zero(size);
        // [0 0 0 0 ... 1/t ... 2N_k-1 times ... 1/t 1/t]
        llong last_size = 2 * population_sizes(n_models - 1) - 1;
        Z.tail(last_size) = dvec::Constant(last_size, 1 / expected_times(n_models - 1));
        
        // Create Wright-Fisher switching matrix for BOTH_ABSORBING
        WF::Matrix W = WF::Switching(
            population_sizes, WF::BOTH_ABSORBING, 
            s, h, u, v, switching, options.alpha, 
            options.verbose, 1, library
        );
        
        // Add timeout column to R matrix
        W.R.conservativeResize(W.R.rows(), W.R.cols() + 1);
        W.R.col(W.R.cols() - 1) = Z;
        
        // Get start indices for each model
        lvec si = wfes::utils::start_indices(2 * population_sizes - lvec::Ones(n_models));
        
        // Output matrices if requested
        if (!options.output_Q_path.empty()) {
            W.Q->saveMarket(options.output_Q_path);
        }
        if (!options.output_R_path.empty()) {
            CLI::OutputFormatter::write_matrix_to_file(W.R, options.output_R_path);
        }
        
        // Subtract identity for solving
        W.Q->subtractIdentity();
        
        // Create solver
        solver::Solver* solver = solver::SolverFactory::createSolver(
            library, *W.Q, MKL_PARDISO_MATRIX_TYPE_REAL_UNSYMMETRIC, msg_level
        );
        solver->preprocess();
        
        // Get initial probabilities of mu within each model
        std::vector<llong> nnz_p0(n_models);
        std::vector<dvec> p0(n_models);
        for (llong i = 0; i < n_models; i++) {
            llong pop_size = population_sizes(i);
            dvec first_row = wrightfisher::binom_row(
                2 * pop_size, 
                wrightfisher::psi_diploid(0, pop_size, s(i), h(i), u(i), v(i)), 
                options.alpha
            ).Q;
            p0[i] = first_row.tail(first_row.size() - 1) / (1 - first_row(0)); // renormalize
            nnz_p0[i] = (p0[i].array() > options.integration_cutoff).count();
        }
        
        // Calculate B matrix (extinction, fixation columns for each submodel + timeout)
        dmat B(size, (n_models * 2) + 1);
        for (llong i = 0; i < (n_models * 2) + 1; i++) {
            dvec R_col = W.R.col(i);
            B.col(i) = solver->solve(R_col, false);
        }
        
        // The starting states to integrate over, with their weights. By default
        // the weight is the probability a new mutation starts at that copy
        // number within its epoch (p0) times the probability of starting in
        // that epoch (-p); --initial replaces both with a distribution supplied
        // over the whole concatenated state space.
        std::vector<std::pair<llong, double>> start_weights;
        if (!options.initial_distribution_path.empty()) {
            dvec alpha_vec = CLI::load_initial_distribution(
                options.initial_distribution_path, size,
                "the concatenated transient states of all epochs");
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
        } else if (options.starting_copies >= 0) {
            // A single starting count, in the first epoch: block 0 spans counts
            // 1..2N_1-1 at indices si[0]..si[0]+2N_1-2, so index == count-1.
            llong max_count = 2 * population_sizes(0) - 1;
            if (options.starting_copies < 1 || options.starting_copies > max_count) {
                throw std::invalid_argument(
                    "Error: --starting-copies must be between 1 and 2N-1 = " +
                    std::to_string(max_count) + " for the first epoch");
            }
            start_weights.emplace_back(si[0] + options.starting_copies - 1, 1.0);
        } else {
            for (llong i_ = 0; i_ < si.size(); i_++) {
                for (llong o_ = 0; o_ < nnz_p0[i_]; o_++) {
                    start_weights.emplace_back(si[i_] + o_, p0[i_](o_) * p[i_]);
                }
            }
            // The --initial branch above already refuses an empty integration;
            // this branch did not, and every accumulator below is
            // zero-initialised, so `-c 1` printed a full set of zeroed results
            // (P_ext = P_fix = P_tmo = T_ext = ... = 0) and exited 0. That is a
            // placeholder presented as an answer.
            if (start_weights.empty()) {
                throw std::runtime_error(
                    "No starting state is above the integration cutoff (-c = " +
                    num_str(options.integration_cutoff) +
                    "); lower -c so the starting distribution has mass to "
                    "integrate over.");
            }
        }

        // Calculate N matrices for integration
        std::map<llong, dvec> N_rows;
        std::map<llong, dvec> N2_rows;
        dvec id(size);
        for (const auto &sw : start_weights) {
            id.setZero();
            id(sw.first) = 1;
            N_rows[sw.first] = solver->solve(id, true);
            N2_rows[sw.first] = solver->solve(N_rows[sw.first], true);
        }
        
        // Extinction and fixation columns of B
        lvec ke = wfes::utils::range_step(0, 2*n_models, 2);
        lvec kf = wfes::utils::range_step(1, 2*n_models, 2);
        
        // Summarize extinction and fixation absorption vectors
        dvec B_fix = dvec::Zero(size);
        dvec B_ext = dvec::Zero(size);
        for(llong k_ = 0; k_ < ke.size(); k_++) { B_ext += B.col(ke[k_]); }
        for(llong k_ = 0; k_ < kf.size(); k_++) { B_fix += B.col(kf[k_]); }
        dvec B_tmo = B.col(B.cols() - 1);
        
        double P_ext = 0, P_fix = 0, P_tmo = 0;
        double T_ext = 0, T_fix = 0, T_tmo = 0;
        double T_ext_var = 0, T_fix_var = 0, T_tmo_var = 0;
        
        dvec E_ext = dvec::Zero(size);
        dvec E_fix = dvec::Zero(size);
        dvec E_tmo = dvec::Zero(size);

        // Per-epoch decomposition, mirroring wfes_switching. The probability
        // vectors are JOINT: P(outcome AND absorption occurred during epoch k)
        // -- B's columns ke[k]/kf[k] are epoch k's own boundaries, so they sum
        // to the headline P_ext/P_fix. The time vectors are per-epoch dwell,
        // conditional on the outcome, and sum to the headline T's.
        dvec P_cond_ext = dvec::Zero(n_models);
        dvec P_cond_fix = dvec::Zero(n_models);
        dvec E_uncond = dvec::Zero(size);

        // Integration over starting states
        for (const auto &sw : start_weights) {
            {
                llong idx = sw.first;
                double iw = sw.second; //integration_weight

                P_ext += B_ext[idx] * iw;
                P_fix += B_fix[idx] * iw;
                P_tmo += B_tmo[idx] * iw;

                for (llong k_ = 0; k_ < n_models; k_++) {
                    P_cond_ext(k_) += B(idx, ke[k_]) * iw;
                    P_cond_fix(k_) += B(idx, kf[k_]) * iw;
                }
                E_uncond += iw * N_rows[idx];
                
                dvec E_ext_i = B_ext.array() * N_rows[idx].array() / B_ext[idx];
                dvec E_ext_var_i = B_ext.array() * N2_rows[idx].array() / B_ext[idx];
                T_ext += iw * E_ext_i.sum();
                T_ext_var += (2 * E_ext_var_i.sum() - E_ext_i.sum() - pow(E_ext_i.sum(), 2)) * iw;
                E_ext += iw * E_ext_i;
                
                dvec E_fix_i = B_fix.array() * N_rows[idx].array() / B_fix[idx];
                dvec E_fix_var_i = B_fix.array() * N2_rows[idx].array() / B_fix[idx];
                T_fix += iw * E_fix_i.sum();
                T_fix_var += (2 * E_fix_var_i.sum() - E_fix_i.sum() - pow(E_fix_i.sum(), 2)) * iw;
                E_fix += iw * E_fix_i;
                
                dvec E_tmo_i = B_tmo.array() * N_rows[idx].array() / B_tmo[idx];
                dvec E_tmo_var_i = B_tmo.array() * N2_rows[idx].array() / B_tmo[idx];
                T_tmo += iw * E_tmo_i.sum();
                T_tmo_var += (2 * E_tmo_var_i.sum() - E_tmo_i.sum() - pow(E_tmo_i.sum(), 2)) * iw;
                E_tmo += iw * E_tmo_i;
            }
        }
        
        double T_ext_std = sqrt(T_ext_var);
        double T_fix_std = sqrt(T_fix_var);
        double T_tmo_std = sqrt(T_tmo_var);

        // Expected time spent IN each epoch (block i spans si[i] with
        // 2N_i - 1 transient states), unconditional and given each outcome.
        dvec T_uncond_m = dvec::Zero(n_models);
        dvec T_cond_ext_m = dvec::Zero(n_models);
        dvec T_cond_fix_m = dvec::Zero(n_models);
        dvec T_cond_tmo_m = dvec::Zero(n_models);
        for (llong i = 0; i < n_models; i++) {
            llong start = si[i];
            llong length = 2 * population_sizes(i) - 1;
            T_uncond_m(i)  = E_uncond.segment(start, length).sum();
            T_cond_ext_m(i) = E_ext.segment(start, length).sum();
            T_cond_fix_m(i) = E_fix.segment(start, length).sum();
            T_cond_tmo_m(i) = E_tmo.segment(start, length).sum();
        }
        
        // Nothing that is not a finite number may be published, whatever
        // produced it, and nothing may be written to disk before that is
        // established.
        //
        // `-N 2,2 -t 1,1 --json` reached this point with P_ext = 0.316 and
        // T_ext = nan: E[T | extinction] divides each starting state's sojourn
        // vector by that state's extinction probability, and with an expected
        // epoch length of one generation a state that cannot reach an
        // extinction boundary before the epoch times out has probability
        // exactly 0, so the quotient is 0/0. All three output branches printed
        // it, and `"T_ext": nan` is not JSON any parser will read.
        // The causal clause below fits most of what require_finite guards
        // here (P_ext, P_fix, P_tmo, T_ext, T_fix, T_tmo and their per-model
        // breakdowns): each is an expectation conditional on an outcome, and
        // is undefined when that outcome has zero probability from the
        // starting states -- the 0/0 described above. T_ext_std, T_fix_std
        // and T_tmo_std are not such an expectation: each is sqrt() of a
        // variance built from cancelling terms (see T_ext_var and its
        // siblings above), and floating-point error can drive that variance
        // slightly negative when the true value is at or near zero, making
        // the square root undefined for a different reason entirely. Naming
        // the zero-probability outcome as the cause for a _std value would
        // be naming the wrong bug, so the wording is branched on the name
        // instead.
        auto require_finite = [](double value, const std::string &name) {
            if (!std::isfinite(value)) {
                bool is_std = name.size() >= 4 &&
                    name.compare(name.size() - 4, 4, "_std") == 0;
                std::string cause = is_std
                    ? "it is a square root of a variance built from "
                      "cancelling terms, and floating-point error can drive "
                      "that variance slightly negative when the true value "
                      "is at or near zero"
                    : "an expectation conditional on an outcome is "
                      "undefined when that outcome cannot occur from the "
                      "starting states";
                throw std::runtime_error(
                    "Computed " + name + " = " + num_str(value) + ", which is "
                    "not a number this tool can report. The computation did not "
                    "produce a usable result -- " + cause +
                    ". Check -N and --exp-time");
            }
        };
        auto require_finite_vec = [&](const dvec &vals, const char *name) {
            for (llong i = 0; i < vals.size(); i++) {
                require_finite(vals(i), std::string(name) + "[" + std::to_string(i) + "]");
            }
        };
        require_finite(P_ext, "P_ext");
        require_finite(P_fix, "P_fix");
        require_finite(P_tmo, "P_tmo");
        require_finite(T_ext, "T_ext");
        require_finite(T_fix, "T_fix");
        require_finite(T_tmo, "T_tmo");
        require_finite(T_ext_std, "T_ext_std");
        require_finite(T_fix_std, "T_fix_std");
        require_finite(T_tmo_std, "T_tmo_std");
        require_finite_vec(P_cond_ext, "P_cond_ext");
        require_finite_vec(P_cond_fix, "P_cond_fix");
        require_finite_vec(T_uncond_m, "T_uncond");
        require_finite_vec(T_cond_ext_m, "T_cond_ext");
        require_finite_vec(T_cond_fix_m, "T_cond_fix");
        require_finite_vec(T_cond_tmo_m, "T_cond_tmo");

        // Output additional vectors if requested
        if (!options.output_N_ext_path.empty()) {
            CLI::OutputFormatter::write_vector_to_file(E_ext, options.output_N_ext_path);
        }
        if (!options.output_N_fix_path.empty()) {
            CLI::OutputFormatter::write_vector_to_file(E_fix, options.output_N_fix_path);
        }
        // E_tmo is the timeout-conditional sojourn vector, computed alongside
        // E_ext and E_fix above. --output-N-tmo previously parsed and then went
        // nowhere; the comment claiming types.h lacked the field was stale.
        if (!options.output_N_tmo_path.empty()) {
            CLI::OutputFormatter::write_vector_to_file(E_tmo, options.output_N_tmo_path);
        }
        if (!options.output_N_path.empty()) {
            // Convert N_rows map to matrix format for output
            dmat N_matrix(size, N_rows.size());
            llong col_idx = 0;
            for (const auto& pair : N_rows) {
                N_matrix.col(col_idx++) = pair.second;
            }
            CLI::OutputFormatter::write_matrix_to_file(N_matrix, options.output_N_path);
        }
        if (!options.output_B_path.empty()) {
            CLI::OutputFormatter::write_matrix_to_file(B, options.output_B_path);
        }
        
        // Print results.
        // wfes_sequential was the only one of the eleven tools with no
        // structured output at all. Its CSV branch also omitted the three
        // uncertainty values that the plain-text branch prints (T_ext_std,
        // T_fix_std, T_tmo_std), which is why the GUI -- which requested CSV --
        // rendered "+/- std" figures it could never actually receive. Both
        // forms now carry every computed quantity, and the GUI asks for JSON.
        if (options.json_output) {
            // The parameters block records what the run used, so a JSON result
            // is self-describing. It used to carry only N, t, s, h and alpha --
            // while the same program's text and CSV branches already emitted u,
            // v and p, so the structured output was the least informative of
            // the three. p is the NORMALISED vector, i.e. the one the
            // integration actually weighted with; and which of the three
            // mutually exclusive starting rules was in effect is recorded too,
            // since -c does nothing under --starting-copies and p does nothing
            // under either --starting-copies or --initial.
            auto json_param_vec = [&](const char *name, const auto &vals) {
                std::cout << "    \"" << name << "\": [";
                for (llong i = 0; i < n_models; i++) {
                    std::cout << vals(i);
                    if (i < n_models - 1) std::cout << ", ";
                }
                std::cout << "]," << std::endl;
            };
            std::cout << "{" << std::endl;
            std::cout << "  \"model\": \"sequential\"," << std::endl;
            std::cout << "  \"parameters\": {" << std::endl;
            std::cout << "    \"n_models\": " << n_models << "," << std::endl;
            json_param_vec("population_sizes", population_sizes);
            json_param_vec("expected_times", expected_times);
            json_param_vec("selection_coefficients", s);
            json_param_vec("dominance_coefficients", h);
            json_param_vec("backward_mutation_rates", u);
            json_param_vec("forward_mutation_rates", v);
            if (!options.initial_distribution_path.empty()) {
                std::cout << "    \"initial_distribution\": \""
                          << json_escape(options.initial_distribution_path)
                          << "\"," << std::endl;
                std::cout << "    \"integration_cutoff\": "
                          << options.integration_cutoff << "," << std::endl;
            } else if (options.starting_copies >= 0) {
                std::cout << "    \"starting_copies\": "
                          << options.starting_copies << "," << std::endl;
            } else {
                json_param_vec("starting_probabilities", p);
                std::cout << "    \"integration_cutoff\": "
                          << options.integration_cutoff << "," << std::endl;
            }
            std::cout << "    \"alpha\": " << options.alpha << std::endl;
            std::cout << "  }," << std::endl;
            std::cout << "  \"results\": {" << std::endl;
            std::cout << "    \"P_ext\": " << P_ext << "," << std::endl;
            std::cout << "    \"P_fix\": " << P_fix << "," << std::endl;
            std::cout << "    \"P_tmo\": " << P_tmo << "," << std::endl;
            std::cout << "    \"T_ext\": " << T_ext << "," << std::endl;
            std::cout << "    \"T_ext_std\": " << T_ext_std << "," << std::endl;
            std::cout << "    \"T_fix\": " << T_fix << "," << std::endl;
            std::cout << "    \"T_fix_std\": " << T_fix_std << "," << std::endl;
            std::cout << "    \"T_tmo\": " << T_tmo << "," << std::endl;
            std::cout << "    \"T_tmo_std\": " << T_tmo_std << "," << std::endl;
            auto json_vec = [](const char* name, const dvec& v, bool last = false) {
                std::cout << "    \"" << name << "\": [";
                for (llong i = 0; i < v.size(); i++) {
                    std::cout << v(i);
                    if (i < v.size() - 1) std::cout << ", ";
                }
                std::cout << "]" << (last ? "" : ",") << std::endl;
            };
            json_vec("P_cond_ext", P_cond_ext);
            json_vec("P_cond_fix", P_cond_fix);
            json_vec("T_uncond", T_uncond_m);
            json_vec("T_cond_ext", T_cond_ext_m);
            json_vec("T_cond_fix", T_cond_fix_m);
            json_vec("T_cond_tmo", T_cond_tmo_m, true);
            std::cout << "  }" << std::endl;
            std::cout << "}" << std::endl;
        } else if (options.csv_output) {
            // Header plus one data row, both from the same column list, in the
            // order the bare row already used: 13k + 10 columns for k epochs
            // (36 for two). The comment that used to sit here documented 21 of
            // them, which is what an independently written header would have
            // inherited.
            //
            // The three std values are at the end because they were added after
            // the fact -- they were computed but omitted from this row entirely,
            // so any CSV consumer silently lost them -- and appending kept the
            // existing column positions.
            CsvRow row;
            row.add_per_model("N", population_sizes);
            row.add_per_model("t", expected_times);
            row.add_per_model("s", s);
            row.add_per_model("h", h);
            row.add_per_model("u", u);
            row.add_per_model("v", v);
            row.add_per_model_or_empty("p", p,
                options.initial_distribution_path.empty() && options.starting_copies < 0);
            row.add("a", options.alpha);
            row.add("P_ext", P_ext);
            row.add("P_fix", P_fix);
            row.add("P_tmo", P_tmo);
            row.add("T_ext", T_ext);
            row.add("T_fix", T_fix);
            row.add("T_tmo", T_tmo);
            row.add("T_ext_std", T_ext_std);
            row.add("T_fix_std", T_fix_std);
            row.add("T_tmo_std", T_tmo_std);
            row.add_per_model("P_cond_ext", P_cond_ext);
            row.add_per_model("P_cond_fix", P_cond_fix);
            row.add_per_model("T_uncond", T_uncond_m);
            row.add_per_model("T_cond_ext", T_cond_ext_m);
            row.add_per_model("T_cond_fix", T_cond_fix_m);
            row.add_per_model("T_cond_tmo", T_cond_tmo_m);
            row.print();
        } else {
            std::cout << "P_ext = " << std::setprecision(10) << P_ext << std::endl;
            std::cout << "P_fix = " << std::setprecision(10) << P_fix << std::endl;
            std::cout << "P_tmo = " << std::setprecision(10) << P_tmo << std::endl;
            std::cout << "T_ext = " << std::setprecision(10) << T_ext << " +/- " << T_ext_std << std::endl;
            std::cout << "T_fix = " << std::setprecision(10) << T_fix << " +/- " << T_fix_std << std::endl;
            std::cout << "T_tmo = " << std::setprecision(10) << T_tmo << " +/- " << T_tmo_std << std::endl;
            auto txt_vec = [](const char* name, const dvec& v) {
                std::cout << name << " = [" << v.transpose() << "]" << std::endl;
            };
            txt_vec("P_cond_ext", P_cond_ext);
            txt_vec("P_cond_fix", P_cond_fix);
            txt_vec("T_uncond", T_uncond_m);
            txt_vec("T_cond_ext", T_cond_ext_m);
            txt_vec("T_cond_fix", T_cond_fix_m);
            txt_vec("T_cond_tmo", T_cond_tmo_m);
        }
        
        // Clean up
        delete solver;
        
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