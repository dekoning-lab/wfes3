#ifdef WFES_CLI
#include <iostream>
#include "backend_config.h"
#include <cmath>
#include <iomanip>
#include <limits>
#include <vector>
#include <string>
#include <sstream>
#ifdef OMP
#include <omp.h>
#endif
#include "args.hpp"
#include "args_parser.hpp"
#include "banner.h"
#include "initial_distribution.h"   // for the shared validate_model_domain checks
#include "parsing.h"
#include "wright_fisher.h"
#include "utils.h"
#include "solver.h"
#include "output_formatter.hpp"    // for the shared solver-backend provenance fields
#include "exceptions.h"
#include "types.h"

using namespace std;
using namespace Eigen;

// Utility functions for parsing comma-separated values
std::vector<llong> parse_long_vector(const std::string& str) {
    std::vector<llong> values;
    std::stringstream ss(str);
    std::string item;
    
    while (std::getline(ss, item, ',')) {
        item.erase(0, item.find_first_not_of(" \t"));
        item.erase(item.find_last_not_of(" \t") + 1);
        if (!item.empty()) {
            values.push_back(std::stoll(item));
        }
    }
    return values;
}

std::vector<double> parse_double_vector(const std::string& str) {
    std::vector<double> values;
    std::stringstream ss(str);
    std::string item;
    
    while (std::getline(ss, item, ',')) {
        item.erase(0, item.find_first_not_of(" \t"));
        item.erase(item.find_last_not_of(" \t") + 1);
        if (!item.empty()) {
            values.push_back(std::stod(item));
        }
    }
    return values;
}

struct Options {
    llong p;  // Starting frequency count
    string initial_distribution_path = "";  // --initial: whole starting distribution
    std::vector<llong> N_vec;     // Population sizes
    std::vector<llong> t_vec;     // Time epochs  
    std::vector<double> s_vec;    // Selection coefficients
    std::vector<double> h_vec;    // Dominance coefficients
    std::vector<double> u_vec;    // Backward mutation rates
    std::vector<double> v_vec;    // Forward mutation rates
    double alpha = 1e-20;         // Matrix tail truncation (NOT the integration cutoff)
    // Starting-copy integration cutoff, matching the other ten tools. Negative
    // means "not requested": 0 is a meaningful value (integrate nothing).
    double integration_cutoff = -1.0;
    bool verbose = false;
    // Platform-aware: hardcoding "Pardiso" made this tool fail out of the box
    // on Apple Silicon, where MKL/Pardiso does not exist.
#ifdef __APPLE__
    string library = "Accelerate";
#else
    string library = "Pardiso";
#endif
    llong block_size = 100;
    llong n_threads = 1;          // -t/--num-threads
    string output_file = "";
    bool json_output = false;      // structured output; previously unavailable
    bool csv_output = false;
};

/**
 * Format a double at round-trip precision.
 *
 * std::to_string fixes 6 decimal places, which renders every realistic
 * mutation rate as "0.000000" -- useless in a diagnostic whose whole job is to
 * show the user the offending number. Matches num_str() in
 * wfes_sequential_main.cpp.
 */
static std::string num_str(double x) {
    std::ostringstream os;
    os << std::setprecision(std::numeric_limits<double>::max_digits10) << x;
    return os.str();
}

/**
 * Refuse an epoch whose Wright-Fisher matrix cannot be built.
 *
 * Unlike the absorbing models, this tool builds every matrix with
 * WF::NON_ABSORBING, which keeps all 2N+1 rows -- including the two boundary
 * rows that wfes_single and friends drop out of Q. wfes-lib builds each row in
 * log space (wrightFisher.cpp, binom_row): it starts from
 * ld_binom(start, size, p), whose terms are k*log(p) and (size-k)*log1p(-p),
 * and steps along the row by adding log(p) - log(1-p). Both are defined only
 * for a success probability strictly inside (0, 1):
 *
 *   - p = 0 makes k*log(p) the product 0 * -inf, i.e. nan;
 *   - p = 1 makes the row's first term -inf while the step is +inf, and
 *     -inf + inf is nan.
 *
 * Either way the row sums to nan, `r.Q /= r.weight` turns every entry of the
 * row nan, and the nan then reaches every state of the spectrum -- the sparse
 * product multiplies the poisoned row by a coefficient of 0, and 0 * nan is
 * nan, not 0.
 *
 * psi_diploid() returns exactly v for row 0 and exactly 1-u for row 2N, so the
 * boundary rows are degenerate precisely when v is zero, or when 1-u rounds to
 * 1.0. That second case is the one worth being careful about: it is NOT just
 * u == 0. Any u below about 1.1e-16 -- 1e-17, 1e-30, values every range check
 * in this tool accepts as an ordinary small mutation rate -- rounds 1-u to
 * exactly 1.0 and produced an all-nan spectrum at exit 0. So the test is on
 * the psi value the matrix builder will actually see, not on u and v.
 *
 * Non-finite s or h are refused for a related but distinct reason: psi_diploid
 * clamps the two fitnesses with fmax(w, 1e-30), and fmax returns its non-NaN
 * operand, so `--selection nan` was silently computed as a lethal homozygote
 * (s = -1) and reported at exit 0 as though it were the model asked for. An
 * infinite s instead drives w_bar to inf and every psi to nan.
 *
 * `Nx` is narrowed to int here because WF::Single() takes int, so this checks
 * exactly the value the builder will use.
 */
static void require_usable_matrix(llong Nx, double s, double h, double u,
                                  double v, const std::string& where) {
    auto bad = [&where](const std::string& msg) {
        throw std::runtime_error("Cannot build the " + where +
                                 " transition matrix: " + msg);
    };

    if (!std::isfinite(s)) {
        bad("selection coefficient s = " + num_str(s) + " is not a finite "
            "number. psi_diploid() clamps the fitnesses with fmax(), which "
            "discards a NaN rather than propagating it, so this would be "
            "computed as some other model's answer. Check --selection (-s).");
    }
    if (!std::isfinite(h)) {
        bad("dominance coefficient h = " + num_str(h) + " is not a finite "
            "number. psi_diploid() clamps the fitnesses with fmax(), which "
            "discards a NaN rather than propagating it, so this would be "
            "computed as some other model's answer. Check --dominance (-h).");
    }
    if (!std::isfinite(u)) {
        bad("backward mutation rate u = " + num_str(u) +
            " is not a finite number. Check --backward-mu (-u).");
    }
    if (!std::isfinite(v)) {
        bad("forward mutation rate v = " + num_str(v) +
            " is not a finite number. Check --forward-mu (-v).");
    }

    const int N = static_cast<int>(Nx);
    const int last = 2 * N;

    // Row 0: psi is exactly v. Zero forward mutation means a lost allele can
    // never reappear, which is a perfectly sensible model -- but not one this
    // matrix builder can express, so refuse rather than print its nan.
    const double psi_lost = wrightfisher::psi_diploid(0, N, s, h, u, v);
    if (!std::isfinite(psi_lost) || psi_lost <= 0.0) {
        bad("the row for 0 copies has binomial success probability " +
            num_str(psi_lost) + ", which is not strictly inside (0, 1), so "
            "wfes-lib's log-space row construction yields nan for that row "
            "and nan then spreads to the whole spectrum. That probability is "
            "the forward mutation rate v = " + num_str(v) + " exactly; this "
            "NON_ABSORBING model keeps the 0-copy row and so needs v > 0. "
            "Give --forward-mu (-v) a positive rate.");
    }

    // Row 2N: psi is exactly 1-u, and 1-u == 1.0 for every u below ~1.1e-16.
    const double psi_fixed = wrightfisher::psi_diploid(last, N, s, h, u, v);
    if (!std::isfinite(psi_fixed) || psi_fixed >= 1.0) {
        bad("the row for " + std::to_string(last) +
            " copies has binomial success probability " + num_str(psi_fixed) +
            ", which is not strictly inside (0, 1), so wfes-lib's log-space "
            "row construction yields nan for that row and nan then spreads to "
            "the whole spectrum. That probability is 1 - u for the backward "
            "mutation rate u = " + num_str(u) + "; 1 - u rounds to exactly 1 "
            "for any u below about 1.1e-16. This NON_ABSORBING model keeps "
            "the fixed row and so needs a --backward-mu (-u) large enough "
            "that 1 - u is representably below 1.");
    }

    // The interior rows cannot reach 0 or 1 for finite parameters, but they
    // are cheap to check (O(N) against the builder's O(N^2)) and a bad one
    // here would be exactly as invisible as the two above.
    for (int i = 1; i < last; ++i) {
        const double psi = wrightfisher::psi_diploid(i, N, s, h, u, v);
        if (!std::isfinite(psi) || psi <= 0.0 || psi >= 1.0) {
            bad("the row for " + std::to_string(i) +
                " copies has binomial success probability " + num_str(psi) +
                ", which is not strictly inside (0, 1), so wfes-lib's "
                "log-space row construction yields nan for that row and nan "
                "then spreads to the whole spectrum. Check --selection (-s), "
                "--dominance (-h), --backward-mu (-u) and --forward-mu (-v) "
                "for this epoch.");
        }
    }
}

/**
 * Refuse a normalisation whose denominator carries no probability.
 *
 * Every step of this tool ends in `p_vec /= p_vec.sum()`. A sum of zero makes
 * that 0/0 = nan for all 2N+1 entries, and a non-finite sum makes it nan or 0
 * across the board; either way the run has stopped computing a distribution
 * and must say so where it happened rather than at the far end of the output.
 */
static void require_normalisable(const dvec& p, const std::string& where) {
    const double total = p.sum();
    if (!std::isfinite(total) || total <= 0.0) {
        throw std::runtime_error(
            "The allele frequency spectrum after " + where + " sums to " +
            num_str(total) + ", so it cannot be normalised into a probability "
            "distribution. The computation did not produce a usable result; "
            "if --initial was given, check that file: a malformed or "
            "badly-scaled starting distribution can reach this point (the "
            "up-front checks in load_initial_distribution only rule out a "
            "non-positive or non-finite total, not one that later evolves "
            "to zero). Otherwise suspect underflow: an extreme selection, "
            "dominance or mutation-rate combination, run for enough "
            "generations, can drive every remaining state to numerically "
            "zero in double precision.");
    }
}

Options parse_arguments(int argc, char* argv[]) {
    args::ArgumentParser parser("Wright-Fisher Allele Frequency Spectrum (Deterministic)");

    // Detected before parsing so the ASCII banner can be suppressed for
    // structured output, exactly as every other tool's parse function does.
    // args' ParseCLI takes `char const**`; the cast is a const-qualification
    // change on a pointer this function never writes through.
    char const** argv_c = const_cast<char const**>(argv);
    const bool structured_output =
        wfes::cli::Args_Parser::is_structured_output_requested(argc, argv_c);


    args::HelpFlag help(parser, "help", "Display this help menu", {"help"});
    
    // --starting-copies is the canonical long name for an integer starting
    // copy count in all four tools that take one; --initial-count stays
    // accepted (the GUI emits it) but unadvertised. Likewise --pop-size, with
    // --pop-sizes kept as a silent alias. See AliasedValueFlag in
    // args_parser.hpp for why the alias has to live in the same matcher.
    wfes::cli::AliasedValueFlag<llong> arg_p(parser, "int",
        "Starting number of copies (initial allele count)",
        {'p', "starting-copies", "initial-count"}, {"initial-count"});
    args::ValueFlag<double> arg_integration_cutoff(parser, "float",
        "Starting number of copies integration cutoff", {'c', "integration-cutoff"});
    wfes::cli::AliasedValueFlag<string> arg_N_vec(parser, "int[k]",
        "Population sizes, comma-separated (one entry per epoch, required)",
        {'N', "pop-size", "pop-sizes"}, {"pop-sizes"});
    args::ValueFlag<string> arg_t_vec(parser, "int[k]", "Number of generations, comma-separated (one entry per epoch, required)", {'G', "generations"});
    args::ValueFlag<string> arg_s_vec(parser, "float[k]", "Selection coefficients, comma-separated (one entry per epoch)", {'s', "selection"});
    args::ValueFlag<string> arg_h_vec(parser, "float[k]", "Dominance coefficients, comma-separated (one entry per epoch)", {'h', "dominance"});
    args::ValueFlag<string> arg_u_vec(parser, "float[k]", "Backward mutation rates, comma-separated (one entry per epoch)", {'u', "backward-mu"});
    args::ValueFlag<string> arg_v_vec(parser, "float[k]", "Forward mutation rates, comma-separated (one entry per epoch)", {'v', "forward-mu"});
    args::ValueFlag<double> arg_alpha(parser, "float", "Tail truncation weight", {'a', "alpha"});
    args::ValueFlag<string> arg_initial(parser, "path",
        "Path to initial state distribution CSV (one probability per state)", {'i', "initial"});
    args::Flag arg_verbose(parser, "verbose", "Verbose solver output", {"verbose"});
    args::ValueFlag<string> arg_library(parser, "library",
        wfes::cli::Args_Parser::library_flag_help(), {'l', "library"});
    args::ValueFlag<llong> arg_block_size(parser, "int", "Block size", {'b', "block-size"});
    // This tool was the only one of the eleven with no thread control, while
    // the GUI emitted --num-threads for it -- so any run from the GUI failed
    // with "Flag could not be matched: num-threads". Its per-epoch matrix
    // construction in wfes-lib is OpenMP-parallel, so the flag is meaningful.
    args::ValueFlag<llong> arg_n_threads(parser, "int", "Number of threads",
                                         {'t', "num-threads"});
    args::ValueFlag<string> arg_output_file(parser, "output_file", "Output file", {'o', "output-file"});
    args::Flag arg_json(parser, "json", "Output results in JSON format", {"json"});
    args::Flag arg_csv(parser, "csv", "Output results in CSV format", {"csv"});

    try {
        parser.ParseCLI(argc, argv);
    } catch (args::Help&) {
        if (!structured_output) {
            wfes::banner::displayBanner("wfafs_deterministic");
        }
        cout << parser;
        exit(0);
    } catch (args::ParseError& e) {
        if (!structured_output) {
            wfes::banner::displayBanner("wfafs_deterministic");
        }
        cerr << e.what() << endl;
        cerr << parser;
        exit(1);
    }

    // Display banner for successful parsing (unless structured output is
    // requested). This tool was the one of the eleven whose parse function
    // never called displayBanner, so it identified itself nowhere in its
    // output -- a plain-text run began straight at the spectrum's first row.
    if (!structured_output) {
        wfes::banner::displayBanner("wfafs_deterministic");
    }

    Options options;

    // -p names a single starting count. It is not required when the starting
    // distribution comes from a file or from the mutation integration, which
    // both replace it; -1 marks "not given" so the run can tell them apart.
    options.p = arg_p ? args::get(arg_p) : -1;
    
    if (!arg_N_vec) {
        throw std::invalid_argument("Error: argument --pop-sizes (-N) is required.");
    }
    options.N_vec = parse_long_vector(args::get(arg_N_vec));
    
    if (!arg_t_vec) {
        throw std::invalid_argument("Error: argument --generations (-G) is required.");
    }
    options.t_vec = parse_long_vector(args::get(arg_t_vec));
    
    if (!arg_s_vec) {
        throw std::invalid_argument("Error: argument s-vec is required.");
    }
    options.s_vec = parse_double_vector(args::get(arg_s_vec));
    
    // Optional arguments with defaults
    if (arg_h_vec) {
        options.h_vec = parse_double_vector(args::get(arg_h_vec));
    } else {
        options.h_vec = std::vector<double>(options.s_vec.size(), 0.5);
    }
    
    if (arg_u_vec) {
        options.u_vec = parse_double_vector(args::get(arg_u_vec));
    } else {
        options.u_vec = std::vector<double>(options.s_vec.size(), 1e-9);
    }
    
    if (arg_v_vec) {
        options.v_vec = parse_double_vector(args::get(arg_v_vec));
    } else {
        options.v_vec = std::vector<double>(options.s_vec.size(), 1e-9);
    }
    
    if (arg_alpha) options.alpha = args::get(arg_alpha);
    if (arg_integration_cutoff) options.integration_cutoff = args::get(arg_integration_cutoff);
    if (arg_initial) options.initial_distribution_path = args::get(arg_initial);
    if (arg_verbose) options.verbose = true;
    if (arg_library) options.library = args::get(arg_library);
    // This tool has its own parser, so it does not inherit the shared
    // validate_* checks; the library string has to be checked here or an
    // unrecognised one falls through the factories' `else` to the platform
    // default and reports success.
    wfes::cli::Args_Parser::validate_library(options.library);
    if (arg_block_size) options.block_size = args::get(arg_block_size);
    if (arg_n_threads) options.n_threads = args::get(arg_n_threads);
    if (arg_output_file) options.output_file = args::get(arg_output_file);
    options.json_output = arg_json;
    options.csv_output = arg_csv;
    // parse_arguments returns Options, so signal the conflict by throwing; the
    // caller's catch turns it into "Error: ..." on stderr with a nonzero exit,
    // matching how the other validation failures in this function report.
    if (options.json_output && options.csv_output) {
        throw std::runtime_error("Cannot specify both --csv and --json output formats");
    }
    
    // Validate vector lengths
    size_t n_epochs = options.N_vec.size();
    if (options.t_vec.size() != n_epochs ||
        options.s_vec.size() != n_epochs ||
        options.h_vec.size() != n_epochs ||
        options.u_vec.size() != n_epochs ||
        options.v_vec.size() != n_epochs) {
        throw std::invalid_argument("Error: All parameter vectors must have the same length.");
    }

    // Per-epoch domain checks. This tool has its own parser and its own Options
    // struct rather than going through Args_Parser, so it does not inherit the
    // validation the other tools get; apply the same rules per epoch.
    for (size_t i = 0; i < n_epochs; ++i) {
        wfes::cli::Args_Parser::validate_model_domain(
            options.N_vec[i], options.s_vec[i], options.h_vec[i],
            options.u_vec[i], options.v_vec[i], options.alpha,
            "epoch " + std::to_string(i + 1));
    }

    return options;
}

int main(int argc, char* argv[]) {
    try {
        Options options = parse_arguments(argc, argv);

        // Same OMP + MKL pair the other tools use; see their mains.
        if (options.n_threads > 0) {
#ifdef OMP
            omp_set_num_threads(options.n_threads);
#endif
#ifdef WFES_USE_MKL
            mkl_set_num_threads(options.n_threads);
#endif
        }

        // Every matrix this run will build has to be checked before anything
        // is computed, not as each one is reached: the starting distribution
        // below already calls binom_row() with the first epoch's parameters,
        // so a check deferred to the epoch loop would be too late to stop the
        // integration-cutoff branch from building a nan starting vector. (That
        // branch's own `first(0) >= 1.0` test does not catch it either -- every
        // comparison against nan is false, so a nan row walks straight past
        // it.) There are two families of matrices: one per epoch, and one per
        // size switch, which pairs the CURRENT epoch's population size with
        // the NEXT epoch's model parameters.
        for (size_t epoch = 0; epoch < options.N_vec.size(); ++epoch) {
            require_usable_matrix(
                options.N_vec[epoch], options.s_vec[epoch], options.h_vec[epoch],
                options.u_vec[epoch], options.v_vec[epoch],
                "epoch " + std::to_string(epoch + 1));
            if (epoch + 1 < options.N_vec.size()) {
                require_usable_matrix(
                    options.N_vec[epoch], options.s_vec[epoch + 1],
                    options.h_vec[epoch + 1], options.u_vec[epoch + 1],
                    options.v_vec[epoch + 1],
                    "epoch " + std::to_string(epoch + 1) + " -> " +
                    std::to_string(epoch + 2) + " population size switch");
            }
        }

        // Starting distribution. --initial supplies the whole thing; otherwise
        // it is a point mass at p, which is what this has always used. The
        // range check applies only to p, since a supplied distribution carries
        // its own support.
        dvec p_vec = dvec::Zero(2 * options.N_vec[0] + 1);
        if (!options.initial_distribution_path.empty()) {
            p_vec = wfes::cli::load_initial_distribution(
                options.initial_distribution_path, 2 * options.N_vec[0] + 1,
                "allele counts 0..2N in the first epoch");
        } else if (options.integration_cutoff >= 0 && options.p < 0) {
            // The starting-copy distribution a new mutation produces, as the
            // other tools build it: row 0 of the first epoch's matrix,
            // conditioned on at least one copy, truncated at the cutoff.
            wrightfisher::Row row = wrightfisher::binom_row(
                2 * options.N_vec[0],
                wrightfisher::psi_diploid(0, options.N_vec[0], options.s_vec[0],
                                          options.h_vec[0], options.u_vec[0], options.v_vec[0]),
                options.alpha);
            dvec first = row.Q;
            if (first(0) >= 1.0) {
                throw std::invalid_argument(
                    "Error: no mutation reaches one copy (forward mutation rate is zero?); "
                    "--integration-cutoff has nothing to integrate over.");
            }
            dvec tail = first.tail(first.size() - 1);
            // Renormalize by the tail's OWN sum, not by 1 - first(0): binom_row
            // sum-normalizes the row, so the two are the same quantity, but the
            // subtraction cancels to roundoff (first(0) = 1 - O(2Nv)). See the
            // long note at the wfes_single site (wfes_single_main.cpp).
            tail /= tail.sum();
            llong z = 0;
            if (options.integration_cutoff > 0) {
                while (z < tail.size() && tail(z) > options.integration_cutoff) z++;
            } else {
                z = tail.size();  // cutoff 0: keep every copy number the row has
            }
            if (z == 0) {
                throw std::invalid_argument(
                    "Error: --integration-cutoff is above every starting-copy probability; "
                    "nothing would be integrated over.");
            }
            for (llong i = 0; i < z; i++) {
                llong state = row.start + 1 + i;
                if (state < p_vec.size()) p_vec(state) = tail(i);
            }
            require_normalisable(p_vec, "the --integration-cutoff starting distribution");
            p_vec /= p_vec.sum();
        } else {
            if (options.p < 0) {
                throw std::invalid_argument(
                    "Error: no starting state given. Use -p <count>, "
                    "--integration-cutoff <float>, or --initial <path>.");
            }
            // Valid starting counts are 1..2N-1: the state space is 0..2N, and
            // the bound here read `>= N`, which rejected every count in the
            // upper half of a perfectly ordinary state space.
            if (options.p <= 0 || options.p >= 2 * options.N_vec[0]) {
                throw std::invalid_argument(
                    "Error: starting count p must be in range (0, 2N[0]).");
            }
            p_vec(options.p) = 1.0;
        }
        
        if (options.verbose) {
            cout << "Starting with frequency " << options.p << " in population of size " << options.N_vec[0] << endl;
        }
        
        // Evolve through epochs
        for (size_t epoch = 0; epoch < options.N_vec.size(); ++epoch) {
            if (options.verbose) {
                cout << "Epoch " << (epoch + 1) << "/" << options.N_vec.size() 
                     << ": N=" << options.N_vec[epoch] 
                     << ", t=" << options.t_vec[epoch]
                     << ", s=" << options.s_vec[epoch] << endl;
            }
            
            // Evolve for t generations within the epoch
            WF::Matrix wf = WF::Single(
                options.N_vec[epoch], options.N_vec[epoch], 
                WF::NON_ABSORBING, 
                options.s_vec[epoch], options.h_vec[epoch], 
                options.u_vec[epoch], options.v_vec[epoch], 
                true, options.alpha, options.verbose, options.block_size, options.library);
            wf.Q->multiplyInPlaceRep(p_vec, options.t_vec[epoch], true);
            require_normalisable(p_vec, "epoch " + std::to_string(epoch + 1));
            p_vec /= p_vec.sum();

            // Switch population size for next epoch (if not last epoch)
            if (epoch + 1 < options.N_vec.size()) {
                WF::Matrix wf_switch = WF::Single(
                    options.N_vec[epoch], options.N_vec[epoch + 1], 
                    WF::NON_ABSORBING, 
                    options.s_vec[epoch + 1], options.h_vec[epoch + 1], 
                    options.u_vec[epoch + 1], options.v_vec[epoch + 1], 
                    true, options.alpha, options.verbose, options.block_size, options.library);
                dvec next = wf_switch.Q->multiply(p_vec, true);
                require_normalisable(
                    next, "the epoch " + std::to_string(epoch + 1) + " -> " +
                    std::to_string(epoch + 2) + " population size switch");
                next /= next.sum();
                p_vec = next;
            }
        }

        // Last line of defence, and deliberately independent of every check
        // above: whatever route a nan or an inf might take into the spectrum,
        // it stops here rather than being published. The guards earlier in
        // this run name a cause; this one only guarantees that nothing
        // unprintable is printed, in any format. It has to sit ahead of ALL
        // FOUR output branches -- a bare `nan` is not valid JSON (python's
        // json.loads and node's JSON.parse both reject it, and jq silently
        // coerces it to 1.797...e308, a plausible-looking fake number in any
        // downstream pipeline), and it is no more meaningful in the csv, the
        // plain two-column dump or the --output-file.
        auto require_finite = [](double value, const std::string& name) {
            if (!std::isfinite(value)) {
                throw std::runtime_error(
                    "Computed " + name + " = " + num_str(value) + ", which is "
                    "not a number this tool can report. The computation did "
                    "not produce a usable result, so no spectrum is written.");
            }
        };
        for (llong i = 0; i < p_vec.size(); i++) {
            require_finite(p_vec(i), "the probability of " +
                                     std::to_string(i) + " copies");
        }
        // alpha is echoed into the JSON parameters block, so it is published
        // too and is swept on the same terms as the spectrum itself.
        require_finite(options.alpha, "alpha");

        // Output final allele frequency spectrum
        if (!options.output_file.empty()) {
            std::ofstream output_stream(options.output_file.c_str());
            for (llong i = 0; i < p_vec.size(); i++) {
                output_stream << i << "\t" << p_vec(i) << endl;
            }
            output_stream.close();
        } else if (options.json_output) {
            // Round-trip precision; the stream default of 6 significant figures
            // would discard information the computation already has.
            cout << std::setprecision(std::numeric_limits<double>::max_digits10);
            // This tool previously had no --json or --csv at all: its only
            // output was a bare two-column "index<TAB>probability" dump, which
            // is why the GUI had to scrape text and mis-parsed the values.
            cout << "{" << endl;
            cout << "  \"model\": \"wfafs_deterministic\"," << endl;
            cout << "  \"parameters\": {" << endl;
            // Solver-backend provenance: what was ASKED FOR and what actually
            // ran. SolverFactory serves a "--library Accelerate" request with
            // SuiteSparse whenever this build has it, so the request alone is not
            // a record of the run. See output_formatter.hpp.
            cout << wfes::cli::OutputFormatter::library_provenance_json(options.library);
            cout << "    \"starting_count\": " << options.p << "," << endl;
            cout << "    \"n_epochs\": " << options.N_vec.size() << "," << endl;
            cout << "    \"population_sizes\": [";
            for (size_t i = 0; i < options.N_vec.size(); i++) {
                cout << options.N_vec[i];
                if (i + 1 < options.N_vec.size()) cout << ", ";
            }
            cout << "]," << endl;
            cout << "    \"epoch_lengths\": [";
            for (size_t i = 0; i < options.t_vec.size(); i++) {
                cout << options.t_vec[i];
                if (i + 1 < options.t_vec.size()) cout << ", ";
            }
            cout << "]," << endl;
            cout << "    \"alpha\": " << options.alpha << endl;
            cout << "  }," << endl;
            cout << "  \"spectrum\": [" << endl;
            for (llong i = 0; i < p_vec.size(); i++) {
                cout << "    {\"count\": " << i << ", \"probability\": " << p_vec(i) << "}";
                if (i + 1 < p_vec.size()) cout << ",";
                cout << endl;
            }
            cout << "  ]" << endl;
            cout << "}" << endl;
        } else if (options.csv_output) {
            // Same round-trip precision as the JSON branch above: CSV is read
            // by a program too, and 6 significant figures cannot be converted
            // back to the double that was computed.
            cout << std::setprecision(std::numeric_limits<double>::max_digits10);
            cout << "count,probability" << endl;
            for (llong i = 0; i < p_vec.size(); i++) {
                cout << i << "," << p_vec(i) << endl;
            }
        } else {
            for (llong i = 0; i < p_vec.size(); i++) {
                cout << i << "\t" << p_vec(i) << endl;
            }
        }
        
    } catch (const std::exception& e) {
        cerr << "Error: " << e.what() << endl;
        return 1;
    }
    
    return 0;
}
#endif // WFES_CLI