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

/**
 * Format a double at full precision for a diagnostic.
 *
 * std::to_string fixes six decimal places, which renders every value this
 * function is asked about ("what did the vector actually sum to?") as
 * "0.000000" or "nan" -- useless in a message whose whole job is to show the
 * user the offending number.
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
 * Validate the starting-probability vector (-p) and normalise it to sum 1.
 *
 * -p was used raw as the weight on each model's starting states, so it never
 * had to be a probability vector for the run to report a result:
 * `-p 1,1` gave P_ext = 1.8749999928, `-p 5,5` gave P_ext = 9.375, `-p -2,1`
 * gave P_ext = -0.9375 and `-p 0,0` gave zeros -- every one of them with exit
 * status 0, and every one of them a number a reader would take for a
 * probability.
 *
 * The rules and the wording follow the --initial check in
 * initial_distribution.h: a negative entry or a non-positive (or non-finite)
 * sum is a hard error, and a sum that is not 1 is renormalised out loud rather
 * than silently, since renormalising without saying so hides a malformed
 * command line.
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
 * The --fixation branch used to emit a bare data row with the column order
 * recorded only in a comment -- while absorption mode of the same binary does
 * emit a header, so whether `wfes_switching --csv` had one depended on the
 * model type. Writing that header as a separate list of literals is the other
 * failure mode, since the two lists then drift apart, so the name and the value
 * are added together here and both lines are printed from the same list.
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

        // -p is a probability distribution over the models, not a free weight.
        // Done before the echo below and before any use, so what is printed and
        // recorded is what the run actually integrates with.
        normalise_starting_probabilities(p, "Starting probabilities");

        // -c (--integration-cutoff) drops starting COPY NUMBERS whose
        // probability under the mutation-injection distribution p0 falls below
        // it. --fixation has no such integration: FIXATION_ONLY keeps allele
        // count 0 transient and each model contributes exactly that one
        // starting state, weighted by -p. The flag was consequently read only
        // in the absorption branch, and --fixation accepted every value of -c
        // and produced byte-identical output for -c 1e-10, -c 0.9 and -c 1.
        //
        // Silently ignoring a parameter the user set deliberately is not an
        // option for a tool whose numbers go into papers, and there is no
        // honest way to honour it here -- p0 is degenerate in this mode, so a
        // cutoff could only ever mean "keep the one state" or "keep none". So
        // refuse. The parser collapses "not supplied" and "supplied as the
        // default 1e-10" into one value (CommandLineOptions has no
        // was-it-supplied flag), so a -c equal to the default is accepted as
        // the no-op it is; any other value is refused.
        if (options.model_type == CLI::ModelType::FIXATION &&
            options.integration_cutoff != 1e-10) {
            throw std::runtime_error(
                "--integration-cutoff (-c) is not applicable to --fixation: "
                "that model has no distribution over starting copy numbers to "
                "integrate over or to truncate. Each of the " +
                std::to_string(n_models) + " models contributes a single "
                "starting state (allele count 0) weighted by -p, and --initial "
                "supplies one distribution that is used whole. The value given "
                "(" + num_str(options.integration_cutoff) + ") would have had "
                "no effect on the result. Use --absorption to integrate over "
                "starting copy numbers, or drop -c");
        }

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
            
            // Calculate fixation time and rate.
            //
            // The reciprocal was taken unguarded, so a zeroed N (which -p 0,0
            // used to produce) gave T_fix = 0 and printed "rate": inf into a
            // JSON document -- unparseable, and no more meaningful in the CSV
            // and text branches. A non-positive or non-finite expected time is
            // a failed computation, not a result to report.
            double T_fix = N.sum();
            if (!std::isfinite(T_fix) || T_fix <= 0) {
                throw std::runtime_error(
                    "Expected time to fixation came out as " + num_str(T_fix) +
                    ", so the fixation rate 1/T_fix is not defined. This "
                    "computation did not produce a usable result; check -N, -p "
                    "and -r");
            }
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
                // The parameters block records what the run used, so that a
                // JSON result is self-describing. It used to carry only N, s, h
                // and alpha -- while -p scales T_fix directly (T_fix doubles
                // between no -p and -p 1,1) and u and v set the mutation
                // pressure the whole fixation-only model runs on. Two runs that
                // differed in any of those were indistinguishable from their
                // recorded parameters. p is the NORMALISED vector, i.e. the one
                // the integration actually weighted with.
                auto json_vec = [&](const char *name, const auto &vals) {
                    std::cout << "    \"" << name << "\": [";
                    for (llong i = 0; i < n_models; i++) {
                        std::cout << vals(i);
                        if (i < n_models - 1) std::cout << ", ";
                    }
                    std::cout << "]," << std::endl;
                };
                std::cout << "{" << std::endl;
                std::cout << "  \"model\": \"switching_fixation\"," << std::endl;
                std::cout << "  \"parameters\": {" << std::endl;
                std::cout << "    \"n_models\": " << n_models << "," << std::endl;
                json_vec("population_sizes", population_sizes);
                json_vec("selection_coefficients", s);
                json_vec("dominance_coefficients", h);
                json_vec("backward_mutation_rates", u);
                json_vec("forward_mutation_rates", v);
                // --initial replaces the per-model starting states and their -p
                // weights with one supplied distribution, so exactly one of the
                // two is what the run started from.
                if (options.initial_distribution_path.empty()) {
                    json_vec("starting_probabilities", p);
                } else {
                    std::cout << "    \"initial_distribution\": \""
                              << json_escape(options.initial_distribution_path)
                              << "\"," << std::endl;
                }
                std::cout << "    \"alpha\": " << options.alpha << std::endl;
                std::cout << "  }," << std::endl;
                std::cout << "  \"results\": {" << std::endl;
                std::cout << "    \"T_fix\": " << T_fix << "," << std::endl;
                std::cout << "    \"rate\": " << rate << std::endl;
                std::cout << "  }" << std::endl;
                std::cout << "}" << std::endl;
            } else if (options.csv_output) {
                // Header plus one data row, both from the same column list.
                // This branch used to emit the bare data row: the column order
                // lived in a comment, so the output was self-describing only if
                // you had the source open -- and absorption mode of the same
                // binary does print a header, so whether `--csv` had one
                // depended on the model type.
                CsvRow row;
                row.add_per_model("N", population_sizes);
                row.add_per_model("s", s);
                row.add_per_model("h", h);
                row.add_per_model("u", u);
                row.add_per_model("v", v);
                row.add_per_model("p", p);
                row.add("a", options.alpha);
                row.add("T_fix", T_fix);
                row.add("rate", rate);
                row.print();
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
                // The --initial branch above already refuses an empty
                // integration; this branch did not, and every accumulator below
                // is zero-initialised, so `-c 1` printed a full set of zeroed
                // results (P_ext = P_fix = T_ext = T_fix = 0) and exited 0. That
                // is a placeholder presented as an answer.
                if (start_weights.empty()) {
                    throw std::runtime_error(
                        "No starting state is above the integration cutoff "
                        "(-c = " + num_str(options.integration_cutoff) +
                        "); lower -c so the starting distribution has mass to "
                        "integrate over.");
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