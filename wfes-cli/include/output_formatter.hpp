#pragma once

#include <string>
#include "types.h"

namespace wfes {
namespace cli {

/**
 * @brief Enum for output format types
 */
enum class OutputFormat {
    PLAIN,
    CSV,
    JSON
};

/**
 * @brief Class that handles formatting and outputting results for WFES tools
 */
class OutputFormatter {
public:
    /**
     * @brief Last line of defence: no non-finite value reaches a structured stream.
     *
     * The per-tool mains refuse before calling in here -- that is where the
     * refusal belongs, because only the main knows what the quantity meant and
     * what the user should change. This exists for the case a future code path
     * forgets to, and for the fields no main checks individually.
     *
     * Printing a bare nan or inf is not a smaller failure than crashing. It
     * produces INVALID JSON (neither token is a JSON number, so a strict parser
     * rejects the whole document), and in CSV it produces a value that a reader
     * will silently coerce -- jq turns `inf` into 1.7976931348623157e+308, an
     * ordinary-looking finite number that is not the answer to anything.
     *
     * Callers validate every value BEFORE the first character is written, so a
     * refusal never leaves a half-finished JSON object on stdout. The check is
     * about VALUES that arrive non-finite; fields the caller deliberately omits
     * stay simply absent, which is a different and legitimate thing.
     *
     * @param value the value about to be emitted
     * @param field the name it would have been emitted under
     * @return value, when it is finite
     * @throws std::runtime_error naming the field, otherwise
     */
    static double require_finite(double value, const char* field);

    /**
     * @brief require_finite over a whole vector, naming the offending index.
     */
    static void require_finite_all(const dvec& values, const char* field);

    // ----------------------------------------------------------------------
    // Solver-backend provenance (integrity audit section 2.3)
    //
    // The parameters block is the provenance record of a run: every value in
    // it has to be what the run actually used. --library was the one value
    // that was not. SolverFactory serves a "--library Accelerate" request with
    // SuiteSparse/UMFPACK whenever this build has SuiteSparse -- which is
    // every shipped macOS build, and, because the macOS default IS
    // "Accelerate", every macOS run that does not pass the flag at all. The
    // only disclosure was one --verbose text line in wfes_single's --fixation
    // branch; a --json or --csv record that echoed the request alone named a
    // backend that never executed.
    //
    // So both halves are published, always, side by side:
    //
    //     "library_requested": "Accelerate",
    //     "library_effective": "SuiteSparse",
    //
    // A run whose two values agree says so explicitly, which is what makes the
    // pair a record rather than a warning: absence of a substitution is now
    // stated, not inferred from silence.
    //
    // The effective name comes from SolverFactory::effectiveLibrary(), so the
    // substitution rule has exactly one home and no main re-derives it.
    // ----------------------------------------------------------------------

    /**
     * @brief The two provenance values for a run that asked for @p requested.
     *
     * `effective` is empty only when this build has no backend at all for the
     * request -- the cases SolverFactory::createSolver throws on, which
     * Args_Parser::validate_library() refuses long before any output is
     * formatted. The renderers below emit JSON `null` / an empty CSV field for
     * it rather than inventing a name.
     */
    struct LibraryProvenance {
        std::string requested;
        std::string effective;
    };
    static LibraryProvenance library_provenance(const std::string& requested);

    /**
     * @brief The provenance pair as two complete lines of a JSON parameters block.
     *
     * Returns, with @p indent in front of each line:
     *
     *     <indent>"library_requested": "Accelerate",\n
     *     <indent>"library_effective": "SuiteSparse",\n
     *
     * The pair goes FIRST in a parameters block -- every such block in the ten
     * tools that already had one has at least one field after it, so the
     * trailing comma is always right, and first-position gives the eleven
     * tools one consistent field order. Pass @p trailing_comma false for the
     * block that ends with this pair (see library_provenance_json_block).
     *
     * Returning a string rather than printing keeps the caller's option to
     * build it before the first character of the document is written, matching
     * the validate-then-emit convention the require_finite family follows.
     */
    static std::string library_provenance_json(const std::string& requested,
                                               const char* indent = "    ",
                                               bool trailing_comma = true);

    /**
     * @brief The whole `"parameters": { ... },` object, provenance only.
     *
     * For a tool whose JSON had no parameters block at all before this -- only
     * wfes_single, whose seven modes each publish a bare `results` object. The
     * block is emitted with the same two-space/four-space indentation every
     * other tool uses, and with a trailing comma, so it precedes `results`.
     */
    static std::string library_provenance_json_block(const std::string& requested,
                                                     const char* indent = "  ");

    /// The two CSV column headers, in the same order: "library_requested,library_effective".
    static const char* library_provenance_csv_header();

    /// The two CSV field values, in the same order. An unavailable backend
    /// leaves the second field empty rather than naming one that never ran.
    static std::string library_provenance_csv_values(const std::string& requested);

    /**
     * @brief Format and output results from wfes_single in fixation mode
     * 
     * @param options Command-line options used for the calculation
     * @param T_fix Time to fixation
     * @param T_std Standard deviation of fixation time
     * @param rate Fixation rate
     */
    static void print_fixation_results(const CommandLineOptions& options, double T_fix, double T_std, double rate);

    /**
     * @brief Format and output results from wfes_single in absorption mode
     * 
     * @param options Command-line options used for the calculation
     * @param P_ext Extinction probability
     * @param P_fix Fixation probability
     * @param T_abs Absorption time 
     * @param T_abs_std Standard deviation of absorption time
     * @param T_ext Conditional time to extinction
     * @param T_ext_std Standard deviation of extinction time
     * @param N_ext Mean copies in extinction trajectory
     * @param T_fix Conditional time to fixation
     * @param T_fix_std Standard deviation of fixation time
     */
    static void print_absorption_results(
        const CommandLineOptions& options,
        double P_ext, double P_fix,
        double T_abs, double T_abs_std,
        double T_ext, double T_ext_std, double N_ext,
        double T_fix, double T_fix_std
    );

    /**
     * @brief Format and output results from wfes_single in equilibrium mode
     * 
     * @param options Command-line options used for the calculation
     * @param e_freq Expected frequency
     */
    static void print_equilibrium_results(const CommandLineOptions& options, double e_freq);

    /**
     * @brief Format and output results from wfes_single in equilibrium mode with full distribution
     * 
     * @param options Command-line options used for the calculation
     * @param e_freq Expected frequency
     * @param distribution Full equilibrium distribution
     */
    static void print_equilibrium_results_with_distribution(
        const CommandLineOptions& options, double e_freq, const dvec& distribution);

    /**
     * @brief Format and output results from wfes_single in establishment mode
     * 
     * @param options Command-line options used for the calculation
     * @param est_freq Establishment frequency
     * @param P_est Establishment probability
     * @param T_seg Segregation time
     * @param T_seg_std Standard deviation of segregation time
     * @param T_seg_ext Conditional time to extinction after establishment
     * @param T_seg_ext_std Standard deviation of extinction time after establishment
     * @param T_seg_fix Conditional time to fixation after establishment
     * @param T_seg_fix_std Standard deviation of fixation time after establishment
     * @param T_est Time to establishment
     * @param T_est_std Standard deviation of establishment time
     */
    static void print_establishment_results(
        const CommandLineOptions& options,
        double est_freq, double P_est,
        double T_seg, double T_seg_std,
        double T_seg_ext, double T_seg_ext_std,
        double T_seg_fix, double T_seg_fix_std,
        double T_est, double T_est_std
    );

    /**
     * @brief Format and output results from wfes_single in allele age mode
     * 
     * @param options Command-line options used for the calculation
     * @param E_allele_age Expected allele age
     * @param S_allele_age Standard deviation of allele age
     */
    /**
     * @param raw_moments E[T^k] for k = 1..K when --num-moments K > 2 was
     *        given (the mixture over starting copies, when integrating);
     *        empty otherwise, and the historical two-value output is emitted
     *        unchanged.
     */
    static void print_allele_age_results(const CommandLineOptions& options, double E_allele_age, double S_allele_age,
                                         const std::vector<double>& raw_moments = {});

    /**
     * @brief Format and output results from wfes_single in fundamental mode
     * 
     * @param options Command-line options used for the calculation
     */
    /**
     * @param sojourn alpha^T N: expected generations in each transient state
     *                (allele counts 1..2N-1) for the starting distribution
     * @param T_abs   the sum of that vector, i.e. expected time to absorption
     */
    static void print_fundamental_results(const CommandLineOptions& options,
                                          const dvec& sojourn, double T_abs);

    /**
     * @brief Format and output results from wfes_single in non-absorbing mode
     * 
     * @param options Command-line options used for the calculation
     */
    static void print_non_absorbing_results(const CommandLineOptions& options);

    /**
     * @brief Write a matrix to a file
     *
     * Last line of defence, matching require_finite/require_finite_all: every
     * entry is checked before the first character is written, whether the
     * destination is a real file or the "stdout" pseudo-path. A non-finite
     * entry throws instead of landing on disk as a bare "nan"/"inf" token
     * that a downstream reader -- including this project's own GUI, which
     * stores several of these files with a .csv extension -- would silently
     * accept as text.
     *
     * @param matrix Matrix to write
     * @param file_path Path to output file
     * @throws std::runtime_error naming the file and the first non-finite
     *         entry, as [row,col]
     */
    static void write_matrix_to_file(const dmat& matrix, const std::string& file_path);

    /**
     * @brief Write a vector to a file
     *
     * Same non-finite refusal as write_matrix_to_file, above.
     *
     * @param vector Vector to write
     * @param file_path Path to output file
     * @throws std::runtime_error naming the file and the first non-finite
     *         entry's index
     */
    static void write_vector_to_file(const dvec& vector, const std::string& file_path);

    /**
     * @brief Format and output results from wfes_switching in absorption mode
     * 
     * @param options Command-line options used for the calculation
     * @param n_models Number of models
     * @param population_sizes Population sizes for each model
     * @param s Selection coefficients
     * @param h Dominance coefficients
     * @param u Backward mutation rates
     * @param v Forward mutation rates
     * @param p Starting probabilities. Meaningful only when p_used; when the
     *          caller's --initial (or any other rule) makes p dead input,
     *          pass p_used = false rather than a sanitised placeholder --
     *          the formatter itself never reads p in that case.
     * @param p_used Whether this run actually started from p (true), or
     *        from some other rule such as --initial that replaces it
     *        (false). Mirrors the caller's own
     *        options.initial_distribution_path.empty() condition -- the
     *        same one that gates normalisation of p before this call and
     *        that the FIXATION branch already uses for its own JSON/CSV
     *        output. When false, JSON records options.initial_distribution_path
     *        instead of starting_probabilities, and CSV leaves the p0/p1/...
     *        fields empty rather than printing whatever raw, unvalidated
     *        vector -p happened to hold.
     * @param P_ext Extinction probability
     * @param P_fix Fixation probability
     * @param T_ext Time to extinction
     * @param T_fix Time to fixation
     * @param P_cond_ext Conditional extinction probabilities
     * @param P_cond_fix Conditional fixation probabilities
     * @param T_uncond Unconditional sojourn times
     * @param T_cond_ext Conditional extinction times
     * @param T_cond_fix Conditional fixation times
     */
    static void print_switching_absorption_results(
        const CommandLineOptions& options,
        llong n_models,
        const dvec& population_sizes,
        const dvec& s,
        const dvec& h,
        const dvec& u,
        const dvec& v,
        const dvec& p,
        bool p_used,
        double P_ext, double P_fix,
        double T_ext, double T_fix,
        const dvec& P_cond_ext,
        const dvec& P_cond_fix,
        const dvec& T_uncond,
        const dvec& T_cond_ext,
        const dvec& T_cond_fix
    );

    /**
     * @brief Format and output results from wfafs_stochastic
     * 
     * @param options Command-line options used for the calculation
     * @param distribution The allele frequency distribution
     * @param n_models Number of models
     */
    static void print_wfafs_stochastic_results(
        const CommandLineOptions& options,
        const dvec& distribution,
        llong n_models
    );
};

} // namespace cli
} // namespace wfes