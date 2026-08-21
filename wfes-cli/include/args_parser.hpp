#pragma once

#include <string>
#include <vector>
#include "args.hpp"
#include "types.h"

namespace wfes {
namespace cli {

/**
 * @brief Class that handles command-line argument parsing for WFES tools
 */
class Args_Parser {
public:
    /**
     * @brief Default for -c/--integration-cutoff, shared so it cannot drift.
     *
     * wfes_switching's --fixation branch refuses any -c OTHER than the default,
     * because that model has no starting-copy distribution to truncate and a
     * value the tool cannot honour must not be silently ignored. That guard has
     * to compare against the same number the parser hands out; when the two
     * were separate literals, changing the default here would have turned every
     * default --fixation run into a refusal. One constant, both sites.
     */
    static constexpr double DEFAULT_INTEGRATION_CUTOFF = 1e-10;

    /**
     * @brief Smallest population size any of the tools can actually solve.
     *
     * N = 1 leaves a single transient state, and the starting-copies machinery
     * indexes past it: the shipped binaries abort on Eigen's bounds assert
     * (exit 134) for wfes_single, wfes_switching and wfes_sequential, and the
     * NDEBUG builds -- which is how these ship -- compile that assert out and
     * read off the end of the vector instead, printing whatever was in memory
     * with exit 0. Refused in validate_model_domain, so it is not bypassable
     * by --force: an out-of-range index is not a judgement call.
     */
    static constexpr llong MIN_POPULATION_SIZE = 2;

    /**
     * @brief Get platform-specific default library
     *
     * @return std::string Default library name (Accelerate on macOS, Pardiso elsewhere)
     */
    static std::string get_default_library();

    /**
     * @brief The solver backends THIS BUILD can actually construct.
     *
     * The single source of truth for every --library help string and for
     * validate_library. It is derived from the same WFES_USE_* macros the
     * factories switch on, so the advertised list and the accepted list cannot
     * disagree with what SolverFactory/SparseMatrixFactory will build.
     *
     * ViennaCL is deliberately absent: nothing defines WFES_USE_VIENNACL, so
     * every tool advertised a backend whose only possible outcome was
     * "ViennaCL solver not available. OpenCL support required."
     */
    static const std::vector<std::string>& supported_libraries();

    /**
     * @brief supported_libraries() as "A, B, or C" for humans.
     */
    static std::string supported_libraries_text();

    /**
     * @brief The --help blurb for -l/--library, built from supported_libraries().
     */
    static std::string library_flag_help();

    /**
     * @brief Refuse a --library value no factory in this build will accept.
     *
     * Both factories fall through an `else` branch to the platform default for
     * an unrecognised string. On a Linux/MKL build that means a typo'd
     * --library silently ran Pardiso and reported success; on macOS it surfaced
     * as "Cannot create empty sparse matrix with Accelerate", which names
     * neither the flag nor the mistake. Checked at parse time instead.
     */
    static void validate_library(const std::string& library);

    /**
     * @brief Set up common parameters for argument parsers
     * 
     * @param parser The parser to configure
     */
    static void setup_parser_params(args::ArgumentParser& parser);

    /**
     * @brief Check if JSON output is requested in command line arguments
     * 
     * @param argc Argument count
     * @param argv Argument values
     * @return true if --json flag is present
     */
    static bool is_json_requested(int argc, char const *argv[]);

    /**
     * @brief True when --json OR --csv is requested.
     *
     * Used to suppress the ASCII banner (and the "Program:" header
     * displayBanner prints with it) for BOTH structured formats, and to select
     * 17-significant-digit (round-trip) precision for BOTH.
     *
     * CSV used to be left at the stream default of 6 significant figures, on
     * the reasoning that raising it would change recorded outputs. It changed
     * them anyway, inconsistently: wfes_single's --fundamental branch printed
     * its CSV at 17 digits while its other five modes printed 6, so the same
     * tool disagreed with itself about how much of a computed double was worth
     * keeping. Six figures cannot be round-tripped back to the double that was
     * computed, which makes a CSV export lossy in a way a user cannot see. Both
     * structured formats now carry full precision; only the human-readable
     * plain-text branches remain deliberately short.
     */
    static bool is_structured_output_requested(int argc, char const *argv[]);

    /**
     * @brief Non-bypassable domain checks on one Wright-Fisher model's parameters.
     *
     * These are NOT the same thing as the per-tool `validate_*_parameters`
     * advisories, and they are deliberately not bypassable by `--force`. The
     * advisories say "this is a strange thing to ask for"; these say "the model
     * you asked for is not defined", which is not a judgement call.
     *
     * Every check here corresponds to a way the tools previously produced a
     * confident, well-formed, wrong answer:
     *
     *   N < 2         tripped a C assert deep in binom_row (SIGABRT, exit 134),
     *                 and that assert compiles out under NDEBUG, leaving an
     *                 out-of-bounds walk instead. See MIN_POPULATION_SIZE for
     *                 why the floor is 2 rather than 1.
     *   u,v < 0       made psi_diploid's (1-u) factor exceed 1, so the binomial
     *                 success probability could leave [0,1]. `-u -1e-9` returned
     *                 T_fix_std = 214.7 with exit 0 -- entirely plausible-looking
     *                 output from a model that does not exist.
     *   u,v >= 1      drives the same probability to <= 0.
     *   alpha < 0     a negative tail-truncation weight; accepted silently.
     *   1+s   < 0     psi_diploid clamps homozygote fitness with
     *   1+h*s < 0     fmax(w, 1e-30), silently substituting a different model
     *                 for the one requested rather than reporting the problem.
     *
     * Note what is deliberately NOT checked: h outside [0,1]. Overdominance and
     * underdominance are legitimate population-genetic models, and h only has to
     * keep 1+h*s non-negative, which is checked above. Large |h| producing a
     * large T_fix_std is an extreme answer, not an invalid one.
     *
     * @param where Optional context prefix for multi-model tools, e.g. "model 3"
     */
    static void validate_model_domain(llong N, double s, double h,
                                      double u, double v, double alpha,
                                      const std::string& where = "");

    /**
     * @brief Vector form of validate_model_domain for the multi-model tools.
     *
     * Sizes are assumed already reconciled by the caller (wfes_switching's
     * require_len, etc.); this validates element i of each against element i
     * of the others and labels failures with the model index.
     */
    static void validate_model_domain_vectors(const lvec& N, const dvec& s, const dvec& h,
                                              const dvec& u, const dvec& v, double alpha);

    /**
     * @brief The four --force-bypassable Wright-Fisher advisories, for ONE model.
     *
     * These are the judgement calls, as opposed to validate_model_domain's hard
     * domain errors: "you have asked for something outside the regime this
     * solver was designed for", not "the model you asked for does not exist".
     * Each throws with "Use --force to ignore", and every caller skips the whole
     * set when the user passed --force.
     *
     *   N > 500000            the matrix is large enough that the run is a
     *                         resource decision, not a modelling one.
     *   4N*max(u,v) > 1       past the diffusion regime the tools assume. This
     *                         does NOT crash: verified against both the shipped
     *                         binaries and a fresh build, `-u 0.5` completes and
     *                         prints finite, plausible numbers from a model
     *                         whose assumptions are violated -- which is exactly
     *                         why it needs to be said out loud rather than left
     *                         to the reader, and exactly why --force can carry
     *                         it through.
     *   2Ns <= -100           fixation may be numerically unreachable.
     *   alpha > 1e-5          the tail truncation is coarse enough to move the
     *                         answer.
     *
     * wfes_single had all four; wfes_switching and wfes_sequential had TODO
     * stubs that checked only alpha, and wfafs_stochastic only alpha and thread
     * count. The vector tools apply them per model/epoch, labelled with the
     * index, since one bad epoch out of five is otherwise invisible.
     *
     * @param where Optional context prefix, e.g. "model 3" / "epoch 2"
     */
    static void validate_model_advisories(llong N, double s, double u, double v,
                                          const std::string& where = "");

    /**
     * @brief Parse command-line arguments for the wfes_single tool
     * 
     * @param argc Argument count
     * @param argv Argument values
     * @return CommandLineOptions Struct containing parsed command-line options
     */
    static CommandLineOptions parse_wfes_single_args(int argc, char const *argv[]);

    /**
     * @brief Check parameter validity and enforce constraints
     * 
     * @param options Command-line options to validate
     * @param force Whether to force execution despite potential issues
     */
    static void validate_wfes_single_parameters(CommandLineOptions& options, bool force);

    // parse_wfes_sweep_args / validate_wfes_sweep_parameters were declared here
    // but defined nowhere: wfes_sweep builds its own args::ArgumentParser inside
    // wfes_sweep_main.cpp and never went through this class. Any caller that
    // took the declarations at face value would have failed to link.

    /**
     * @brief Parse command-line arguments for the wfes_switching tool
     * 
     * @param argc Argument count
     * @param argv Argument values
     * @return CommandLineOptions Struct containing parsed command-line options
     */
    static CommandLineOptions parse_wfes_switching_args(int argc, char const *argv[]);

    /**
     * @brief Check parameter validity and enforce constraints for wfes_switching
     * 
     * @param options Command-line options to validate
     * @param force Whether to force execution despite potential issues
     */
    static void validate_wfes_switching_parameters(CommandLineOptions& options, bool force);

    /**
     * @brief Parse command-line arguments for the wfes_sequential tool
     * 
     * @param argc Argument count
     * @param argv Argument values
     * @return CommandLineOptions Struct containing parsed command-line options
     */
    static CommandLineOptions parse_wfes_sequential_args(int argc, char const *argv[]);

    /**
     * @brief Check parameter validity and enforce constraints for wfes_sequential
     * 
     * @param options Command-line options to validate
     * @param force Whether to force execution despite potential issues
     */
    static void validate_wfes_sequential_parameters(CommandLineOptions& options, bool force);

    /**
     * @brief Parse command-line arguments for the time_dist tool
     * 
     * @param argc Argument count
     * @param argv Argument values
     * @return CommandLineOptions Struct containing parsed command-line options
     */
    static CommandLineOptions parse_time_dist_args(int argc, char const *argv[]);

    /**
     * @brief Check parameter validity and enforce constraints for time_dist
     * 
     * @param options Command-line options to validate
     * @param force Whether to force execution despite potential issues
     */
    static void validate_time_dist_parameters(CommandLineOptions& options, bool force);

    /**
     * @brief Parse command-line arguments for the time_dist_dual tool
     * 
     * @param argc Argument count
     * @param argv Argument values
     * @return CommandLineOptions Struct containing parsed command-line options
     */
    static CommandLineOptions parse_time_dist_dual_args(int argc, char const *argv[]);

    /**
     * @brief Check parameter validity and enforce constraints for time_dist_dual
     * 
     * @param options Command-line options to validate
     * @param force Whether to force execution despite potential issues
     */
    static void validate_time_dist_dual_parameters(CommandLineOptions& options, bool force);

    /**
     * @brief Parse command-line arguments for the time_dist_sgv tool
     * 
     * @param argc Argument count
     * @param argv Argument values
     * @return CommandLineOptions Struct containing parsed command-line options
     */
    static CommandLineOptions parse_time_dist_sgv_args(int argc, char const *argv[]);

    /**
     * @brief Check parameter validity and enforce constraints for time_dist_sgv
     * 
     * @param options Command-line options to validate
     * @param force Whether to force execution despite potential issues
     */
    static void validate_time_dist_sgv_parameters(CommandLineOptions& options, bool force);

    /**
     * @brief Parse command-line arguments for the phase_type_dist tool
     * 
     * @param argc Argument count
     * @param argv Argument values
     * @return CommandLineOptions Struct containing parsed command-line options
     */
    static CommandLineOptions parse_phase_type_dist_args(int argc, char const *argv[]);

    /**
     * @brief Check parameter validity and enforce constraints for phase_type_dist
     * 
     * @param options Command-line options to validate
     * @param force Whether to force execution despite potential issues
     */
    static void validate_phase_type_dist_parameters(CommandLineOptions& options, bool force);

    /**
     * @brief Parse command-line arguments for the phase_type_moments tool
     * 
     * @param argc Argument count
     * @param argv Argument values
     * @return CommandLineOptions Struct containing parsed command-line options
     */
    static CommandLineOptions parse_phase_type_moments_args(int argc, char const *argv[]);

    /**
     * @brief Check parameter validity and enforce constraints for phase_type_moments
     * 
     * @param options Command-line options to validate
     * @param force Whether to force execution despite potential issues
     */
    static void validate_phase_type_moments_parameters(CommandLineOptions& options, bool force);

    /**
     * @brief Parse command-line arguments for the wfafs_stochastic tool
     * 
     * @param argc Argument count
     * @param argv Argument values
     * @return CommandLineOptions Struct containing parsed command-line options
     */
    static CommandLineOptions parse_wfafs_stochastic_args(int argc, char const *argv[]);

    /**
     * @brief Check parameter validity and enforce constraints for wfafs_stochastic
     * 
     * @param options Command-line options to validate
     * @param force Whether to force execution despite potential issues
     */
    static void validate_wfafs_stochastic_parameters(CommandLineOptions& options, bool force);
};

} // namespace cli
} // namespace wfes