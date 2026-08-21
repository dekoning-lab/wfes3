#include "types.h"
#include "args.hpp"
#include "args_parser.hpp"
#include "backend_config.h"
#include "banner.h"
#include <iostream>
#include <limits>
#include <iomanip>
#include <sstream>
#include <stdexcept>
#include <algorithm>
#include <vector>

namespace wfes {
namespace cli {

namespace {

// Decimal rendering that does not throw away the value it is complaining about.
// std::to_string fixes 6 decimal places, so every realistic mutation rate comes
// out as "0.000000".
std::string num_str(double x) {
    std::ostringstream os;
    os << std::setprecision(std::numeric_limits<double>::max_digits10) << x;
    return os.str();
}

// Comma-separated vector parsers, used ONLY by the validators below so that the
// per-model advisories can see the numbers the user actually passed. The mains
// have their own copies of these; this one is deliberately forgiving, because a
// malformed vector is the main's error to report (with the flag name and the
// expected length), not this layer's.
std::vector<double> split_doubles(const std::string& s) {
    std::vector<double> out;
    std::stringstream ss(s);
    std::string item;
    while (std::getline(ss, item, ',')) {
        item.erase(0, item.find_first_not_of(" \t"));
        item.erase(item.find_last_not_of(" \t") + 1);
        if (item.empty()) continue;
        try {
            out.push_back(std::stod(item));
        } catch (const std::exception&) {
            return {};  // let the main report the parse failure
        }
    }
    return out;
}

std::vector<llong> split_longs(const std::string& s) {
    std::vector<llong> out;
    std::stringstream ss(s);
    std::string item;
    while (std::getline(ss, item, ',')) {
        item.erase(0, item.find_first_not_of(" \t"));
        item.erase(item.find_last_not_of(" \t") + 1);
        if (item.empty()) continue;
        try {
            out.push_back(std::stoll(item));
        } catch (const std::exception&) {
            return {};
        }
    }
    return out;
}

// One vector of per-model values: the user's list if they gave one, otherwise
// the tool's default repeated n times. Mirrors the `str.empty() ? Constant :
// parse` pattern the vector mains use.
std::vector<double> per_model(const std::string& s, size_t n, double fallback) {
    if (s.empty()) return std::vector<double>(n, fallback);
    return split_doubles(s);
}

// The hard N floor. Shared by validate_model_domain and by the vector tools'
// parse-time pre-check, so the two cannot drift apart on either the threshold
// or the wording.
void check_min_population(llong N, const std::string& where) {
    if (N >= Args_Parser::MIN_POPULATION_SIZE) return;
    const std::string at = where.empty() ? "" : (" (" + where + ")");
    throw std::runtime_error(
        "Invalid model parameters" + at + ": population size N must be at least " +
        std::to_string(Args_Parser::MIN_POPULATION_SIZE) + ", got " +
        std::to_string(N) +
        ". The state space has 2N+1 states of which 2N-1 are transient, and "
        "N = 1 leaves a single transient state that the starting-copies "
        "machinery indexes past: the shipped binaries abort on an Eigen bounds "
        "assert, and an NDEBUG build reads off the end of the vector and "
        "reports the result with exit 0");
}

// The hard N floor for a multi-model tool's -N list, at parse time.
void check_min_population_vector(const std::string& sizes_str, const char* unit) {
    const std::vector<llong> N = split_longs(sizes_str);
    for (size_t i = 0; i < N.size(); ++i) {
        check_min_population(N[i], std::string(unit) + " " + std::to_string(i + 1));
    }
}

// The four advisories, applied to whatever N/s/u/v vectors a multi-model tool
// was given. Length disagreements are left to the main's require_len.
//
// `factors_str` is wfafs_stochastic's -f: that tool solves a REDUCED model,
// N/f with s, u and v each multiplied by f, and it is the reduced model the
// advisories should be judging. 4N*mu and 2Ns happen to be invariant under
// that rescaling, but the population-size advisory is not, and warning about
// a 10^6 that the tool is about to turn into a 10^4 would be a false alarm.
// Empty means no rescaling.
void advise_vector_tool(const CommandLineOptions& options, const char* unit,
                        const std::string& factors_str = "") {
    const std::vector<llong> N = split_longs(options.population_sizes_str);
    if (N.empty()) return;
    const size_t n = N.size();
    std::vector<double> s = per_model(options.selection_coefficients_str, n, 0.0);
    std::vector<double> u = per_model(options.backward_mutations_str, n, 1e-9);
    std::vector<double> v = per_model(options.forward_mutations_str, n, 1e-9);
    if (s.size() != n || u.size() != n || v.size() != n) return;

    std::vector<llong> N_eff = N;
    if (!factors_str.empty()) {
        const std::vector<double> f = split_doubles(factors_str);
        if (f.size() != n) return;  // the main reports the length mismatch
        for (size_t i = 0; i < n; ++i) {
            if (!(f[i] > 0)) return;  // the main reports a nonsensical factor
            N_eff[i] = static_cast<llong>(static_cast<double>(N[i]) / f[i]);
            s[i] *= f[i];
            u[i] *= f[i];
            v[i] *= f[i];
        }
    }

    for (size_t i = 0; i < n; ++i) {
        Args_Parser::validate_model_advisories(
            N_eff[i], s[i], u[i], v[i],
            std::string(unit) + " " + std::to_string(i + 1));
    }
}

}  // namespace

std::string Args_Parser::get_default_library() {
#ifdef __APPLE__
    const std::string preferred = "Accelerate";
#else
    const std::string preferred = "Pardiso";
#endif
    // Now that an unrecognised --library is refused rather than silently
    // redirected, a default this build cannot construct would refuse every run
    // that omits the flag. The platform preference stands whenever it is
    // actually available; otherwise take whatever this build does have.
    const std::vector<std::string>& libs = supported_libraries();
    if (std::find(libs.begin(), libs.end(), preferred) != libs.end()) return preferred;
    return libs.empty() ? preferred : libs.front();
}

const std::vector<std::string>& Args_Parser::supported_libraries() {
    // Built once, from the same WFES_USE_* macros SolverFactory and
    // SparseMatrixFactory switch on (backend_config.h derives them from the
    // platform and the CMake feature flags). Adding a backend to the build
    // therefore adds it to --help and to the accepted set at the same time.
    static const std::vector<std::string> libs = [] {
        std::vector<std::string> v;
#ifdef WFES_USE_MKL
        v.emplace_back("Pardiso");
#endif
#ifdef WFES_USE_ACCELERATE
        v.emplace_back("Accelerate");
#endif
#ifdef WFES_USE_SUITESPARSE
        v.emplace_back("SuiteSparse");
#endif
#ifdef WFES_USE_PARU
        v.emplace_back("ParU");
#endif
        return v;
    }();
    return libs;
}

std::string Args_Parser::supported_libraries_text() {
    const std::vector<std::string>& libs = supported_libraries();
    std::string out;
    for (size_t i = 0; i < libs.size(); ++i) {
        if (i > 0) out += (i + 1 == libs.size()) ? (libs.size() == 2 ? " or " : ", or ") : ", ";
        out += libs[i];
    }
    return out;
}

std::string Args_Parser::library_flag_help() {
    std::string help = "Library (" + supported_libraries_text() + ")";
#ifdef WFES_USE_ACCELERATE
    help += ". Note: on macOS, Accelerate uses UMFPACK for the factorization";
#endif
    return help;
}

void Args_Parser::validate_library(const std::string& library) {
    const std::vector<std::string>& libs = supported_libraries();
    if (std::find(libs.begin(), libs.end(), library) != libs.end()) return;

    std::string msg = "Unknown --library value '" + library +
                      "'. This build supports: " + supported_libraries_text();
    // Naming the two former options explicitly, because both used to be
    // advertised and both now fail: ViennaCL was listed by every tool's --help
    // and never worked without OpenCL, and Pardiso is MKL-only.
    if (library == "ViennaCL") {
        msg += ". ViennaCL requires an OpenCL-enabled build and is not compiled "
               "into this one";
    } else if (library == "Pardiso") {
        msg += ". Pardiso comes from Intel MKL, which this build does not link";
    }
    throw std::runtime_error(msg);
}

// See the contract and rationale in args_parser.hpp. Summary: these are hard
// domain errors, not --force-bypassable advisories.
bool Args_Parser::is_structured_output_requested(int argc, char const *argv[]) {
    // The banner corrupted --csv streams exactly as it once corrupted --json:
    // ASCII art plus a "Program:" header ahead of the CSV header row, so no
    // strict CSV reader accepted the output.
    for (int i = 1; i < argc; ++i) {
        std::string a(argv[i]);
        if (a == "--json" || a == "--csv") return true;
    }
    return false;
}

void Args_Parser::validate_model_domain(llong N, double s, double h,
                                        double u, double v, double alpha,
                                        const std::string& where) {
    const std::string at = where.empty() ? "" : (" (" + where + ")");
    auto bad = [&at](const std::string& msg) {
        throw std::runtime_error("Invalid model parameters" + at + ": " + msg);
    };
    // std::to_string fixes 6 decimal places, which renders every realistic
    // mutation rate as "0.000000" or "-0.000000" -- useless in an error whose
    // whole job is to show the user the offending value.
    auto num = [](double x) {
        std::ostringstream os;
        os << std::setprecision(std::numeric_limits<double>::max_digits10) << x;
        return os.str();
    };

    check_min_population(N, where);
    if (u < 0.0 || u >= 1.0) {
        bad("backward mutation rate u must be in [0, 1), got " + num(u));
    }
    if (v < 0.0 || v >= 1.0) {
        bad("forward mutation rate v must be in [0, 1), got " + num(v));
    }
    if (alpha < 0.0) {
        bad("tail truncation weight alpha must be non-negative, got " +
            num(alpha));
    }
    // psi_diploid() clamps both of these with fmax(w, 1e-30). Reaching that
    // clamp means the solver quietly answers a different question than the one
    // asked, so refuse instead.
    if (1.0 + s < 0.0) {
        bad("homozygote fitness 1+s = " + num(1.0 + s) +
            " is negative (s = " + num(s) + "); s must be >= -1");
    }
    if (1.0 + s * h < 0.0) {
        bad("heterozygote fitness 1+sh = " + num(1.0 + s * h) +
            " is negative (s = " + num(s) + ", h = " + num(h) +
            "); the product sh must be >= -1");
    }
}

void Args_Parser::validate_model_domain_vectors(const lvec& N, const dvec& s, const dvec& h,
                                                const dvec& u, const dvec& v, double alpha) {
    for (llong i = 0; i < N.size(); ++i) {
        validate_model_domain(N(i), s(i), h(i), u(i), v(i), alpha,
                              "model " + std::to_string(i + 1));
    }
}

// See the contract in args_parser.hpp. These are the --force-bypassable
// advisories; callers skip the whole set when --force is given.
void Args_Parser::validate_model_advisories(llong N, double s, double u, double v,
                                            const std::string& where) {
    const std::string at = where.empty() ? "" : (" for " + where);
    auto advise = [&at](const std::string& msg) {
        throw std::runtime_error(msg + at + ". Use --force to ignore");
    };

    if (N > 500000) {
        advise("Population size is quite large - the computations will take a "
               "long time (N = " + std::to_string(N) + ")");
    }

    const double max_mu = std::max(u, v);
    if ((4 * static_cast<double>(N) * max_mu) > 1) {
        advise("The mutation rate might violate the Wright-Fisher assumptions "
               "(4N*mu = " + num_str(4 * static_cast<double>(N) * max_mu) +
               ", which is above 1)");
    }

    if ((2 * static_cast<double>(N) * s) <= -100) {
        advise("The selection coefficient is quite negative. Fixations might be "
               "impossible (2Ns = " + num_str(2 * static_cast<double>(N) * s) + ")");
    }
}

void Args_Parser::setup_parser_params(args::ArgumentParser& parser) {
    parser.helpParams.width = 120;
    parser.helpParams.helpindent = 50;
    parser.helpParams.flagindent = 2;
}

bool Args_Parser::is_json_requested(int argc, char const *argv[]) {
    // Quick scan through arguments to check for --json flag
    for (int i = 1; i < argc; ++i) {
        if (std::string(argv[i]) == "--json") {
            return true;
        }
    }
    return false;
}

CommandLineOptions Args_Parser::parse_wfes_single_args(int argc, char const *argv[]) {
    // Check if JSON output is requested before displaying banner
    bool structured_output = is_structured_output_requested(argc, argv);
    // JSON and CSV are both machine-consumed, so emit enough digits to
    // round-trip a double exactly. The default stream precision is 6
    // significant figures, which silently discarded information the tools had
    // already computed (the plain-text branches print 10) and capped how
    // tightly any regression harness could compare against a reference. CSV
    // was left at the default until it turned out wfes_single's --fundamental
    // branch already printed 17 while its other five modes printed 6.
    if (structured_output) std::cout << std::setprecision(std::numeric_limits<double>::max_digits10);
    
    args::ArgumentParser parser("WFES-SINGLE");
    setup_parser_params(parser);
    
    // Model type group - exactly one must be specified
    args::Group model_f(parser, "Model type - specify one", args::Group::Validators::Xor,
                        args::Options::Required);
    args::Flag absorption_f(model_f, "absorption",
                            "Both fixation and extinction states are absorbing", {"absorption"});
    args::Flag fixation_f(model_f, "fixation", "Only fixation state is absorbing", {"fixation"});
    args::Flag establishment_f(model_f, "establishment", "Calculate establishment properties",
                               {"establishment"});
    args::Flag fundamental_f(model_f, "fundamental",
                             "Calculate the entire fundamental matrix (slow)", {"fundamental"});
    args::Flag equilibrium_f(model_f, "equilibrium",
                             "Calculate the equilibrium distribution of allele states",
                             {"equilibrium"});
    args::Flag non_absorbing_f(model_f, "non-absorbing", "Build a non-absorbing WF matrix",
                               {"non-absorbing"});
    args::Flag allele_age_f(model_f, "allele-age", "Calculate age of an allele", {"allele-age"});
    
    // Required arguments
    args::ValueFlag<llong> population_size_f(parser, "int", "Size of the population",
                                             {'N', "pop-size"}, args::Options::Required);
    
    // Optional arguments
    args::ValueFlag<double> selection_coefficient_f(parser, "float", "Selection coefficient",
                                                    {'s', "selection"});
    args::ValueFlag<double> dominance_f(parser, "float", "Dominance coefficient",
                                        {'h', "dominance"});
    args::ValueFlag<double> backward_mutation_f(parser, "float", "Backward mutation rate",
                                                {'u', "backward-mu"});
    args::ValueFlag<double> forward_mutation_f(parser, "float", "Forward mutation rate",
                                               {'v', "forward-mu"});
    args::Flag no_recurrent_mutation_f(parser, "bool", "Exclude recurrent mutation",
                                       {'m', "no-recurrent-mu"});
    args::ValueFlag<double> alpha_f(parser, "float", "Tail truncation weight", {'a', "alpha"});
    args::ValueFlag<llong> block_size_f(parser, "int", "Block size", {'b', "block-size"});
    args::ValueFlag<llong> n_threads_f(parser, "int", "Number of threads", {'t', "num-threads"});
    args::ValueFlag<double> integration_cutoff_f(parser, "float",
                                                 "Starting number of copies integration cutoff",
                                                 {'c', "integration-cutoff"});
    args::ValueFlag<std::string> initial_distribution_csv_f(
        parser, "path", "Path to initial probability distribution CSV", {'i', "initial"});
    args::ValueFlag<llong> starting_copies_f(
        parser, "int", "Starting number of copies - no integration", {'p', "starting-copies"});
    args::ValueFlag<llong> observed_copies_f(
        parser, "int", "Observed number of copies (--allele-age only)", {'x', "observed-copies"});
    args::ValueFlag<llong> num_moments_f(parser, "int",
        "Number of allele-age moments to report (--allele-age only; default 2)",
        {"num-moments"});
    args::ValueFlag<double> odds_ratio_f(parser, "float", "Odds ratio (--establishment only)",
                                         {'k', "odds-ratio"});
    
    // Output options
    args::ValueFlag<std::string> output_Q_f(parser, "path", "Output Q matrix to file", {"output-Q"});
    args::ValueFlag<std::string> output_R_f(parser, "path", "Output R vectors to file", {"output-R"});
    args::ValueFlag<std::string> output_N_f(parser, "path", "Output N matrix to file", {"output-N"});
    args::ValueFlag<std::string> output_N_ext_f(
        parser, "path", "Output extinction-conditional sojourn to file", {"output-N-ext"});
    args::ValueFlag<std::string> output_N_fix_f(
        parser, "path", "Output fixation-conditional sojourn to file", {"output-N-fix"});
    args::ValueFlag<std::string> output_B_f(parser, "path", "Output B vectors to file", {"output-B"});
    args::ValueFlag<std::string> output_I_f(parser, "path", "Output Initial probability distribution",
                                       {"output-I"});
    args::ValueFlag<std::string> output_E_f(
        parser, "path", "Output Equilibrium frequencies to file (--equilibrium only)",
        {"output-E"});
    args::ValueFlag<std::string> output_V_f(
        parser, "path", "Output Variance time matrix to file (--fundamental only)", {"output-V"});
    
    args::Flag csv_f(parser, "csv", "Output results in CSV format", {"csv"});
    args::Flag json_f(parser, "json", "Output results in JSON format", {"json"});
    args::Flag force_f(parser, "force", "Do not perform parameter checks", {"force"});
    args::Flag verbose_f(parser, "verbose", "Verbose solver output", {"verbose"});
    args::ValueFlag<std::string> library_f(parser, "library", library_flag_help(), {'l', "library"});
    
    args::HelpFlag help_f(parser, "help", "Display this help menu", {"help"});
    
    // Parse arguments
    try {
        parser.ParseCLI(argc, argv);
        
        // Validate model type selection
        if (model_f.MatchedChildren() != 1) {
            throw args::Error("Error: You must specify exactly one model type (--absorption, --fixation, --establishment, etc.)\n       Use --help to see all available options");
        }
        
    } catch (args::Help &) {
        if (!structured_output) {
            wfes::banner::displayBanner("wfes_single");
        }
        // An explicit --help is a successful invocation: print the usage to
        // STDOUT and exit 0. This used to write to stderr and exit 1, which
        // makes `wfes_single --help` look like a crash to anything that checks
        // status -- packaging smoke tests, CI, `make check`, a shell `&&`
        // chain -- and puts the help text on the wrong stream for piping into
        // a pager or grep. A genuine PARSE ERROR still goes to stderr with a
        // nonzero exit; that is the args::Error branch below.
        std::cout << parser;
        exit(EXIT_SUCCESS);
    } catch (args::Error &e) {
        if (!structured_output) {
            wfes::banner::displayBanner("wfes_single");
        }
        std::cerr << e.what() << std::endl;
        std::cerr << parser;
        exit(EXIT_FAILURE);
    }
    
    // Display banner for successful parsing (unless JSON output is requested)
    if (!structured_output) {
        wfes::banner::displayBanner("wfes_single");
    }
    
    // Build options struct
    CommandLineOptions options;
    
    // Determine model type
    if (absorption_f) {
        options.model_type = ModelType::ABSORPTION;
    } else if (fixation_f) {
        options.model_type = ModelType::FIXATION;
    } else if (establishment_f) {
        options.model_type = ModelType::ESTABLISHMENT;
    } else if (fundamental_f) {
        options.model_type = ModelType::FUNDAMENTAL;
    } else if (equilibrium_f) {
        options.model_type = ModelType::EQUILIBRIUM;
    } else if (non_absorbing_f) {
        options.model_type = ModelType::NON_ABSORBING;
    } else if (allele_age_f) {
        options.model_type = ModelType::ALLELE_AGE;
    }
    
    // Required parameters
    options.population_size = args::get(population_size_f);
    
    // Optional parameters with defaults
    options.selection_coefficient = selection_coefficient_f ? args::get(selection_coefficient_f) : 0.0;
    options.dominance = dominance_f ? args::get(dominance_f) : 0.5;
    options.backward_mutation = backward_mutation_f ? args::get(backward_mutation_f) : 1e-9;
    options.forward_mutation = forward_mutation_f ? args::get(forward_mutation_f) : 1e-9;
    options.recurrent_mutation = !no_recurrent_mutation_f; // Note: inverted logic
    options.alpha = alpha_f ? args::get(alpha_f) : 1e-20;
    options.block_size = block_size_f ? args::get(block_size_f) : 100;
    options.n_threads = n_threads_f ? args::get(n_threads_f) : 1;
    options.integration_cutoff = integration_cutoff_f ? args::get(integration_cutoff_f) : DEFAULT_INTEGRATION_CUTOFF;
    
    // Starting copies (-p): the user supplies a copy COUNT; the transient-state
    // index it maps to depends on the model's state space.
    //
    //   FIXATION mode keeps count 0 as a TRANSIENT state (recurrent mutation can
    //   re-introduce the allele), so transient index == count and -p 0 is the
    //   natural request: the full substitution time, mutational origination
    //   included. Valid counts are 0..2N-1.
    //
    //   The both-absorbing-style modes (absorption, establishment, allele-age)
    //   drop the absorbing count-0 column, so transient index == count - 1 and
    //   valid counts are 1..2N-1; -p 0 would start in an absorbing state and is
    //   rejected with an error.
    //
    // Integration over the mutational injection distribution is requested by
    // OMITTING -p; the sentinel is flag PRESENCE. The previous code stored
    // (p - 1) unconditionally, with -1 doubling as the "no flag" sentinel. That
    // (a) silently aliased "-p 0" to integration mode, and (b) shifted every
    // fixation-mode request by one count (-p 1 computed count 0). Both were
    // verified against an independent dense reference and the first-step
    // identity T_fix(0) = 1/(1-P00) + T_fix^integrated before this change.
    // These range checks are deliberately NOT bypassable by --force: an
    // out-of-range state index is a hard indexing error, not a judgement call.
    if (starting_copies_f) {
        llong p_count = args::get(starting_copies_f);
        llong max_count = 2 * options.population_size - 1;
        if (options.model_type == ModelType::FIXATION) {
            if (p_count < 0 || p_count > max_count) {
                throw std::runtime_error(
                    "Starting copies (-p) must be between 0 and 2N-1 = " +
                    std::to_string(max_count) +
                    " for --fixation (count 0 is a transient state in this model)");
            }
            options.starting_copies = p_count; // index == count
        } else {
            if (p_count == 0) {
                throw std::runtime_error(
                    "-p 0 is not valid for this model: 0 copies is an absorbing "
                    "state. Omit -p to integrate over the mutational injection "
                    "distribution instead");
            }
            if (p_count < 0 || p_count > max_count) {
                throw std::runtime_error(
                    "Starting copies (-p) must be between 1 and 2N-1 = " +
                    std::to_string(max_count) + " for this model");
            }
            options.starting_copies = p_count - 1; // index == count - 1
        }
    } else {
        options.starting_copies = -1; // no -p given: integrate over starting copies
    }
    
    // Observed copies (-x), for --allele-age: the user supplies a copy COUNT and
    // the stored value is the transient-state INDEX the allele-age branch feeds
    // straight to Eigen.
    //
    // --allele-age builds WF::BOTH_ABSORBING, which drops allele counts 0 and 2N
    // from the matrix ("Do not include 0th and Nx2th row and column",
    // wrightFisher.cpp). What is left is 2N-1 transient states, indices 0..2N-2,
    // for the segregating counts 1..2N-1 -- and wfes_single_main.cpp computes
    // exactly that: `size = 2N - 1`, then uses x as a column index into Q and as
    // a subscript of M1. So counts 1..2N-1 are the valid -x values, no more and
    // no less.
    //
    // The old code stored (x - 1) with no bounds check and let 0 double as "flag
    // not supplied". Two separate failures came out of that, both verified:
    //   * `-x 1` -- one observed copy, the commonest allele-age query -- landed
    //     on the sentinel and was reported as "--observed-copies parameter
    //     required", which describes a different problem than the user has;
    //   * `-x 0`, `-x -1` and `-x >= 2N` indexed outside the vector. With Eigen's
    //     asserts live that is SIGABRT; under NDEBUG, which is how these binaries
    //     are built, the read walks off the end -- and it is not even repeatable,
    //     since the same `-x 100` run exited 0 with a fabricated number on one
    //     invocation and nonzero on the next.
    // -1 is now the documented "not supplied" sentinel; every supplied value is
    // in range by the time it is stored, so the two can no longer collide. Like
    // the -p checks above, this is NOT --force-bypassable: an out-of-range state
    // index is an indexing error, not a judgement call.
    if (observed_copies_f) {
        llong x_count = args::get(observed_copies_f);
        llong max_count = 2 * options.population_size - 1;
        if (x_count < 1 || x_count > max_count) {
            throw std::runtime_error(
                "Observed copies (-x/--observed-copies) must be between 1 and "
                "2N-1 = " + std::to_string(max_count) + ", got " +
                std::to_string(x_count) +
                ". The allele-age model's transient states are the segregating "
                "counts 1..2N-1; counts 0 and 2N are absorbing and have no age");
        }
        options.observed_copies = x_count - 1; // index == count - 1
    } else {
        options.observed_copies = -1; // no -x given
    }
    // Allele-age moments to report. 2 reproduces the historical output exactly;
    // each further moment costs one more back-substitution against the same
    // factorization. Capped at 10: the k-th raw moment of this long-tailed
    // distribution grows like age^k and double precision thins out well before
    // overflow.
    options.n_moments = num_moments_f ? args::get(num_moments_f) : 2;
    if (num_moments_f && (options.n_moments < 1 || options.n_moments > 10)) {
        throw std::runtime_error("--num-moments must be between 1 and 10");
    }
    
    // Odds ratio for establishment
    options.odds_ratio = odds_ratio_f ? args::get(odds_ratio_f) : 1.0;
    
    // Input/output paths
    options.initial_distribution_path = initial_distribution_csv_f ? 
        args::get(initial_distribution_csv_f) : "";
    options.output_Q_path = output_Q_f ? args::get(output_Q_f) : "";
    options.output_R_path = output_R_f ? args::get(output_R_f) : "";
    options.output_N_path = output_N_f ? args::get(output_N_f) : "";
    options.output_N_ext_path = output_N_ext_f ? args::get(output_N_ext_f) : "";
    options.output_N_fix_path = output_N_fix_f ? args::get(output_N_fix_f) : "";
    options.output_B_path = output_B_f ? args::get(output_B_f) : "";
    options.output_I_path = output_I_f ? args::get(output_I_f) : "";
    options.output_E_path = output_E_f ? args::get(output_E_f) : "";
    options.output_V_path = output_V_f ? args::get(output_V_f) : "";
    
    // Backend selection
    options.library = library_f ? args::get(library_f) : get_default_library();
    
    // Flags
    options.csv_output = csv_f;
    options.json_output = json_f;
    options.force = force_f;
    options.verbose = verbose_f;
    
    // Check that only one output format is specified
    if (options.csv_output && options.json_output) {
        throw std::runtime_error("Cannot specify both --csv and --json output formats");
    }
    
    // Validate parameters
    validate_wfes_single_parameters(options, options.force);
    
    return options;
}

void Args_Parser::validate_wfes_single_parameters(CommandLineOptions& options, bool force) {
    validate_library(options.library);
    validate_model_domain(options.population_size, options.selection_coefficient,
                          options.dominance, options.backward_mutation,
                          options.forward_mutation, options.alpha);
    if (!force) {
        validate_model_advisories(options.population_size,
                                  options.selection_coefficient,
                                  options.backward_mutation,
                                  options.forward_mutation);
        if (options.alpha > 1e-5) {
            throw std::runtime_error("Zero cutoff value is quite high. This might produce inaccurate "
                                     "results. Use --force to ignore");
        }
    }
}

CommandLineOptions Args_Parser::parse_wfes_switching_args(int argc, char const *argv[]) {
    // Check if JSON output is requested before displaying banner
    bool structured_output = is_structured_output_requested(argc, argv);
    // JSON and CSV are both machine-consumed, so emit enough digits to
    // round-trip a double exactly. The default stream precision is 6
    // significant figures, which silently discarded information the tools had
    // already computed (the plain-text branches print 10) and capped how
    // tightly any regression harness could compare against a reference. CSV
    // was left at the default until it turned out wfes_single's --fundamental
    // branch already printed 17 while its other five modes printed 6.
    if (structured_output) std::cout << std::setprecision(std::numeric_limits<double>::max_digits10);
    
    args::ArgumentParser parser("WFES-SWITCHING");
    setup_parser_params(parser);
    
    // Model type group - exactly one must be specified
    args::Group model_f(parser, "Model type - specify one", args::Group::Validators::Xor,
                        args::Options::Required);
    args::Flag absorption_f(model_f, "absorption", 
                            "Both fixation and extinction states are absorbing", {"absorption"});
    args::Flag fixation_f(model_f, "fixation", "Only fixation state is absorbing", {"fixation"});
    
    // Required arguments
    args::ValueFlag<std::string> population_sizes_f(parser, "int[k]", "Sizes of the populations", 
                                                    {'N', "pop-sizes"}, args::Options::Required);
    
    // Optional vector arguments
    args::ValueFlag<std::string> selection_coefficients_f(parser, "float[k]", "Selection coefficients", 
                                                          {'s', "selection"});
    args::ValueFlag<std::string> dominance_coefficients_f(parser, "float[k]", "Dominance coefficients", 
                                                          {'h', "dominance"});
    args::ValueFlag<std::string> backward_mutations_f(parser, "float[k]", "Backward mutation rates", 
                                                      {'u', "backward-mu"});
    args::ValueFlag<std::string> forward_mutations_f(parser, "float[k]", "Forward mutation rates", 
                                                     {'v', "forward-mu"});
    args::ValueFlag<std::string> starting_probabilities_f(parser, "float[k]", "Starting probabilities", 
                                                          {'p', "starting-prob"});
    args::ValueFlag<std::string> switching_matrix_f(parser, "float[k][k]", "Switching parameters over models", 
                                                    {'r', "switching"});
    
    // Single-value optional arguments
    args::ValueFlag<double> integration_cutoff_f(parser, "float", "Starting number of copies integration cutoff", 
                                                 {'c', "integration-cutoff"});
    args::ValueFlag<double> alpha_f(parser, "float", "Tail truncation weight", {'a', "alpha"});
    args::ValueFlag<std::string> initial_f(parser, "path",
        "Path to initial state distribution CSV (one probability per state)", {'i', "initial"});
    args::ValueFlag<llong> n_threads_f(parser, "int", "Number of threads", {'t', "num-threads"});

    // Output options
    args::ValueFlag<std::string> output_Q_f(parser, "path", "Output Q matrix to file", {"output-Q"});
    args::ValueFlag<std::string> output_R_f(parser, "path", "Output R vectors to file", {"output-R"});
    args::ValueFlag<std::string> output_N_f(parser, "path", "Output N matrix to file", {"output-N"});
    args::ValueFlag<std::string> output_B_f(parser, "path", "Output B vectors to file", {"output-B"});
    args::ValueFlag<std::string> output_N_ext_f(parser, "path", "Output extinction-conditional sojourn to file", {"output-N-ext"});
    args::ValueFlag<std::string> output_N_fix_f(parser, "path", "Output fixation-conditional sojourn to file", {"output-N-fix"});

    // Flags
    args::Flag csv_f(parser, "csv", "Output results in CSV format", {"csv"});
    args::Flag json_f(parser, "json", "Output results in JSON format", {"json"});
    args::Flag force_f(parser, "force", "Do not perform parameter checks", {"force"});
    args::Flag verbose_f(parser, "verbose", "Verbose solver output", {"verbose"});
    args::ValueFlag<std::string> library_f(parser, "library", library_flag_help(), {'l', "library"});
    args::HelpFlag help_f(parser, "help", "Display this help menu", {"help"});

    try {
        parser.ParseCLI(argc, argv);
    } catch (args::Help&) {
        if (!structured_output) {
            wfes::banner::displayBanner("wfes_switching");
        }
        // An explicit --help is a successful invocation: print the usage to
        // STDOUT and exit 0. This used to write to stderr and exit 1, which
        // makes `wfes_single --help` look like a crash to anything that checks
        // status -- packaging smoke tests, CI, `make check`, a shell `&&`
        // chain -- and puts the help text on the wrong stream for piping into
        // a pager or grep. A genuine PARSE ERROR still goes to stderr with a
        // nonzero exit; that is the args::Error branch below.
        std::cout << parser;
        exit(EXIT_SUCCESS);
    } catch (args::Error& e) {
        if (!structured_output) {
            wfes::banner::displayBanner("wfes_switching");
        }
        std::cerr << e.what() << std::endl;
        std::cerr << parser;
        exit(EXIT_FAILURE);
    }

    // Display banner for successful parsing (unless JSON output is requested)
    if (!structured_output) {
        wfes::banner::displayBanner("wfes_switching");
    }

    CommandLineOptions options;

    // Parse model type
    if (absorption_f) {
        options.model_type = ModelType::ABSORPTION;
    } else if (fixation_f) {
        options.model_type = ModelType::FIXATION;
    } else {
        throw std::runtime_error("Error: You must specify exactly one model type (--absorption or --fixation)\n       Use --help to see all available options");
    }

    // Required arguments
    options.population_sizes_str = args::get(population_sizes_f);

    // Optional vector arguments
    options.selection_coefficients_str = selection_coefficients_f ? args::get(selection_coefficients_f) : "";
    options.dominance_coefficients_str = dominance_coefficients_f ? args::get(dominance_coefficients_f) : "";
    options.backward_mutations_str = backward_mutations_f ? args::get(backward_mutations_f) : "";
    options.forward_mutations_str = forward_mutations_f ? args::get(forward_mutations_f) : "";
    options.starting_probabilities_str = starting_probabilities_f ? args::get(starting_probabilities_f) : "";
    options.switching_matrix_str = switching_matrix_f ? args::get(switching_matrix_f) : "";

    // Single-value arguments
    options.integration_cutoff = integration_cutoff_f ? args::get(integration_cutoff_f) : DEFAULT_INTEGRATION_CUTOFF;
    options.alpha = alpha_f ? args::get(alpha_f) : 1e-20;
    options.initial_distribution_path = initial_f ? args::get(initial_f) : "";
    options.num_threads = n_threads_f ? args::get(n_threads_f) : 1;

    // Output paths
    options.output_Q_path = output_Q_f ? args::get(output_Q_f) : "";
    options.output_R_path = output_R_f ? args::get(output_R_f) : "";
    options.output_N_path = output_N_f ? args::get(output_N_f) : "";
    options.output_B_path = output_B_f ? args::get(output_B_f) : "";
    options.output_N_ext_path = output_N_ext_f ? args::get(output_N_ext_f) : "";
    options.output_N_fix_path = output_N_fix_f ? args::get(output_N_fix_f) : "";

    // Flags
    options.csv_output = csv_f;
    options.json_output = json_f;
    options.force = force_f;
    options.verbose = verbose_f;
    options.library = library_f ? args::get(library_f) : get_default_library();

    // Validate parameters
    validate_wfes_switching_parameters(options, options.force);

    return options;
}

void Args_Parser::validate_wfes_switching_parameters(CommandLineOptions& options, bool force) {
    validate_library(options.library);
    // The hard N floor runs even under --force. wfes_switching_main.cpp calls
    // validate_model_domain_vectors once it has reconciled the vector lengths,
    // which catches the rest of the domain; this earlier pass exists so that
    // `-N 1,1` is refused by name rather than by an Eigen bounds assert (shipped
    // binary: exit 134) or, under NDEBUG, an out-of-bounds read that printed
    // T_uncond = 1.000000027 with exit 0.
    check_min_population_vector(options.population_sizes_str, "model");
    if (!force) {
        // Was a TODO stub that checked only alpha, so every parameter combination
        // wfes_single refuses ran here to a plausible-looking answer instead.
        advise_vector_tool(options, "model");
        if (options.alpha > 1e-5) {
            throw std::runtime_error("Zero cutoff value is quite high. This might produce inaccurate "
                                     "results. Use --force to ignore");
        }
    }
}

CommandLineOptions Args_Parser::parse_wfes_sequential_args(int argc, char const *argv[]) {
    args::ArgumentParser parser("WFES-SEQUENTIAL");
    setup_parser_params(parser);

    // wfes_sequential was the only tool of the eleven with no structured output
    // at all. Detected before parsing so the banner can be suppressed.
    bool structured_output = is_structured_output_requested(argc, argv);
    // JSON and CSV are both machine-consumed, so emit enough digits to
    // round-trip a double exactly. The default stream precision is 6
    // significant figures, which silently discarded information the tools had
    // already computed (the plain-text branches print 10) and capped how
    // tightly any regression harness could compare against a reference. CSV
    // was left at the default until it turned out wfes_single's --fundamental
    // branch already printed 17 while its other five modes printed 6.
    if (structured_output) std::cout << std::setprecision(std::numeric_limits<double>::max_digits10);
    
    // Required arguments
    args::ValueFlag<std::string> population_sizes_f(parser, "int[k]", "Sizes of the populations", 
                                                    {'N', "pop-sizes"}, args::Options::Required);
    args::ValueFlag<std::string> expected_times_f(parser, "float[k]", "Expected time spent in each model", 
                                                  {'t', "exp-time"}, args::Options::Required);
    
    // Optional vector arguments
    args::ValueFlag<std::string> selection_coefficients_f(parser, "float[k]", "Selection coefficients", 
                                                          {'s', "selection"});
    args::ValueFlag<std::string> dominance_coefficients_f(parser, "float[k]", "Dominance coefficients", 
                                                          {'h', "dominance"});
    args::ValueFlag<std::string> backward_mutations_f(parser, "float[k]", "Backward mutation rates", 
                                                      {'u', "backward-mu"});
    args::ValueFlag<std::string> forward_mutations_f(parser, "float[k]", "Forward mutation rates", 
                                                     {'v', "forward-mu"});
    args::ValueFlag<std::string> starting_probabilities_f(parser, "float[k]", "Starting probabilities", 
                                                          {'p', "starting-prob"});
    
    args::ValueFlag<llong> starting_copies_f(parser, "int",
        "Starting number of copies in the first epoch - no integration", {"starting-copies"});
    
    // Single-value optional arguments
    args::ValueFlag<double> integration_cutoff_f(parser, "float", "Starting number of copies integration cutoff", 
                                                 {'c', "integration-cutoff"});
    args::ValueFlag<double> alpha_f(parser, "float", "Tail truncation weight", {'a', "alpha"});
    args::ValueFlag<std::string> initial_f(parser, "path",
        "Path to initial state distribution CSV (one probability per state)", {'i', "initial"});
    args::ValueFlag<llong> n_threads_f(parser, "int", "Number of threads", {"num-threads"});

    // Output options
    args::ValueFlag<std::string> output_Q_f(parser, "path", "Output Q matrix to file", {"output-Q"});
    args::ValueFlag<std::string> output_R_f(parser, "path", "Output R vectors to file", {"output-R"});
    args::ValueFlag<std::string> output_N_f(parser, "path", "Output N matrix to file", {"output-N"});
    args::ValueFlag<std::string> output_B_f(parser, "path", "Output B vectors to file", {"output-B"});
    args::ValueFlag<std::string> output_N_ext_f(parser, "path", "Output extinction-conditional sojourn to file", {"output-N-ext"});
    args::ValueFlag<std::string> output_N_fix_f(parser, "path", "Output fixation-conditional sojourn to file", {"output-N-fix"});
    args::ValueFlag<std::string> output_N_tmo_f(parser, "path", "Output timeout-conditional sojourn to file", {"output-N-tmo"});

    // Flags
    args::Flag csv_f(parser, "csv", "Output results in CSV format", {"csv"});
    args::Flag json_f(parser, "json", "Output results in JSON format", {"json"});
    args::Flag force_f(parser, "force", "Do not perform parameter checks", {"force"});
    args::Flag verbose_f(parser, "verbose", "Verbose solver output", {"verbose"});
    args::ValueFlag<std::string> library_f(parser, "library", library_flag_help(), {'l', "library"});
    args::HelpFlag help_f(parser, "help", "Display this help menu", {"help"});

    try {
        parser.ParseCLI(argc, argv);
    } catch (args::Help&) {
        if (!structured_output) {
            wfes::banner::displayBanner("wfes_sequential");
        }
        // An explicit --help is a successful invocation: print the usage to
        // STDOUT and exit 0. This used to write to stderr and exit 1, which
        // makes `wfes_single --help` look like a crash to anything that checks
        // status -- packaging smoke tests, CI, `make check`, a shell `&&`
        // chain -- and puts the help text on the wrong stream for piping into
        // a pager or grep. A genuine PARSE ERROR still goes to stderr with a
        // nonzero exit; that is the args::Error branch below.
        std::cout << parser;
        exit(EXIT_SUCCESS);
    } catch (args::Error& e) {
        if (!structured_output) {
            wfes::banner::displayBanner("wfes_sequential");
        }
        std::cerr << e.what() << std::endl;
        std::cerr << parser;
        exit(EXIT_FAILURE);
    }

    // Display banner for successful parsing (unless structured output is
    // requested). wfes_sequential was the one tool of the eleven whose parse
    // function never called this, so it identified itself nowhere in its
    // output -- the plain-text run began straight at "N = [...]".
    if (!structured_output) {
        wfes::banner::displayBanner("wfes_sequential");
    }

    CommandLineOptions options;

    // Sequential model always uses absorption mode
    options.model_type = ModelType::ABSORPTION;

    // Required arguments
    options.population_sizes_str = args::get(population_sizes_f);
    options.expected_times_str = args::get(expected_times_f);

    // Optional vector arguments
    options.selection_coefficients_str = selection_coefficients_f ? args::get(selection_coefficients_f) : "";
    options.dominance_coefficients_str = dominance_coefficients_f ? args::get(dominance_coefficients_f) : "";
    options.backward_mutations_str = backward_mutations_f ? args::get(backward_mutations_f) : "";
    options.forward_mutations_str = forward_mutations_f ? args::get(forward_mutations_f) : "";
    options.starting_probabilities_str = starting_probabilities_f ? args::get(starting_probabilities_f) : "";
    // -1 marks "not given": the default remains the integration over the
    // mutation-injection distribution.
    options.starting_copies = starting_copies_f ? args::get(starting_copies_f) : -1;

    // Single-value arguments
    options.integration_cutoff = integration_cutoff_f ? args::get(integration_cutoff_f) : DEFAULT_INTEGRATION_CUTOFF;
    options.alpha = alpha_f ? args::get(alpha_f) : 1e-20;
    options.initial_distribution_path = initial_f ? args::get(initial_f) : "";
    options.num_threads = n_threads_f ? args::get(n_threads_f) : 1;

    // Output paths
    options.output_Q_path = output_Q_f ? args::get(output_Q_f) : "";
    options.output_R_path = output_R_f ? args::get(output_R_f) : "";
    options.output_N_path = output_N_f ? args::get(output_N_f) : "";
    options.output_B_path = output_B_f ? args::get(output_B_f) : "";
    options.output_N_ext_path = output_N_ext_f ? args::get(output_N_ext_f) : "";
    options.output_N_fix_path = output_N_fix_f ? args::get(output_N_fix_f) : "";
    // The comment that used to sit here said output_N_tmo_path "would need to be
    // added to types.h" -- it was already there (types.h:100). The result was
    // that --output-N-tmo parsed, was discarded, and wrote nothing with exit 0.
    options.output_N_tmo_path = output_N_tmo_f ? args::get(output_N_tmo_f) : "";

    // Flags
    options.csv_output = csv_f;
    options.json_output = json_f;
    options.force = force_f;
    options.verbose = verbose_f;
    options.library = library_f ? args::get(library_f) : get_default_library();

    // Validate parameters
    validate_wfes_sequential_parameters(options, options.force);

    return options;
}

void Args_Parser::validate_wfes_sequential_parameters(CommandLineOptions& options, bool force) {
    validate_library(options.library);
    // Not bypassable; see the note in validate_wfes_switching_parameters.
    check_min_population_vector(options.population_sizes_str, "epoch");
    if (!force) {
        // Was a TODO stub that checked only alpha.
        advise_vector_tool(options, "epoch");
        if (options.alpha > 1e-5) {
            throw std::runtime_error("Zero cutoff value is quite high. This might produce inaccurate "
                                     "results. Use --force to ignore");
        }
    }
}

CommandLineOptions Args_Parser::parse_time_dist_args(int argc, char const *argv[]) {
    // Check if JSON output is requested before displaying banner
    bool structured_output = is_structured_output_requested(argc, argv);
    // JSON and CSV are both machine-consumed, so emit enough digits to
    // round-trip a double exactly. The default stream precision is 6
    // significant figures, which silently discarded information the tools had
    // already computed (the plain-text branches print 10) and capped how
    // tightly any regression harness could compare against a reference. CSV
    // was left at the default until it turned out wfes_single's --fundamental
    // branch already printed 17 while its other five modes printed 6.
    if (structured_output) std::cout << std::setprecision(std::numeric_limits<double>::max_digits10);
    
    args::ArgumentParser parser("TIME-DIST");
    setup_parser_params(parser);
    
    // Required arguments
    args::ValueFlag<llong> population_size_f(parser, "int", "Size of the population", 
                                             {'N', "pop-size"}, args::Options::Required);
    
    // Optional arguments
    args::ValueFlag<double> selection_coefficient_f(parser, "float", "Selection coefficient", 
                                                    {'s', "selection"});
    args::ValueFlag<double> dominance_f(parser, "float", "Dominance coefficient", 
                                        {'h', "dominance"});
    args::ValueFlag<double> backward_mutation_f(parser, "float", "Backward mutation rate", 
                                                {'u', "backward-mu"});
    args::ValueFlag<double> forward_mutation_f(parser, "float", "Forward mutation rate", 
                                               {'v', "forward-mu"});
    args::ValueFlag<double> alpha_f(parser, "float", "Tail truncation weight", {'a', "alpha"});
    args::ValueFlag<std::string> initial_f(parser, "path",
        "Path to initial state distribution CSV (one probability per state)", {'i', "initial"});
    args::ValueFlag<llong> block_size_f(parser, "int", "Block size", {'b', "block-size"});
    args::ValueFlag<llong> n_threads_f(parser, "int", "Number of threads", {'t', "num-threads"});
    args::ValueFlag<double> integration_cutoff_f(parser, "float", "Stop once this probability mass is reached", 
                                                 {'c', "integration-cutoff"});
    args::ValueFlag<double> distribution_cutoff_f(parser, "float", "Stop once this probability mass is reached", 
                                                  {'d', "distribution-cutoff"});
    args::ValueFlag<llong> max_t_f(parser, "int", "Maximum number of generations", {'m', "max-t"});
    args::Flag no_recurrent_mutation_f(parser, "bool", "Exclude recurrent mutation", 
                                       {'r', "no-recurrent-mu"});
    
    // Output options
    args::ValueFlag<std::string> output_Q_f(parser, "path", "Output Q matrix to file", {"output-Q"});
    args::ValueFlag<std::string> output_R_f(parser, "path", "Output R vectors to file", {"output-R"});
    args::ValueFlag<std::string> output_P_f(parser, "path", "Output phase-type distribution", {"output-P"});
    
    // Flags
    args::Flag csv_f(parser, "csv", "Output results in CSV format", {"csv"});
    args::Flag json_f(parser, "json", "Output results in JSON format", {"json"});
    args::Flag verbose_f(parser, "verbose", "Verbose solver output", {"verbose"});
    args::ValueFlag<std::string> library_f(parser, "library", library_flag_help(), {'l', "library"});
    args::HelpFlag help_f(parser, "help", "Display this help menu", {"help"});

    try {
        parser.ParseCLI(argc, argv);
    } catch (args::Help&) {
        if (!structured_output) {
            wfes::banner::displayBanner("time_dist");
        }
        // An explicit --help is a successful invocation: print the usage to
        // STDOUT and exit 0. This used to write to stderr and exit 1, which
        // makes `wfes_single --help` look like a crash to anything that checks
        // status -- packaging smoke tests, CI, `make check`, a shell `&&`
        // chain -- and puts the help text on the wrong stream for piping into
        // a pager or grep. A genuine PARSE ERROR still goes to stderr with a
        // nonzero exit; that is the args::Error branch below.
        std::cout << parser;
        exit(EXIT_SUCCESS);
    } catch (args::Error& e) {
        if (!structured_output) {
            wfes::banner::displayBanner("time_dist");
        }
        std::cerr << e.what() << std::endl;
        std::cerr << parser;
        exit(EXIT_FAILURE);
    }

    // Display banner for successful parsing (unless JSON output is requested)
    if (!structured_output) {
        wfes::banner::displayBanner("time_dist");
    }

    CommandLineOptions options;

    // Time dist model always uses absorption mode
    options.model_type = ModelType::ABSORPTION;

    // Required arguments
    options.population_size = args::get(population_size_f);

    // Optional arguments
    options.selection_coefficient = selection_coefficient_f ? args::get(selection_coefficient_f) : 0.0;
    options.dominance = dominance_f ? args::get(dominance_f) : 0.5;
    options.backward_mutation = backward_mutation_f ? args::get(backward_mutation_f) : 1e-9;
    options.forward_mutation = forward_mutation_f ? args::get(forward_mutation_f) : 1e-9;
    options.alpha = alpha_f ? args::get(alpha_f) : 1e-20;
    options.initial_distribution_path = initial_f ? args::get(initial_f) : "";
    options.block_size = block_size_f ? args::get(block_size_f) : 100;
    options.n_threads = n_threads_f ? args::get(n_threads_f) : 1;
    // Handle both old and new parameter names for backward compatibility
    if (distribution_cutoff_f) {
        options.distribution_cutoff = args::get(distribution_cutoff_f);
    } else if (integration_cutoff_f) {
        options.distribution_cutoff = args::get(integration_cutoff_f);
        if (!options.json_output) {  // Only show warning if not in JSON mode
            std::cerr << "Warning: --integration-cutoff is deprecated for time_dist. Use --distribution-cutoff instead.\n";
        }
    } else {
        options.distribution_cutoff = 1 - 1e-8;
    }
    options.integration_cutoff = DEFAULT_INTEGRATION_CUTOFF; // Keep default for other uses
    options.max_t = max_t_f ? args::get(max_t_f) : 100000;
    options.recurrent_mutation = !no_recurrent_mutation_f; // Default: true, unless --no-recurrent-mu

    // Output paths
    options.output_Q_path = output_Q_f ? args::get(output_Q_f) : "";
    options.output_R_path = output_R_f ? args::get(output_R_f) : "";
    options.output_P_path = output_P_f ? args::get(output_P_f) : "";

    // Flags
    options.csv_output = csv_f;
    options.json_output = json_f;
    options.verbose = verbose_f;
    options.library = library_f ? args::get(library_f) : get_default_library();
    
    // Check that only one output format is specified
    if (options.csv_output && options.json_output) {
        throw std::runtime_error("Cannot specify both --csv and --json output formats");
    }

    // Validate parameters
    validate_time_dist_parameters(options, false); // time_dist doesn't have force flag

    return options;
}

void Args_Parser::validate_time_dist_parameters(CommandLineOptions& options, bool force) {
    validate_library(options.library);
    validate_model_domain(options.population_size, options.selection_coefficient,
                          options.dominance, options.backward_mutation,
                          options.forward_mutation, options.alpha);
    // Basic validation for time_dist parameters
    if (options.alpha > 1e-5) {
        throw std::runtime_error("Zero cutoff value is quite high. This might produce inaccurate "
                                 "results.");
    }
    if (options.max_t <= 0) {
        throw std::runtime_error("Maximum time must be positive.");
    }
    if (options.distribution_cutoff < 0 || options.distribution_cutoff > 1) {
        throw std::runtime_error("Distribution cutoff must be between 0 and 1.");
    }
}

CommandLineOptions Args_Parser::parse_time_dist_dual_args(int argc, char const *argv[]) {
    // Check if JSON output is requested before displaying banner
    bool structured_output = is_structured_output_requested(argc, argv);
    // JSON and CSV are both machine-consumed, so emit enough digits to
    // round-trip a double exactly. The default stream precision is 6
    // significant figures, which silently discarded information the tools had
    // already computed (the plain-text branches print 10) and capped how
    // tightly any regression harness could compare against a reference. CSV
    // was left at the default until it turned out wfes_single's --fundamental
    // branch already printed 17 while its other five modes printed 6.
    if (structured_output) std::cout << std::setprecision(std::numeric_limits<double>::max_digits10);
    
    args::ArgumentParser parser("TIME-DIST-DUAL");
    setup_parser_params(parser);
    
    // Required arguments
    args::ValueFlag<llong> population_size_f(parser, "int", "Size of the population", 
                                             {'N', "pop-size"}, args::Options::Required);
    
    // Optional arguments
    args::ValueFlag<double> selection_coefficient_f(parser, "float", "Selection coefficient", 
                                                    {'s', "selection"});
    args::ValueFlag<double> dominance_f(parser, "float", "Dominance coefficient", 
                                        {'h', "dominance"});
    args::ValueFlag<double> backward_mutation_f(parser, "float", "Backward mutation rate", 
                                                {'u', "backward-mu"});
    args::ValueFlag<double> forward_mutation_f(parser, "float", "Forward mutation rate", 
                                               {'v', "forward-mu"});
    args::ValueFlag<double> alpha_f(parser, "float", "Tail truncation weight", {'a', "alpha"});
    args::ValueFlag<std::string> initial_f(parser, "path",
        "Path to initial state distribution CSV (one probability per state)", {'i', "initial"});
    args::ValueFlag<llong> block_size_f(parser, "int", "Block size", {'b', "block-size"});
    args::ValueFlag<llong> n_threads_f(parser, "int", "Number of threads", {'t', "num-threads"});
    args::ValueFlag<double> integration_cutoff_f(parser, "float", "Stop once this probability mass is reached", 
                                                 {'c', "integration-cutoff"});
    args::ValueFlag<double> distribution_cutoff_f(parser, "float", "Stop once this probability mass is reached", 
                                                  {'d', "distribution-cutoff"});
    args::ValueFlag<llong> max_t_f(parser, "int", "Maximum number of generations", {'m', "max-t"});
    args::Flag no_recurrent_mutation_f(parser, "bool", "Exclude recurrent mutation", 
                                       {'r', "no-recurrent-mu"});
    
    // Output options
    args::ValueFlag<std::string> output_Q_f(parser, "path", "Output Q matrix to file", {"output-Q"});
    args::ValueFlag<std::string> output_R_f(parser, "path", "Output R vectors to file", {"output-R"});
    args::ValueFlag<std::string> output_P_f(parser, "path", "Output phase-type distribution", {"output-P"});
    
    // Flags
    args::Flag csv_f(parser, "csv", "Output results in CSV format", {"csv"});
    args::Flag json_f(parser, "json", "Output results in JSON format", {"json"});
    args::Flag verbose_f(parser, "verbose", "Verbose solver output", {"verbose"});
    args::ValueFlag<std::string> library_f(parser, "library", library_flag_help(), {'l', "library"});
    args::HelpFlag help_f(parser, "help", "Display this help menu", {"help"});

    try {
        parser.ParseCLI(argc, argv);
    } catch (args::Help&) {
        if (!structured_output) {
            wfes::banner::displayBanner("time_dist_dual");
        }
        // An explicit --help is a successful invocation: print the usage to
        // STDOUT and exit 0. This used to write to stderr and exit 1, which
        // makes `wfes_single --help` look like a crash to anything that checks
        // status -- packaging smoke tests, CI, `make check`, a shell `&&`
        // chain -- and puts the help text on the wrong stream for piping into
        // a pager or grep. A genuine PARSE ERROR still goes to stderr with a
        // nonzero exit; that is the args::Error branch below.
        std::cout << parser;
        exit(EXIT_SUCCESS);
    } catch (args::Error& e) {
        if (!structured_output) {
            wfes::banner::displayBanner("time_dist_dual");
        }
        std::cerr << e.what() << std::endl;
        std::cerr << parser;
        exit(EXIT_FAILURE);
    }

    // Display banner for successful parsing (unless JSON output is requested)
    if (!structured_output) {
        wfes::banner::displayBanner("time_dist_dual");
    }

    CommandLineOptions options;

    // Time dist dual model always uses absorption mode
    options.model_type = ModelType::ABSORPTION;

    // Required arguments
    options.population_size = args::get(population_size_f);

    // Optional arguments
    options.selection_coefficient = selection_coefficient_f ? args::get(selection_coefficient_f) : 0.0;
    options.dominance = dominance_f ? args::get(dominance_f) : 0.5;
    options.backward_mutation = backward_mutation_f ? args::get(backward_mutation_f) : 1e-9;
    options.forward_mutation = forward_mutation_f ? args::get(forward_mutation_f) : 1e-9;
    options.alpha = alpha_f ? args::get(alpha_f) : 1e-20;
    options.initial_distribution_path = initial_f ? args::get(initial_f) : "";
    options.block_size = block_size_f ? args::get(block_size_f) : 100;
    options.n_threads = n_threads_f ? args::get(n_threads_f) : 1;
    // Handle both old and new parameter names for backward compatibility
    if (distribution_cutoff_f) {
        options.distribution_cutoff = args::get(distribution_cutoff_f);
    } else if (integration_cutoff_f) {
        options.distribution_cutoff = args::get(integration_cutoff_f);
        if (!options.json_output) {  // Only show warning if not in JSON mode
            std::cerr << "Warning: --integration-cutoff is deprecated for time_dist_dual. Use --distribution-cutoff instead.\n";
        }
    } else {
        options.distribution_cutoff = 1 - 1e-8;
    }
    options.integration_cutoff = DEFAULT_INTEGRATION_CUTOFF; // Keep default for other uses
    options.max_t = max_t_f ? args::get(max_t_f) : 100000;
    options.recurrent_mutation = !no_recurrent_mutation_f; // Default: true, unless --no-recurrent-mu

    // Output paths
    options.output_Q_path = output_Q_f ? args::get(output_Q_f) : "";
    options.output_R_path = output_R_f ? args::get(output_R_f) : "";
    options.output_P_path = output_P_f ? args::get(output_P_f) : "";

    // Flags
    options.csv_output = csv_f;
    options.json_output = json_f;
    options.verbose = verbose_f;
    options.library = library_f ? args::get(library_f) : get_default_library();
    
    // Check that only one output format is specified
    if (options.csv_output && options.json_output) {
        throw std::runtime_error("Cannot specify both --csv and --json output formats");
    }

    // Validate parameters
    validate_time_dist_dual_parameters(options, false); // time_dist_dual doesn't have force flag

    return options;
}

void Args_Parser::validate_time_dist_dual_parameters(CommandLineOptions& options, bool force) {
    validate_library(options.library);
    validate_model_domain(options.population_size, options.selection_coefficient,
                          options.dominance, options.backward_mutation,
                          options.forward_mutation, options.alpha);
    // Same validation as regular time_dist
    if (options.alpha > 1e-5) {
        throw std::runtime_error("Zero cutoff value is quite high. This might produce inaccurate "
                                 "results.");
    }
    if (options.max_t <= 0) {
        throw std::runtime_error("Maximum time must be positive.");
    }
    if (options.distribution_cutoff < 0 || options.distribution_cutoff > 1) {
        throw std::runtime_error("Distribution cutoff must be between 0 and 1.");
    }
}

CommandLineOptions Args_Parser::parse_time_dist_sgv_args(int argc, char const *argv[]) {
    // Check if JSON output is requested before displaying banner
    bool structured_output = is_structured_output_requested(argc, argv);
    // JSON and CSV are both machine-consumed, so emit enough digits to
    // round-trip a double exactly. The default stream precision is 6
    // significant figures, which silently discarded information the tools had
    // already computed (the plain-text branches print 10) and capped how
    // tightly any regression harness could compare against a reference. CSV
    // was left at the default until it turned out wfes_single's --fundamental
    // branch already printed 17 while its other five modes printed 6.
    if (structured_output) std::cout << std::setprecision(std::numeric_limits<double>::max_digits10);
    
    args::ArgumentParser parser("TIME-DIST-SGV");
    setup_parser_params(parser);
    
    // Required arguments
    args::ValueFlag<llong> population_size_f(parser, "int", "Size of the population", 
                                             {'N', "pop-size"}, args::Options::Required);
    args::ValueFlag<double> lambda_f(parser, "float", "Transition probability", 
                                     {'l', "lambda"}, args::Options::Required);
    args::ValueFlag<std::string> selection_coefficients_f(parser, "float[k]", "Selection coefficients", 
                                                          {'s', "selection"}, args::Options::Required);
    
    // Optional vector arguments
    args::ValueFlag<std::string> dominance_coefficients_f(parser, "float[k]", "Dominance coefficients", 
                                                          {'h', "dominance"});
    args::ValueFlag<std::string> backward_mutations_f(parser, "float[k]", "Backward mutation rates", 
                                                      {'u', "backward-mu"});
    args::ValueFlag<std::string> forward_mutations_f(parser, "float[k]", "Forward mutation rates", 
                                                     {'v', "forward-mu"});
    
    // Optional arguments
    args::ValueFlag<double> alpha_f(parser, "float", "Tail truncation weight", {'a', "alpha"});
    args::ValueFlag<std::string> initial_f(parser, "path",
        "Path to initial state distribution CSV (one probability per state)", {'i', "initial"});
    args::ValueFlag<llong> block_size_f(parser, "int", "Block size", {'b', "block-size"});
    // "threads" stays as an alias: this tool shipped with it, but every other
    // tool says --num-threads, which is also wfes2's name.
    args::ValueFlag<llong> n_threads_f(parser, "int", "Number of threads", {'t', "num-threads", "threads"});
    args::ValueFlag<double> integration_cutoff_f(parser, "float", "Stop once this probability mass is reached", 
                                                 {'c', "integration-cutoff"});
    args::ValueFlag<double> distribution_cutoff_f(parser, "float", "Stop once this probability mass is reached", 
                                                  {'d', "distribution-cutoff"});
    args::ValueFlag<llong> max_t_f(parser, "int", "Maximum number of generations", {'m', "max-t"});
    args::Flag no_recurrent_mutation_f(parser, "bool", "Exclude recurrent mutation", 
                                       {'r', "no-recurrent-mu"});
    
    // Output options
    args::ValueFlag<std::string> output_Q_f(parser, "path", "Output Q matrix to file", {"output-Q"});
    args::ValueFlag<std::string> output_R_f(parser, "path", "Output R vectors to file", {"output-R"});
    args::ValueFlag<std::string> output_P_f(parser, "path", "Output phase-type distribution", {"output-P"});
    
    // Flags
    args::Flag csv_f(parser, "csv", "Output results in CSV format", {"csv"});
    args::Flag json_f(parser, "json", "Output results in JSON format", {"json"});
    args::Flag force_f(parser, "force", "Do not perform parameter checks", {"force"});
    args::Flag verbose_f(parser, "verbose", "Verbose solver output", {"verbose"});
    args::ValueFlag<std::string> library_f(parser, "library", library_flag_help(), {"library"});
    args::HelpFlag help_f(parser, "help", "Display this help menu", {"help"});

    try {
        parser.ParseCLI(argc, argv);
    } catch (args::Help&) {
        if (!structured_output) {
            wfes::banner::displayBanner("time_dist_sgv");
        }
        // An explicit --help is a successful invocation: print the usage to
        // STDOUT and exit 0. This used to write to stderr and exit 1, which
        // makes `wfes_single --help` look like a crash to anything that checks
        // status -- packaging smoke tests, CI, `make check`, a shell `&&`
        // chain -- and puts the help text on the wrong stream for piping into
        // a pager or grep. A genuine PARSE ERROR still goes to stderr with a
        // nonzero exit; that is the args::Error branch below.
        std::cout << parser;
        exit(EXIT_SUCCESS);
    } catch (args::Error& e) {
        if (!structured_output) {
            wfes::banner::displayBanner("time_dist_sgv");
        }
        std::cerr << e.what() << std::endl;
        std::cerr << parser;
        exit(EXIT_FAILURE);
    }
    
    // Display banner for successful parsing (unless JSON output is requested)
    if (!structured_output) {
        wfes::banner::displayBanner("time_dist_sgv");
    }

    CommandLineOptions options;

    // Time dist SGV model always uses fixation mode
    options.model_type = ModelType::FIXATION;

    // Required arguments
    options.population_size = args::get(population_size_f);
    options.lambda = args::get(lambda_f);
    options.selection_coefficients_str = args::get(selection_coefficients_f);

    // Optional vector arguments
    options.dominance_coefficients_str = dominance_coefficients_f ? args::get(dominance_coefficients_f) : "";
    options.backward_mutations_str = backward_mutations_f ? args::get(backward_mutations_f) : "";
    options.forward_mutations_str = forward_mutations_f ? args::get(forward_mutations_f) : "";

    // Optional arguments
    options.alpha = alpha_f ? args::get(alpha_f) : 1e-20;
    options.initial_distribution_path = initial_f ? args::get(initial_f) : "";
    options.block_size = block_size_f ? args::get(block_size_f) : 100;
    options.n_threads = n_threads_f ? args::get(n_threads_f) : 1;
    
    // Handle both integration_cutoff (deprecated) and distribution_cutoff
    if (distribution_cutoff_f) {
        options.distribution_cutoff = args::get(distribution_cutoff_f);
    } else if (integration_cutoff_f) {
        options.distribution_cutoff = args::get(integration_cutoff_f);
        if (!options.json_output) {  // Only show warning if not in JSON mode
            std::cerr << "Warning: --integration-cutoff is deprecated for time_dist_sgv. Use --distribution-cutoff instead.\n";
        }
    } else {
        options.distribution_cutoff = 1 - 1e-8;
    }
    options.integration_cutoff = DEFAULT_INTEGRATION_CUTOFF; // Keep default for other uses
    options.max_t = max_t_f ? args::get(max_t_f) : 100000;
    options.recurrent_mutation = !no_recurrent_mutation_f; // Default: true, unless --no-recurrent-mu

    // Output paths
    options.output_Q_path = output_Q_f ? args::get(output_Q_f) : "";
    options.output_R_path = output_R_f ? args::get(output_R_f) : "";
    options.output_P_path = output_P_f ? args::get(output_P_f) : "";

    // Flags
    options.force = force_f;
    options.verbose = verbose_f;
    options.csv_output = csv_f;
    options.json_output = json_f;
    options.library = library_f ? args::get(library_f) : get_default_library();

    // Validate parameters
    validate_time_dist_sgv_parameters(options, options.force);

    return options;
}

void Args_Parser::validate_time_dist_sgv_parameters(CommandLineOptions& options, bool force) {
    validate_library(options.library);
    validate_model_domain(options.population_size, options.selection_coefficient,
                          options.dominance, options.backward_mutation,
                          options.forward_mutation, options.alpha);
    if (!force) {
        if (options.alpha > 1e-5) {
            throw std::runtime_error("Zero cutoff value is quite high. This might produce inaccurate "
                                     "results. Use --force to ignore");
        }
        if (options.lambda < 0 || options.lambda > 1) {
            throw std::runtime_error("Lambda (transition probability) must be between 0 and 1. Use --force to ignore");
        }
    }
    if (options.max_t <= 0) {
        throw std::runtime_error("Maximum time must be positive.");
    }
    // This used to range-check integration_cutoff -- a value time_dist_sgv hard
    // codes to the shared default and never reads -- so -d, the flag the user
    // actually sets, went unvalidated. `-d 5` asks the run to stop once 5 units
    // of probability mass have accumulated, which never happens, so it ran to
    // the max_t ceiling and exited 0. The bound is (0, 1]: a cutoff of 0 is
    // already satisfied before the first generation and yields no distribution
    // at all, and no cutoff above 1 is reachable.
    if (!(options.distribution_cutoff > 0.0 && options.distribution_cutoff <= 1.0)) {
        throw std::runtime_error(
            "--distribution-cutoff (-d) must be greater than 0 and at most 1, got " +
            num_str(options.distribution_cutoff) +
            ". It is the cumulative probability mass at which the time "
            "distribution stops being accumulated");
    }
}

CommandLineOptions Args_Parser::parse_phase_type_dist_args(int argc, char const *argv[]) {
    args::ArgumentParser parser("PHASE-TYPE-DIST");
    setup_parser_params(parser);

    // Detected before parsing so the ASCII banner can be suppressed for
    // structured output. Without this the banner was written to stdout
    // unconditionally, ahead of any JSON/CSV, corrupting the stream for every
    // machine consumer (the GUI included). Every other parser already does this.
    bool structured_output = is_structured_output_requested(argc, argv);
    // JSON and CSV are both machine-consumed, so emit enough digits to
    // round-trip a double exactly. The default stream precision is 6
    // significant figures, which silently discarded information the tools had
    // already computed (the plain-text branches print 10) and capped how
    // tightly any regression harness could compare against a reference. CSV
    // was left at the default until it turned out wfes_single's --fundamental
    // branch already printed 17 while its other five modes printed 6.
    if (structured_output) std::cout << std::setprecision(std::numeric_limits<double>::max_digits10);
    
    // Required arguments
    args::ValueFlag<llong> population_size_f(parser, "int", "Size of the population", 
                                             {'N', "pop-size"}, args::Options::Required);
    
    // Optional arguments
    args::ValueFlag<double> selection_coefficient_f(parser, "float", "Selection coefficient", 
                                                    {'s', "selection"});
    args::ValueFlag<double> dominance_f(parser, "float", "Dominance coefficient", 
                                        {'h', "dominance"});
    args::ValueFlag<double> backward_mutation_f(parser, "float", "Backward mutation rate", 
                                                {'u', "backward-mu"});
    args::ValueFlag<double> forward_mutation_f(parser, "float", "Forward mutation rate", 
                                               {'v', "forward-mu"});
    args::ValueFlag<double> alpha_f(parser, "float", "Tail truncation weight", {'a', "alpha"});
    args::ValueFlag<std::string> initial_f(parser, "path",
        "Path to initial state distribution CSV (one probability per state)", {'i', "initial"});
    args::ValueFlag<llong> block_size_f(parser, "int", "Block size", {'b', "block-size"});
    args::ValueFlag<llong> n_threads_f(parser, "int", "Number of threads", {'t', "num-threads"});
    args::ValueFlag<double> integration_cutoff_f(parser, "float", "Stop once this probability mass is reached (deprecated, use --distribution-cutoff)", 
                                                 {'c', "integration-cutoff"});
    args::ValueFlag<double> distribution_cutoff_f(parser, "float", "Stop once this probability mass is reached", 
                                                  {'d', "distribution-cutoff"});
    args::ValueFlag<llong> max_t_f(parser, "int", "Maximum number of generations", {'m', "max-t"});
    args::Flag no_recurrent_mutation_f(parser, "bool", "Exclude recurrent mutation", 
                                       {'r', "no-recurrent-mu"});
    
    // Output options
    args::ValueFlag<std::string> output_P_f(parser, "path", "Output phase-type distribution", {"output-P"});
    // Q and R exist in these tools -- both build a WF::Matrix -- but the flags
    // were never declared, while the GUI's options drawer offered "Write Q" and
    // "Write R" and emitted them. Ticking either box made the run fail outright
    // with "Flag could not be matched: output-Q".
    args::ValueFlag<std::string> output_Q_f(parser, "path", "Output Q matrix to file", {"output-Q"});
    args::ValueFlag<std::string> output_R_f(parser, "path", "Output R vectors to file", {"output-R"});
    
    // Flags
    args::Flag csv_f(parser, "csv", "Output results in CSV format", {"csv"});
    args::Flag json_f(parser, "json", "Output results in JSON format", {"json"});
    args::Flag verbose_f(parser, "verbose", "Verbose solver output", {"verbose"});
    args::ValueFlag<std::string> library_f(parser, "library", library_flag_help(), {'l', "library"});
    args::HelpFlag help_f(parser, "help", "Display this help menu", {"help"});

    try {
        parser.ParseCLI(argc, argv);
    } catch (args::Help&) {
        if (!structured_output) {
            wfes::banner::displayBanner("phase_type_dist");
        }
        // An explicit --help is a successful invocation: print the usage to
        // STDOUT and exit 0. This used to write to stderr and exit 1, which
        // makes `wfes_single --help` look like a crash to anything that checks
        // status -- packaging smoke tests, CI, `make check`, a shell `&&`
        // chain -- and puts the help text on the wrong stream for piping into
        // a pager or grep. A genuine PARSE ERROR still goes to stderr with a
        // nonzero exit; that is the args::Error branch below.
        std::cout << parser;
        exit(EXIT_SUCCESS);
    } catch (args::Error& e) {
        if (!structured_output) {
            wfes::banner::displayBanner("phase_type_dist");
        }
        std::cerr << e.what() << std::endl;
        std::cerr << parser;
        exit(EXIT_FAILURE);
    }

    // Display banner for successful parsing
    if (!structured_output) {
            wfes::banner::displayBanner("phase_type_dist");
        }

    CommandLineOptions options;

    // Phase type dist model always uses fixation mode
    options.model_type = ModelType::FIXATION;

    // Required arguments
    options.population_size = args::get(population_size_f);

    // Optional arguments
    options.selection_coefficient = selection_coefficient_f ? args::get(selection_coefficient_f) : 0.0;
    options.dominance = dominance_f ? args::get(dominance_f) : 0.5;
    options.backward_mutation = backward_mutation_f ? args::get(backward_mutation_f) : 1e-9;
    options.forward_mutation = forward_mutation_f ? args::get(forward_mutation_f) : 1e-9;
    options.alpha = alpha_f ? args::get(alpha_f) : 1e-20;
    options.initial_distribution_path = initial_f ? args::get(initial_f) : "";
    options.block_size = block_size_f ? args::get(block_size_f) : 100;
    options.n_threads = n_threads_f ? args::get(n_threads_f) : 1;
    // Handle both old and new parameter names for backward compatibility
    if (distribution_cutoff_f) {
        options.distribution_cutoff = args::get(distribution_cutoff_f);
    } else if (integration_cutoff_f) {
        options.distribution_cutoff = args::get(integration_cutoff_f);
        if (!options.json_output) {  // Only show warning if not in JSON mode
            std::cerr << "Warning: --integration-cutoff is deprecated for phase_type_dist. Use --distribution-cutoff instead.\n";
        }
    } else {
        options.distribution_cutoff = 1 - 1e-8;
    }
    options.integration_cutoff = DEFAULT_INTEGRATION_CUTOFF; // Keep default for other uses
    options.max_t = max_t_f ? args::get(max_t_f) : 100000;
    options.recurrent_mutation = !no_recurrent_mutation_f; // Default: true, unless --no-recurrent-mu

    // Output paths
    options.output_P_path = output_P_f ? args::get(output_P_f) : "";
    options.output_Q_path = output_Q_f ? args::get(output_Q_f) : "";
    options.output_R_path = output_R_f ? args::get(output_R_f) : "";

    // Flags
    options.csv_output = csv_f;
    options.json_output = json_f;
    options.verbose = verbose_f;
    options.library = library_f ? args::get(library_f) : get_default_library();
    
    // Check that only one output format is specified
    if (options.csv_output && options.json_output) {
        throw std::runtime_error("Cannot specify both --csv and --json output formats");
    }

    // Validate parameters
    validate_phase_type_dist_parameters(options, false); // phase_type_dist doesn't have force flag

    return options;
}

void Args_Parser::validate_phase_type_dist_parameters(CommandLineOptions& options, bool force) {
    validate_library(options.library);
    validate_model_domain(options.population_size, options.selection_coefficient,
                          options.dominance, options.backward_mutation,
                          options.forward_mutation, options.alpha);
    // Same validation as regular time_dist
    if (options.alpha > 1e-5) {
        throw std::runtime_error("Zero cutoff value is quite high. This might produce inaccurate "
                                 "results.");
    }
    if (options.max_t <= 0) {
        throw std::runtime_error("Maximum time must be positive.");
    }
    if (options.distribution_cutoff < 0 || options.distribution_cutoff > 1) {
        throw std::runtime_error("Distribution cutoff must be between 0 and 1.");
    }
}

CommandLineOptions Args_Parser::parse_phase_type_moments_args(int argc, char const *argv[]) {
    // Check if JSON output is requested before displaying banner
    bool structured_output = is_structured_output_requested(argc, argv);
    // JSON and CSV are both machine-consumed, so emit enough digits to
    // round-trip a double exactly. The default stream precision is 6
    // significant figures, which silently discarded information the tools had
    // already computed (the plain-text branches print 10) and capped how
    // tightly any regression harness could compare against a reference. CSV
    // was left at the default until it turned out wfes_single's --fundamental
    // branch already printed 17 while its other five modes printed 6.
    if (structured_output) std::cout << std::setprecision(std::numeric_limits<double>::max_digits10);
    
    args::ArgumentParser parser("PHASE-TYPE-MOMENTS");
    setup_parser_params(parser);
    
    // Add tool description
    parser.helpParams.programName = "phase_type_moments";
    parser.helpParams.addDefault = true;
    parser.Prog("phase_type_moments - Calculate moments of absorption times for a fixation-only model");
    
    // Required arguments
    args::ValueFlag<llong> population_size_f(parser, "int", "Size of the population", 
                                             {'N', "pop-size"}, args::Options::Required);
    
    // Optional arguments
    args::ValueFlag<double> selection_coefficient_f(parser, "float", "Selection coefficient", 
                                                    {'s', "selection"});
    args::ValueFlag<double> dominance_f(parser, "float", "Dominance coefficient", 
                                        {'h', "dominance"});
    args::ValueFlag<double> backward_mutation_f(parser, "float", "Backward mutation rate", 
                                                {'u', "backward-mu"});
    args::ValueFlag<double> forward_mutation_f(parser, "float", "Forward mutation rate", 
                                              {'v', "forward-mu"});
    args::ValueFlag<double> alpha_f(parser, "float", "Tail truncation weight", 
                                    {'a', "alpha"});
    args::ValueFlag<std::string> initial_f(parser, "path",
        "Path to initial state distribution CSV (one probability per state)", {'i', "initial"});
    args::ValueFlag<llong> block_size_f(parser, "int", "Block size", 
                                         {'b', "block-size"});
    args::ValueFlag<llong> n_threads_f(parser, "int", "Number of threads", 
                                        {'t', "num-threads"});
    args::ValueFlag<llong> n_moments_f(parser, "int", "Number of moments to calculate", 
                                       {'k', "n-moments"});
    
    // Output options
    args::ValueFlag<std::string> output_N_f(parser, "path", "Output moments to file", 
                                            {"output-N"});
    // See the note in parse_phase_type_dist_args: the GUI emitted these two
    // flags for both phase-type tools, and neither declared them.
    args::ValueFlag<std::string> output_Q_f(parser, "path", "Output Q matrix to file", {"output-Q"});
    args::ValueFlag<std::string> output_R_f(parser, "path", "Output R vectors to file", {"output-R"});
    
    // Flags
    args::Flag csv_f(parser, "csv", "Output results in CSV format", {"csv"});
    args::Flag json_f(parser, "json", "Output results in JSON format", {"json"});
    args::Flag verbose_f(parser, "verbose", "Verbose solver output", {"verbose"});
    // validate_phase_type_moments_parameters has four "Use --force to override"
    // limits (N > 10000, alpha > 1e-5, n_moments > 100), but the flag was never
    // declared and the validator was called with a hardcoded false -- so those
    // limits were unbypassable and their own error messages pointed at a flag
    // that did not exist.
    args::Flag force_f(parser, "force", "Do not perform parameter checks", {"force"});
    // Every other tool that builds a Wright-Fisher matrix exposes this; here it
    // was hardcoded to "recurrent mutation on" in the main with no way to change it.
    args::Flag no_recurrent_mutation_f(parser, "bool", "Exclude recurrent mutation",
                                       {'m', "no-recurrent-mu"});
    args::ValueFlag<std::string> library_f(parser, "library", library_flag_help(), 
                                           {'l', "library"});
    args::HelpFlag help_f(parser, "help", "Display this help menu", {"help"});

    try {
        parser.ParseCLI(argc, argv);
    } catch (args::Help&) {
        if (!structured_output) {
            wfes::banner::displayBanner("phase_type_moments");
        }
        // An explicit --help is a successful invocation: print the usage to
        // STDOUT and exit 0. This used to write to stderr and exit 1, which
        // makes `wfes_single --help` look like a crash to anything that checks
        // status -- packaging smoke tests, CI, `make check`, a shell `&&`
        // chain -- and puts the help text on the wrong stream for piping into
        // a pager or grep. A genuine PARSE ERROR still goes to stderr with a
        // nonzero exit; that is the args::Error branch below.
        std::cout << parser;
        exit(EXIT_SUCCESS);
    } catch (args::Error& e) {
        if (!structured_output) {
            wfes::banner::displayBanner("phase_type_moments");
        }
        std::cerr << e.what() << std::endl;
        std::cerr << parser;
        exit(EXIT_FAILURE);
    }

    // Display banner for successful parsing (unless JSON output is requested)
    if (!structured_output) {
        wfes::banner::displayBanner("phase_type_moments");
    }

    CommandLineOptions options;

    // Phase type moments model always uses fixation mode
    options.model_type = ModelType::FIXATION;

    // Parse arguments
    options.population_size = args::get(population_size_f);
    options.selection_coefficient = selection_coefficient_f ? args::get(selection_coefficient_f) : 0.0;
    options.dominance = dominance_f ? args::get(dominance_f) : 0.5;
    options.backward_mutation = backward_mutation_f ? args::get(backward_mutation_f) : 1e-9;
    options.forward_mutation = forward_mutation_f ? args::get(forward_mutation_f) : 1e-9;
    options.alpha = alpha_f ? args::get(alpha_f) : 1e-20;
    options.initial_distribution_path = initial_f ? args::get(initial_f) : "";
    options.block_size = block_size_f ? args::get(block_size_f) : 100;
    options.n_threads = n_threads_f ? args::get(n_threads_f) : 1;
    options.n_moments = n_moments_f ? args::get(n_moments_f) : 20;

    // Output paths
    options.output_N_path = output_N_f ? args::get(output_N_f) : "";
    options.output_Q_path = output_Q_f ? args::get(output_Q_f) : "";
    options.output_R_path = output_R_f ? args::get(output_R_f) : "";

    // Flags
    options.csv_output = csv_f;
    options.json_output = json_f;
    options.verbose = verbose_f;
    options.force = force_f;
    options.recurrent_mutation = !no_recurrent_mutation_f; // inverted: default true
    options.library = library_f ? args::get(library_f) : get_default_library();
    
    // Check that only one output format is specified
    if (options.csv_output && options.json_output) {
        throw std::runtime_error("Cannot specify both --csv and --json output formats");
    }

    // Validate parameters
    validate_phase_type_moments_parameters(options, options.force);

    return options;
}

void Args_Parser::validate_phase_type_moments_parameters(CommandLineOptions& options, bool force) {
    validate_library(options.library);
    validate_model_domain(options.population_size, options.selection_coefficient,
                          options.dominance, options.backward_mutation,
                          options.forward_mutation, options.alpha);
    // Check population size
    if (options.population_size <= 0) {
        throw std::runtime_error("Population size must be positive.");
    }
    if (!force && options.population_size > 10000) {
        throw std::runtime_error("Population size is quite large. This might produce a huge Q matrix. "
                                 "Use --force to override.");
    }
    
    // Check mutation rates
    if (options.backward_mutation < 0 || options.backward_mutation > 1) {
        throw std::runtime_error("Backward mutation rate must be between 0 and 1.");
    }
    if (options.forward_mutation < 0 || options.forward_mutation > 1) {
        throw std::runtime_error("Forward mutation rate must be between 0 and 1.");
    }
    if (options.backward_mutation == 0 && options.forward_mutation == 0) {
        throw std::runtime_error("Both mutation rates cannot be zero for phase type moments.");
    }
    
    // Check alpha
    if (options.alpha <= 0 || options.alpha >= 1) {
        throw std::runtime_error("Alpha must be between 0 and 1 (exclusive).");
    }
    if (!force && options.alpha > 1e-5) {
        throw std::runtime_error("Zero cutoff value is quite high. This might produce inaccurate "
                                 "results. Use --force to override.");
    }
    
    // Check number of moments
    if (options.n_moments <= 0) {
        throw std::runtime_error("Number of moments must be positive.");
    }
    if (!force && options.n_moments > 100) {
        throw std::runtime_error("Number of moments is quite large. This might be computationally expensive. "
                                 "Use --force to override.");
    }
}

CommandLineOptions Args_Parser::parse_wfafs_stochastic_args(int argc, char const *argv[]) {
    // Check if JSON output is requested before displaying banner
    bool structured_output = is_structured_output_requested(argc, argv);
    // JSON and CSV are both machine-consumed, so emit enough digits to
    // round-trip a double exactly. The default stream precision is 6
    // significant figures, which silently discarded information the tools had
    // already computed (the plain-text branches print 10) and capped how
    // tightly any regression harness could compare against a reference. CSV
    // was left at the default until it turned out wfes_single's --fundamental
    // branch already printed 17 while its other five modes printed 6.
    if (structured_output) std::cout << std::setprecision(std::numeric_limits<double>::max_digits10);
    
    args::ArgumentParser parser("WFAFS-STOCHASTIC");
    setup_parser_params(parser);
    
    // Required arguments
    args::ValueFlag<std::string> population_sizes_f(parser, "int[k]", "Sizes of the populations", 
                                                   {'N', "pop-sizes"}, args::Options::Required);
    args::ValueFlag<std::string> generations_f(parser, "float[k]", "Expected number of generations spent in each model", 
                                              {'G', "generations"}, args::Options::Required);
    args::ValueFlag<std::string> factors_f(parser, "float[k]", "Matrix approximation factors", 
                                         {'f', "factor"}, args::Options::Required);
    
    // Optional vector arguments
    args::ValueFlag<std::string> selection_coefficients_f(parser, "float[k]", "Selection coefficients", 
                                                         {'s', "selection"});
    args::ValueFlag<std::string> dominance_coefficients_f(parser, "float[k]", "Dominance coefficients", 
                                                         {'h', "dominance"});
    args::ValueFlag<std::string> backward_mutations_f(parser, "float[k]", "Backward mutation rates", 
                                                     {'u', "backward-mu"});
    args::ValueFlag<std::string> forward_mutations_f(parser, "float[k]", "Forward mutation rates", 
                                                    {'v', "forward-mu"});
    
    // Single-value optional arguments
    args::ValueFlag<double> alpha_f(parser, "float", "Tail truncation weight", {'a', "alpha"});
    args::ValueFlag<llong> n_threads_f(parser, "int", "Number of threads", {'t', "num-threads"});
    args::ValueFlag<std::string> initial_f(parser, "path", "Path to initial probability distribution CSV", 
                                         {'i', "initial"});
    args::ValueFlag<llong> initial_count_f(parser, "int", "Initial allele count", {'p', "initial-count"});
    args::ValueFlag<double> integration_cutoff_f(parser, "float",
        "Starting number of copies integration cutoff", {'c', "integration-cutoff"});
    
    // Output options.
    //
    // Four of these name quantities this tool's model does not have:
    // wfafs_stochastic builds a NON_ABSORBING chain, so there is no R block and
    // no extinction-, fixation- or timeout-conditional sojourn time. The flags
    // stay declared on purpose -- wfafs_stochastic_main.cpp refuses them with an
    // explanation, which is a better answer than args' "Flag could not be
    // matched" -- but the help text must stop promising a file that will never
    // be written.
    const char* not_for_this_model =
        " -- NOT AVAILABLE for this tool: its model is non-absorbing, so this "
        "quantity does not exist";
    args::ValueFlag<std::string> output_Q_f(parser, "path", "Output Q matrix to file", {"output-Q"});
    args::ValueFlag<std::string> output_R_f(parser, "path",
        std::string("Output R vectors to file") + not_for_this_model, {"output-R"});
    args::ValueFlag<std::string> output_N_f(parser, "path", "Output N matrix to file", {"output-N"});
    args::ValueFlag<std::string> output_B_f(parser, "path", "Output B vectors to file", {"output-B"});
    args::ValueFlag<std::string> output_N_ext_f(parser, "path",
        std::string("Output extinction-conditional sojourn to file") + not_for_this_model,
        {"output-N-ext"});
    args::ValueFlag<std::string> output_N_fix_f(parser, "path",
        std::string("Output fixation-conditional sojourn to file") + not_for_this_model,
        {"output-N-fix"});
    args::ValueFlag<std::string> output_N_tmo_f(parser, "path",
        std::string("Output timeout-conditional sojourn to file") + not_for_this_model,
        {"output-N-tmo"});

    // Flags
    args::Flag csv_f(parser, "csv", "Output results in CSV format", {"csv"});
    args::Flag json_f(parser, "json", "Output results in JSON format", {"json"});
    args::Flag force_f(parser, "force", "Do not perform parameter checks", {"force"});
    args::Flag no_project_f(parser, "no-project", "Do not project the distribution down", {"no-project"});
    args::Flag verbose_f(parser, "verbose", "Verbose solver output", {"verbose"});
    args::ValueFlag<std::string> library_f(parser, "library", library_flag_help(), 
                                          {'l', "library"});
    args::HelpFlag help_f(parser, "help", "Display this help menu", {"help"});
    
    try {
        parser.ParseCLI(argc, argv);
    } catch (args::Help&) {
        if (!structured_output) {
            wfes::banner::displayBanner("wfafs_stochastic");
        }
        // An explicit --help is a successful invocation: print the usage to
        // STDOUT and exit 0. This used to write to stderr and exit 1, which
        // makes `wfes_single --help` look like a crash to anything that checks
        // status -- packaging smoke tests, CI, `make check`, a shell `&&`
        // chain -- and puts the help text on the wrong stream for piping into
        // a pager or grep. A genuine PARSE ERROR still goes to stderr with a
        // nonzero exit; that is the args::Error branch below.
        std::cout << parser;
        exit(EXIT_SUCCESS);
    } catch (args::Error& e) {
        if (!structured_output) {
            wfes::banner::displayBanner("wfafs_stochastic");
        }
        std::cerr << e.what() << std::endl;
        std::cerr << parser;
        exit(EXIT_FAILURE);
    }
    
    // Display banner for successful parsing (unless JSON output is requested)
    if (!structured_output) {
        wfes::banner::displayBanner("wfafs_stochastic");
    }
    
    CommandLineOptions options;
    
    // Required arguments
    options.population_sizes_str = args::get(population_sizes_f);
    options.generations_str = args::get(generations_f);
    options.factors_str = args::get(factors_f);
    
    // Optional vector arguments
    options.selection_coefficients_str = selection_coefficients_f ? args::get(selection_coefficients_f) : "";
    options.dominance_coefficients_str = dominance_coefficients_f ? args::get(dominance_coefficients_f) : "";
    options.backward_mutations_str = backward_mutations_f ? args::get(backward_mutations_f) : "";
    options.forward_mutations_str = forward_mutations_f ? args::get(forward_mutations_f) : "";
    
    // Single-value arguments
    options.alpha = alpha_f ? args::get(alpha_f) : 1e-20;
    options.num_threads = n_threads_f ? args::get(n_threads_f) : 1;
    options.initial_distribution_path = initial_f ? args::get(initial_f) : "";
    options.initial_count = initial_count_f ? args::get(initial_count_f) : -1;
    // -1 marks "not requested": DEFAULT_INTEGRATION_CUTOFF would make the
    // injection distribution the silent default here, displacing the
    // equilibrium start this tool has always used when no flag is given.
    options.integration_cutoff = integration_cutoff_f ? args::get(integration_cutoff_f) : -1.0;
    
    // Output paths
    options.output_Q_path = output_Q_f ? args::get(output_Q_f) : "";
    options.output_R_path = output_R_f ? args::get(output_R_f) : "";
    options.output_N_path = output_N_f ? args::get(output_N_f) : "";
    options.output_B_path = output_B_f ? args::get(output_B_f) : "";
    options.output_N_ext_path = output_N_ext_f ? args::get(output_N_ext_f) : "";
    options.output_N_fix_path = output_N_fix_f ? args::get(output_N_fix_f) : "";
    options.output_N_tmo_path = output_N_tmo_f ? args::get(output_N_tmo_f) : "";
    
    // Flags
    options.csv_output = csv_f;
    options.json_output = json_f;
    options.force = force_f;
    options.no_project = no_project_f;
    options.verbose = verbose_f;
    options.library = library_f ? args::get(library_f) : get_default_library();
    
    // Check that only one output format is specified
    if (options.csv_output && options.json_output) {
        throw std::runtime_error("Cannot specify both --csv and --json output formats");
    }
    
    // Validate parameters
    validate_wfafs_stochastic_parameters(options, options.force);
    
    return options;
}

void Args_Parser::validate_wfafs_stochastic_parameters(CommandLineOptions& options, bool force) {
    validate_library(options.library);
    // Basic validation of required parameters
    if (options.population_sizes_str.empty()) {
        throw std::runtime_error("Population sizes must be provided");
    }
    // The N floor is deliberately NOT pre-checked here, unlike wfes_switching
    // and wfes_sequential. This tool divides each N by its -f factor before
    // building anything, so the population the model actually uses is N/f;
    // wfafs_stochastic_main.cpp runs validate_model_domain_vectors on those
    // rescaled values, which catches both `-N 1` and the `-N 10 -f 10` that a
    // check on the typed value would miss -- and, equally, does not refuse an
    // `-N 1 -f 0.5` whose rescaled model is perfectly well defined.
    if (options.generations_str.empty()) {
        throw std::runtime_error("Generations must be provided");
    }
    if (options.factors_str.empty()) {
        throw std::runtime_error("Factors must be provided");
    }
    
    // Check alpha
    if (options.alpha <= 0 || options.alpha >= 1) {
        throw std::runtime_error("Alpha must be between 0 and 1 (exclusive)");
    }
    if (!force) {
        // The same Wright-Fisher advisories the single-model tools apply, per
        // model, on the -f-rescaled parameters this tool actually solves with.
        // Verified to reproduce here: `-u 0.5,0.5` completes and prints a full
        // spectrum from a model whose assumptions are violated.
        advise_vector_tool(options, "model", options.factors_str);
        if (options.alpha > 1e-5) {
            throw std::runtime_error("Zero cutoff value is quite high. This might produce inaccurate results. "
                                     "Use --force to override");
        }
    }
    
    // Check thread count
    if (options.num_threads <= 0) {
        throw std::runtime_error("Number of threads must be positive");
    }
}

} // namespace cli
} // namespace wfes