#pragma once

#include <string>
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
     * @brief Get platform-specific default library
     * 
     * @return std::string Default library name (Accelerate on macOS, Pardiso elsewhere)
     */
    static std::string get_default_library();

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
     * displayBanner prints with it) for BOTH structured formats.
     * is_json_requested stays separate because it also gates the
     * 17-significant-digit precision, which is a JSON-only behaviour;
     * changing CSV precision would change recorded outputs.
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
     *   N <= 0        tripped a C assert deep in binom_row (SIGABRT, exit 134),
     *                 and that assert compiles out under NDEBUG, leaving an
     *                 out-of-bounds walk instead.
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

    /**
     * @brief Parse command-line arguments for the wfes_sweep tool
     * 
     * @param argc Argument count
     * @param argv Argument values
     * @return SweepCommandLineOptions Struct containing parsed command-line options
     */
    static SweepCommandLineOptions parse_wfes_sweep_args(int argc, char const *argv[]);

    /**
     * @brief Check parameter validity and enforce constraints for wfes_sweep
     * 
     * @param options Command-line options to validate
     * @param force Whether to force execution despite potential issues
     */
    static void validate_wfes_sweep_parameters(SweepCommandLineOptions& options, bool force);

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