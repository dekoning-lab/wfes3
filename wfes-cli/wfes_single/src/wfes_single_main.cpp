#include <iostream>
#include <iomanip>
#include <string>
#include <vector>
#include <chrono>
#include <cstdlib>  // for setenv
#include <cmath>
#include <limits>
#include <optional>
#include <sstream>
#include <utility>
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

#include "types.h"

// Platform-agnostic constants for PARDISO. Typed constants guarded on
// WFES_USE_MKL, exactly as time_dist does it -- these must NOT be macros: as
// #defines they textually rewrote the `const llong MKL_PARDISO_MSG_VERBOSE`
// declarations in MKL_Consts.h, which only Linux includes, so this file
// compiled on macOS for months and failed on the first Linux build.
#ifndef WFES_USE_MKL
    constexpr llong MKL_PARDISO_MATRIX_TYPE_REAL_UNSYMMETRIC = 11;
    constexpr llong MKL_PARDISO_MSG_VERBOSE = 1;
    constexpr llong MKL_PARDISO_MSG_QUIET = 0;
#endif

// Include the CLI utilities
#include "args_parser.hpp"
#include "output_formatter.hpp"
#include "banner.h"

// Include the core library components
#include "types.h"
#include "wright_fisher.h"

// Include direct references to core library components with CLI adaptations
#include "model/wright-fisher/wrightFisher.h"
#include "model/sparse-matrix/sparseMatrixFactory.h"
#include "model/solver/solverFactory.h"

// For loading CSV files and utilities (CLI versions)
#include "initial_distribution.h"
#include "parsing.h"
#include "utils.h"

// Namespace aliases for shorter code
namespace CLI = wfes::cli;
using namespace wfes;

// ---------------------------------------------------------------------------
// Numerical-integrity policy (integrity audit, task CX1a).
//
// Governing principle: refuse, don't substitute. When a value cannot be
// computed correctly in double precision, this tool exits nonzero (or omits
// the field with a stderr diagnostic); it never prints a placeholder, a
// clamped lie, or the result of an unguarded division. Users put these
// numbers directly into published papers.
// ---------------------------------------------------------------------------
namespace {

// Boundary between floating-point roundoff and computation failure for an
// absorption probability. The B vectors come out of one sparse LU solve of
// (I - Q); the entrywise error of that solve is relative, of order
// cond(I - Q) * eps. Observed overshoot on representative problems is
// ~5e-11 (e.g. B_ext(0) = 1 + 3.4e-11 at N = 200). 1e-8 leaves more than
// two orders of headroom over that while still refusing anything that
// cannot plausibly be roundoff of a probability: a value outside [0,1] by
// more than 1e-8 means the solve lost at least half its digits, and nothing
// downstream of it could be trusted either.
constexpr double PROB_RANGE_TOL = 1e-8;

// Below this, a per-starting-state absorption probability can no longer
// anchor a conditional expectation in double precision. Every
// conditional-on-absorption moment divides by B(start): E[time at j | abs] =
// B(j) * N(start, j) / B(start). The solve is subtraction-free for these
// M-matrix systems, so B entries keep full RELATIVE accuracy down to the
// smallest positive normal double (DBL_MIN ~ 2.2e-308); below that the
// value degrades into the subnormal range (or underflows to 0) and the
// division turns roundoff into the entire answer. 1e-300 is DBL_MIN with
// ~8 orders of safety so that the solve's intermediate partial sums and the
// downstream products B(j) * N1(j) of every term that contributes to the
// conditional moments also stay in the normal range.
constexpr double COND_PROB_MIN = 1e-300;

// Smallest reportable probability: the smallest positive normal double.
// A computed absorption probability below this has underflowed (the true
// value is positive but unrepresentable at full precision); printing 0 or a
// subnormal would present underflow as a result.
const double PROB_UNDERFLOW = std::numeric_limits<double>::min();

// Refuse non-finite values and values outside [0,1] by more than
// PROB_RANGE_TOL; clamp roundoff-level excursions into [0,1] with a stderr
// note (never silently).
void enforce_probability_range(dvec& B, const char* name) {
    // This finiteness check MUST run before lo/hi are derived from B below --
    // it is not a redundant special case of the range check that follows.
    // IEEE 754 comparisons involving NaN are always false, so a NaN entry
    // would not reliably move minCoeff()/maxCoeff() outside [0,1]: an
    // implementation is free to return NaN itself (poisoning lo or hi so
    // every `<`/`>` against it is silently false) or to skip the NaN entry
    // entirely and return the max/min of the remaining finite ones, in which
    // case `lo < 0.0 || hi > 1.0` below never even sees the bad entry. Either
    // way a NaN in B would sail past both `if` blocks that follow and get
    // printed as though it were a probability. Do not "simplify" this to
    // rely on the range checks catching non-finite values -- they cannot.
    if (!B.allFinite()) {
        std::ostringstream os;
        os << name << " contains non-finite entries: the linear solve for the "
              "absorption probabilities failed for these parameters";
        throw std::runtime_error(os.str());
    }
    const double lo = B.minCoeff();
    const double hi = B.maxCoeff();
    if (lo < -PROB_RANGE_TOL || hi > 1.0 + PROB_RANGE_TOL) {
        std::ostringstream os;
        os << std::setprecision(std::numeric_limits<double>::max_digits10)
           << name << " is outside [0,1] by more than the roundoff tolerance "
           << PROB_RANGE_TOL << " (min " << lo << ", max " << hi
           << "): the absorption-probability solve failed for these parameters";
        throw std::runtime_error(os.str());
    }
    if (lo < 0.0 || hi > 1.0) {
        const double worst = std::max(hi - 1.0, -lo);
        llong n_clamped = 0;
        for (llong i = 0; i < B.size(); i++) {
            if (B(i) < 0.0) { B(i) = 0.0; ++n_clamped; }
            else if (B(i) > 1.0) { B(i) = 1.0; ++n_clamped; }
        }
        std::cerr << "Note: " << name << ": " << n_clamped << " of "
                  << B.size() << (n_clamped == 1 ? " entry" : " entries")
                  << " exceeded [0,1], worst excursion " << worst
                  << " (solver roundoff, within tolerance " << PROB_RANGE_TOL
                  << "); clamped to the boundary." << std::endl;
    }
}

// Gate for every computed scalar that is about to be printed: a non-finite
// result is a computation failure, reported as such instead of being
// formatted into the output.
void require_finite_result(double value, const char* name) {
    if (!std::isfinite(value)) {
        std::ostringstream os;
        os << "computed " << name << " is not finite (" << value
           << "); refusing to print numerically meaningless output. The "
              "requested quantity is not resolvable in double precision for "
              "these parameters";
        throw std::runtime_error(os.str());
    }
}

// Absorption-mode output with optional fields. Mirrors
// OutputFormatter::print_absorption_results exactly (same field order, same
// layout, same stream so the same precision), minus the omitted fields.
// The shared formatter keeps the all-fields path so healthy runs are
// byte-identical; this local variant exists only because a field may now be
// honestly absent, and the shared formatter (owned by another remediation
// task) has a fixed all-fields signature.
struct AbsorptionField {
    const char* name;
    std::optional<double> value;
};

void print_absorption_results_partial(const CLI::CommandLineOptions& options,
                                      const std::vector<AbsorptionField>& fields) {
    size_t n_present = 0;
    for (const auto& f : fields) n_present += f.value.has_value();
    if (options.json_output) {
        std::cout << "{" << std::endl;
        std::cout << "  \"model\": \"absorption\"," << std::endl;
        std::cout << "  \"results\": {" << std::endl;
        size_t remaining = n_present;
        for (const auto& f : fields) {
            if (!f.value) continue;
            --remaining;
            std::cout << "    \"" << f.name << "\": " << *f.value
                      << (remaining ? "," : "") << std::endl;
        }
        std::cout << "  }" << std::endl;
        std::cout << "}" << std::endl;
    } else if (options.csv_output) {
        size_t remaining = n_present;
        for (const auto& f : fields) {
            if (!f.value) continue;
            std::cout << f.name << (--remaining ? "," : "");
        }
        std::cout << std::endl;
        remaining = n_present;
        for (const auto& f : fields) {
            if (!f.value) continue;
            std::cout << *f.value << (--remaining ? "," : "");
        }
        std::cout << std::endl;
    } else {
        for (const auto& f : fields) {
            if (f.value) std::cout << f.name << " = " << *f.value << std::endl;
        }
    }
}

} // namespace

/**
 * @brief Main entry point for the wfes_single command-line tool
 * 
 * This program implements various Wright-Fisher exact solver models including:
 * - Absorption: Both extinction and fixation are absorbing
 * - Fixation: Only fixation is absorbing
 * - Equilibrium: Calculate stationary distribution
 * - Fundamental: Calculate fundamental matrix
 * - Establishment: Calculate establishment probabilities
 * - Allele age: Calculate expected age of an allele
 * - Non-absorbing: Generate transition matrix only
 *
 * @param argc Number of command-line arguments
 * @param argv Array of command-line arguments
 * @return int Exit code (0 for success, non-zero for error)
 */
int main(int argc, char const *argv[]) {
    time_point t_start, t_end;
    
    try {
        // Parse command-line arguments (banner will be displayed by parser)
        CLI::CommandLineOptions options = CLI::Args_Parser::parse_wfes_single_args(argc, argv);
        
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
        
        // Load initial distribution if provided, or create a default one
        dvec starting_copies_p;
        int starting_copies_start = 1; // Default if using CSV
        if (!options.initial_distribution_path.empty()) {
            // Validated, like every other tool. This read the file with
            // load_csv_col_vector and never checked its length, so a file of the
            // wrong size was indexed out of range and the run died on an Eigen
            // assertion -- no message naming the file, the length it had, or the
            // length it needed. The state space here is the transient interior:
            // starting copies 1..2N-1.
            starting_copies_p = wfes::cli::load_initial_distribution(
                options.initial_distribution_path,
                2 * options.population_size - 1,
                "allele counts 1..2N-1");
        } else {
            // Create default initial distribution
            wrightfisher::Row first_row_obj = wrightfisher::binom_row(
                2 * options.population_size, 
                wrightfisher::psi_diploid(
                    0, options.population_size, 
                    options.selection_coefficient, 
                    options.dominance, 
                    options.backward_mutation, 
                    options.forward_mutation
                ), 
                options.alpha
            );
            dvec first_row = first_row_obj.Q;
            int first_row_start = first_row_obj.start;
            
            // Renormalize
            starting_copies_p = first_row.tail(first_row.size() - 1);
            starting_copies_p /= 1 - first_row(0);
            starting_copies_start = first_row_start + 1; // Skip the 0 copies
        }
        
        // Store initial distribution if requested
        if (!options.output_I_path.empty()) {
            CLI::OutputFormatter::write_vector_to_file(starting_copies_p, options.output_I_path);
        }
        
        
        // Count integration steps
        llong z = 0;
        if (options.initial_distribution_path.empty()) {
            if (options.integration_cutoff <= 0 || options.forward_mutation == 0) {
                // No integration
                z = 1;
                starting_copies_p.setZero();
                starting_copies_p[0] = 1.0;
            } else {
                for (llong i = 0; i < starting_copies_p.size() && starting_copies_p(i) > options.integration_cutoff; i++) {
                    z++;
                }
            }
        } else {
            z = starting_copies_p.size();
        }
        
        
        // Override z if starting copies is provided
        if (options.starting_copies >= 0) {  // Changed from > 0 to >= 0
            z = 1;
            // When using fixed starting copies, set distribution to delta function
            starting_copies_p.setZero();
            starting_copies_p[0] = 1.0;
        }

        // Integrity audit fix (section 1.3): a cutoff so high that NO starting
        // state survives the integration loop (e.g. -c 1) used to fall
        // through with z == 0, integrate over nothing, and print all-zero
        // results with exit 0 -- plus a zero-byte matrix for --output-N.
        // Refuse before any model output is computed or written. Only the
        // modes that integrate over starting states consume z; equilibrium,
        // fundamental and non-absorbing do not and are unaffected.
        if (z <= 0 && (options.model_type == CLI::ModelType::ABSORPTION ||
                       options.model_type == CLI::ModelType::FIXATION ||
                       options.model_type == CLI::ModelType::ALLELE_AGE ||
                       options.model_type == CLI::ModelType::ESTABLISHMENT)) {
            std::ostringstream os;
            os << "No starting state above the integration cutoff (-c "
               << options.integration_cutoff
               << "): every entry of the mutational injection distribution is "
                  "at or below the cutoff, so there is nothing to integrate "
                  "over. Lower -c, or give -p / --initial.";
            throw std::runtime_error(os.str());
        }

        
        // Set message level for solvers
        llong msg_level = options.verbose ? MKL_PARDISO_MSG_VERBOSE : MKL_PARDISO_MSG_QUIET;
        
        // Library selection comes from options.library
        
        // Dispatch based on model type
        switch (options.model_type) {
            case CLI::ModelType::FIXATION: {
                if (options.verbose) {
                    std::cout << "Creating Wright-Fisher matrix:" << std::endl;
                    std::cout << "  Population size: " << options.population_size << std::endl;
                    std::cout << "  Selection: " << options.selection_coefficient << std::endl;
                    std::cout << "  Dominance: " << options.dominance << std::endl;
                    std::cout << "  Backward mutation: " << options.backward_mutation << std::endl;
                    std::cout << "  Forward mutation: " << options.forward_mutation << std::endl;
                    std::cout << "  Recurrent mutation: " << options.recurrent_mutation << std::endl;
                    std::cout << "  Alpha: " << options.alpha << std::endl;
                    std::cout << "  Block size: " << options.block_size << std::endl;
                    // Requested, not necessarily what runs -- see below.
                    std::cout << "  Library (requested): " << options.library << std::endl;
                    std::cout << "  MSG level: " << msg_level << std::endl;
                }
                
                // Create Wright-Fisher matrix with fixation-only absorbing state
                WF::Matrix W = WF::Single(
                    options.population_size, options.population_size, 
                    WF::FIXATION_ONLY,
                    options.selection_coefficient, options.dominance,
                    options.backward_mutation, options.forward_mutation,
                    options.recurrent_mutation, options.alpha,
                    options.verbose, options.block_size, options.library
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
                
                // Size of the problem - for FIXATION_ONLY we exclude the last row/column
                llong size = (2 * options.population_size);
                
                // Create solver
                solver::Solver* solver = solver::SolverFactory::createSolver(
                    options.library, *W.Q, MKL_PARDISO_MATRIX_TYPE_REAL_UNSYMMETRIC, msg_level
                );
                solver->preprocess();

                // What actually ran, which is not always what was asked for:
                // SolverFactory serves "--library Accelerate" with
                // SuiteSparse/UMFPACK whenever SuiteSparse is available. Echoing
                // options.library alone put a backend in the user's log that
                // never executed.
                if (options.verbose) {
                    std::cout << "  Library (in use):    " << solver->backendName() << std::endl;
                }

                // Check if integration or single starting copy.
                // In FIXATION mode options.starting_copies IS the copy count
                // (index == count; count 0 is transient), set by the parser.
                // -1 means -p was omitted: integrate over the injection
                // distribution (which conditions on >= 1 copy appearing).
                if (options.starting_copies >= 0) {
                    // Single starting copy case
                    dvec id(size);
                    dmat N_mat(1, size);

                    id.setZero();
                    id(options.starting_copies) = 1;
                
                    // Solve for N matrix
                    N_mat.row(0) = solver->solve(id, true);
                    dvec N1 = N_mat.row(0);
                    dvec N2 = solver->solve(N1, true);
                    
                    // Calculate fixation time and variance
                    double T_fix = N1.sum();
                    double T_var = ((2 * N2.sum()) - N1.sum()) - pow(N1.sum(), 2);
                    double rate = 1.0 / T_fix;
                    double T_std = sqrt(T_var);
                    
                    // Output N matrix if requested
                    if (!options.output_N_path.empty()) {
                        CLI::OutputFormatter::write_matrix_to_file(N_mat, options.output_N_path);
                    }
                    
                    // Output B vector if requested
                    if (!options.output_B_path.empty()) {
                        dvec B = dvec::Ones(size);
                        CLI::OutputFormatter::write_vector_to_file(B, options.output_B_path);
                    }
                    
                    // Output results
                    require_finite_result(T_fix, "T_fix");
                    require_finite_result(T_std, "T_std");
                    require_finite_result(rate, "rate");
                    CLI::OutputFormatter::print_fixation_results(
                        options, T_fix, T_std, rate
                    );
                } else {
                    // Integration case - calculate for each starting copy number in z
                    
                    double T_fix = 0;
                    double T_fix_var = 0;
                    
                    // Matrices for results  
                    dmat N_mat(z, size);
                    dmat N2_mat(z, size);
                    
                    dvec id(size);
                    
                    // Integrate over starting number of copies
                    for (llong i = 0; i < z; i++) {
                        llong actual_copy_num = starting_copies_start + i;
                        double p_i = starting_copies_p(i);
                        
                        id.setZero();
                        id(actual_copy_num) = 1;
                        
                        // Solve for absorption times
                        N_mat.row(i) = solver->solve(id, true);
                        dvec N1 = N_mat.row(i);
                        N2_mat.row(i) = solver->solve(N1, true);
                        dvec N2 = N2_mat.row(i);
                        
                        // Calculate contribution to fixation time
                        double T_i = N1.sum();
                        double T_i_var = ((2 * N2.sum()) - N1.sum()) - pow(N1.sum(), 2);
                        
                        T_fix += p_i * T_i;
                        T_fix_var += p_i * T_i_var;
                    }
                    
                    double rate = 1.0 / T_fix;
                    double T_std = sqrt(T_fix_var);
                    
                    // Output N matrix if requested
                    if (!options.output_N_path.empty()) {
                        CLI::OutputFormatter::write_matrix_to_file(N_mat, options.output_N_path);
                    }
                    
                    // Output B vector if requested
                    if (!options.output_B_path.empty()) {
                        dvec B = dvec::Ones(size);
                        CLI::OutputFormatter::write_vector_to_file(B, options.output_B_path);
                    }
                    
                    // Output results
                    require_finite_result(T_fix, "T_fix");
                    require_finite_result(T_std, "T_std");
                    require_finite_result(rate, "rate");
                    CLI::OutputFormatter::print_fixation_results(
                        options, T_fix, T_std, rate
                    );
                }

                delete solver;
                break;
            }

            case CLI::ModelType::ABSORPTION: {
                // Create Wright-Fisher matrix with both absorbing states
                WF::Matrix W = WF::Single(
                    options.population_size, options.population_size, 
                    WF::BOTH_ABSORBING,
                    options.selection_coefficient, options.dominance,
                    options.backward_mutation, options.forward_mutation,
                    options.recurrent_mutation, options.alpha,
                    options.verbose, options.block_size, options.library
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
                
                // Size of the problem
                llong size = (2 * options.population_size) - 1;
                
                
                // Create solver
                solver::Solver* solver = solver::SolverFactory::createSolver(
                    options.library, *W.Q, MKL_PARDISO_MATRIX_TYPE_REAL_UNSYMMETRIC, msg_level
                );
                solver->preprocess();
                
                // Extract extinction and fixation columns from R and solve for
                // BOTH absorption vectors against the same factorization.
                //
                // Integrity audit fix (section 1.1): B_fix used to be derived
                // as 1 - B_ext. That subtraction caps the accuracy of B_fix at
                // ~2.2e-16 ABSOLUTE, so whenever the true fixation probability
                // is at or below that level (any strongly deleterious case) the
                // derived entries were pure roundoff: negative probabilities,
                // P_ext > 1, conditional times "conditioned" on impossible
                // events, and nan standard deviations -- all printed with exit
                // 0. Solving (I - Q) B_fix = R_fix directly is one extra
                // back-substitution against the factorization that already
                // exists, and -- because the substitution is subtraction-free
                // for these M-matrix systems -- it preserves RELATIVE accuracy
                // for arbitrarily small fixation probabilities, which is this
                // tool's reason to exist.
                dvec R_ext = W.R.col(0);
                dvec R_fix = W.R.col(1);
                dvec B_ext = solver->solve(R_ext, false);
                dvec B_fix = solver->solve(R_fix, false);

                // B_ext + B_fix = 1 is a residual DIAGNOSTIC of the solve, not
                // the definition of either vector -- but a large residual is a
                // real failure mode of its own: B_ext and B_fix are solved
                // independently against their own RHS column, so both can
                // individually land inside [0,1] (and so pass
                // enforce_probability_range below) while the pair is still
                // arbitrarily wrong. Hold the residual to the same evidence
                // standard enforce_probability_range refuses on: refuse,
                // don't warn-and-continue.
                {
                    const double one_residual =
                        (B_ext + B_fix - dvec::Ones(size)).cwiseAbs().maxCoeff();
                    // IEEE 754 trap: every comparison against NaN is false, so
                    // a solve that produced NaN entries in B_ext or B_fix can
                    // make one_residual itself NaN (or, depending on how
                    // maxCoeff() treats a NaN entry, silently skip it and
                    // return the max of whatever finite entries remain) --
                    // either way `one_residual > PROB_RANGE_TOL` alone would
                    // be false and let the worst case (a NaN solve) sail
                    // straight through this refusal. Check non-finiteness
                    // explicitly; do not simplify this back to a bare `>`.
                    if (!std::isfinite(one_residual) || one_residual > PROB_RANGE_TOL) {
                        std::ostringstream os;
                        os << std::setprecision(std::numeric_limits<double>::max_digits10)
                           << "|B_ext + B_fix - 1| = " << one_residual
                           << ", exceeding the roundoff tolerance " << PROB_RANGE_TOL
                           << ". B_ext solves (I - Q) x = R_ext and B_fix solves "
                              "(I - Q) x = R_fix independently against the same "
                              "factorization (integrity audit section 1.1 fix): "
                              "a residual this large means that solve failed for "
                              "these parameters even though B_ext and B_fix may "
                              "each individually lie inside [0,1]. Refusing to "
                              "print results that cannot be trusted.";
                        throw std::runtime_error(os.str());
                    }
                }

                enforce_probability_range(B_ext, "B_ext");
                enforce_probability_range(B_fix, "B_fix");

                dvec id(size);

                // Initialize result variables
                double P_ext = 0;
                double P_fix = 0;
                double T_abs = 0;
                double T_ext = 0;
                double T_fix = 0;
                double T_abs_var = 0;
                double T_ext_var = 0;
                double T_fix_var = 0;
                double N_ext = 0;

                // Matrices for results
                dmat N_mat(z, size);
                dmat E_ext_mat(z, size);
                dmat E_fix_mat(z, size);
                dmat N2_mat(z, size);

                // The starting states this run integrates over: (transient
                // index, weight) pairs. Row r of the result matrices belongs
                // to starts[r]. A single -p start is the weight-1 special
                // case, which keeps the two historical code paths (integration
                // vs -p) arithmetically identical to what they were while the
                // integrity guards below apply to both.
                std::vector<std::pair<llong, double>> starts;
                if (options.starting_copies < 0) {
                    if (z > size) {
                        std::ostringstream os;
                        os << "integration range exceeds the transient state "
                              "space (z = " << z << ", 2N-1 = " << size
                           << "); raise -c";
                        throw std::runtime_error(os.str());
                    }
                    for (llong i = 0; i < z; i++) {
                        starts.emplace_back(i, starting_copies_p(i));
                    }
                } else {
                    starts.emplace_back(options.starting_copies, 1.0);
                }

                // Integrity audit fix (section 1.1c): decide up front which
                // conditional families double precision can support. Every
                // conditional-on-extinction (resp. -fixation) moment divides
                // by B_ext(start) (resp. B_fix(start)); once that anchor drops
                // below COND_PROB_MIN the conditional expectation is
                // numerically meaningless and the fields are OMITTED with a
                // diagnostic instead of printed as 0/0 artifacts.
                //   *_cond_ok : the scalar moments (mixture over states with
                //               nonzero weight) are computable.
                //   *_rows_ok : every requested row of the conditional sojourn
                //               matrices (--output-N-ext/-N-fix) is computable;
                //               zero-weight states still get rows, so this can
                //               be false while the scalars are fine.
                bool ext_cond_ok = true, fix_cond_ok = true;
                bool ext_rows_ok = true, fix_rows_ok = true;
                double min_B_ext_used = 1.0, min_B_fix_used = 1.0;
                for (const auto& [st, w] : starts) {
                    if (B_ext(st) < COND_PROB_MIN) {
                        ext_rows_ok = false;
                        if (w > 0) ext_cond_ok = false;
                    }
                    if (B_fix(st) < COND_PROB_MIN) {
                        fix_rows_ok = false;
                        if (w > 0) fix_cond_ok = false;
                    }
                    if (w > 0) {
                        min_B_ext_used = std::min(min_B_ext_used, B_ext(st));
                        min_B_fix_used = std::min(min_B_fix_used, B_fix(st));
                    }
                }

                for (size_t r = 0; r < starts.size(); r++) {
                    const llong st = starts[r].first;
                    const double p_i = starts[r].second;
                    id.setZero();
                    id(st) = 1;

                    // Solve for absorption times
                    N_mat.row(r) = solver->solve(id, true);
                    dvec N1 = N_mat.row(r);
                    N2_mat.row(r) = solver->solve(N1, true);
                    dvec N2 = N2_mat.row(r);
                    if (!N1.allFinite() || !N2.allFinite()) {
                        throw std::runtime_error(
                            "the sojourn-time solve returned non-finite values "
                            "for these parameters");
                    }

                    // Calculate absorption time
                    T_abs += N1.sum() * p_i;
                    T_abs_var += ((2 * N2.sum() - N1.sum()) - pow(N1.sum(), 2)) * p_i;

                    // Calculate extinction probability and time
                    P_ext += B_ext(st) * p_i;
                    if (B_ext(st) >= COND_PROB_MIN) {
                        dvec E_ext = B_ext.array() * N1.array() / B_ext(st);
                        E_ext_mat.row(r) = E_ext;
                        if (ext_cond_ok) {
                            dvec E_ext_var = B_ext.array() * N2.array() / B_ext(st);
                            T_ext += E_ext.sum() * p_i;
                            T_ext_var += ((2 * E_ext_var.sum() - E_ext.sum()) - pow(E_ext.sum(), 2)) * p_i;

                            // Calculate copies in extinction trajectory
                            dvec C_ext = E_ext.array() * dvec::LinSpaced(size, 1, size).array();
                            N_ext += p_i * C_ext.sum();
                        }
                    }

                    // Calculate fixation probability and time
                    P_fix += B_fix(st) * p_i;
                    if (B_fix(st) >= COND_PROB_MIN) {
                        dvec E_fix = B_fix.array() * N1.array() / B_fix(st);
                        E_fix_mat.row(r) = E_fix;
                        if (fix_cond_ok) {
                            dvec E_fix_var = B_fix.array() * N2.array() / B_fix(st);
                            T_fix += E_fix.sum() * p_i;
                            T_fix_var += ((2 * E_fix_var.sum() - E_fix.sum()) - pow(E_fix.sum(), 2)) * p_i;
                        }
                    }
                }

                // ---- assemble the report: omit what double precision cannot
                // ---- support, with a stderr diagnostic for every omission.
                std::optional<double> out_P_ext, out_P_fix, out_T_abs,
                    out_T_abs_std, out_T_ext, out_T_ext_std, out_N_ext,
                    out_T_fix, out_T_fix_std;

                // A probability is reportable only as a positive normal
                // double. Below DBL_MIN the computed value is not
                // trustworthy at full precision -- and it is not necessarily
                // positive either: at parameter corners where the event is
                // genuinely unreachable (e.g. u=1, v=0), the true value is
                // exactly 0, and the solve can return exactly 0.0 here too.
                auto report_probability =
                    [](double value, const char* name) -> std::optional<double> {
                    if (value > 1.0) {
                        // B entries are already clamped to [0,1]; a mixture
                        // can only land here through fp roundoff of the
                        // weighted sum (or unnormalized --initial weights).
                        if (value > 1.0 + PROB_RANGE_TOL) {
                            std::ostringstream os;
                            os << name << " = " << value
                               << " exceeds 1 beyond the roundoff tolerance; "
                                  "check that the --initial weights sum to 1";
                            throw std::runtime_error(os.str());
                        }
                        std::cerr << "Note: " << name << " exceeded 1 by "
                                  << (value - 1.0)
                                  << " (floating-point roundoff in the "
                                     "starting-state weights and absorption "
                                     "probabilities); clamped to 1."
                                  << std::endl;
                        return 1.0;
                    }
                    if (value < PROB_UNDERFLOW) {
                        std::cerr << "Note: " << name
                                  << " is not representable as a positive "
                                     "normal double (computed value "
                                  << value
                                  << " is at or below the smallest positive "
                                     "normal double, 2.2250738585072014e-308): "
                                     "the true value may be a tiny positive "
                                     "probability indistinguishable from zero "
                                     "at this precision, or genuinely exactly "
                                     "zero at these parameters. Omitting "
                                  << name << " rather than printing 0."
                                  << std::endl;
                        return std::nullopt;
                    }
                    return value;
                };
                out_P_ext = report_probability(P_ext, "P_ext");
                out_P_fix = report_probability(P_fix, "P_fix");

                out_T_abs = T_abs;
                if (T_abs_var >= 0) {
                    out_T_abs_std = sqrt(T_abs_var);
                } else {
                    std::cerr << "Note: the T_abs variance came out negative at "
                                 "double precision (cancellation; computed "
                              << T_abs_var << "). Omitting T_abs_std."
                              << std::endl;
                }

                if (ext_cond_ok) {
                    out_T_ext = T_ext;
                    if (T_ext_var >= 0) {
                        out_T_ext_std = sqrt(T_ext_var);
                    } else {
                        std::cerr << "Note: the T_ext variance came out negative "
                                     "at double precision (cancellation; "
                                     "computed " << T_ext_var
                                  << "). Omitting T_ext_std." << std::endl;
                    }
                } else {
                    std::cerr << "Note: conditional-on-extinction moments are "
                                 "numerically meaningless here: B_ext at a "
                                 "starting state with nonzero weight is "
                              << min_B_ext_used << " (below " << COND_PROB_MIN
                              << "), and every conditional moment divides by "
                                 "it. Omitting T_ext and T_ext_std."
                              << std::endl;
                }

                if (fix_cond_ok) {
                    out_T_fix = T_fix;
                    if (T_fix_var >= 0) {
                        out_T_fix_std = sqrt(T_fix_var);
                    } else {
                        std::cerr << "Note: the T_fix variance came out negative "
                                     "at double precision (cancellation; "
                                     "computed " << T_fix_var
                                  << "). Omitting T_fix_std." << std::endl;
                    }
                } else {
                    std::cerr << "Note: conditional-on-fixation moments are "
                                 "numerically meaningless here: B_fix at a "
                                 "starting state with nonzero weight is "
                              << min_B_fix_used << " (below " << COND_PROB_MIN
                              << "), and every conditional moment divides by "
                                 "it. Omitting T_fix and T_fix_std."
                              << std::endl;
                }

                // N_ext is the stationary mean number of segregating copies on
                // extinction trajectories under recurrent mutational influx at
                // rate 2Nv (renewal-reward: expected copy-generations per
                // extinction trajectory over expected cycle length
                // 1/(2Nv) + T_ext).
                //
                // Integrity audit fix (section 5.3b): with v = 0 there is no
                // influx and no stationary regime -- the defining renewal
                // process has no arrivals -- so the quantity is undefined, not
                // 0. The old code evaluated 1/(2N*0) = inf and printed the
                // IEEE artifact C/inf = 0 as if it were a result. Omit the
                // field instead. (The v -> 0+ limit is 0, but reporting a
                // limit of vanishing influx as a property of the no-influx
                // model would substitute an artifact for an answer.)
                if (!ext_cond_ok) {
                    std::cerr << "Note: N_ext also requires the conditional-"
                                 "extinction sojourns; omitting N_ext."
                              << std::endl;
                } else {
                    const double influx_wait =
                        1 / (2 * options.population_size * options.forward_mutation);
                    if (std::isfinite(influx_wait)) {
                        // Normalize N_ext (same expression as always)
                        N_ext /= influx_wait + T_ext;
                        out_N_ext = N_ext;
                    } else if (options.forward_mutation == 0.0) {
                        std::cerr << "Note: N_ext is undefined when the forward "
                                     "mutation rate is 0 (-v 0): it is the "
                                     "stationary mean number of segregating "
                                     "copies under recurrent mutational influx "
                                     "at rate 2Nv, and with v = 0 there is no "
                                     "influx and no stationary regime. "
                                     "Omitting N_ext." << std::endl;
                    } else {
                        // v is nonzero but small enough that 2*N*v underflows
                        // toward the smallest denormals, so its reciprocal
                        // overflows a double -- a numerical overflow, not the
                        // v=0 undefined-model case above.
                        std::cerr << "Note: N_ext is not representable in "
                                     "double precision at this forward "
                                     "mutation rate (v = " << options.forward_mutation
                                  << "): the mean renewal-cycle length "
                                     "1/(2Nv) overflows, because v is nonzero "
                                     "but too small for that reciprocal to "
                                     "fit in a double. Omitting N_ext."
                                  << std::endl;
                    }
                }

                // Output matrices if requested. The unconditional sojourn
                // matrix N is always computable; the conditional matrices are
                // only written when every row of them is (nothing non-finite
                // may ever reach an output file).
                if (!options.output_N_path.empty()) {
                    CLI::OutputFormatter::write_matrix_to_file(N_mat, options.output_N_path);
                }
                if (!options.output_N_ext_path.empty()) {
                    if (ext_rows_ok && E_ext_mat.allFinite()) {
                        CLI::OutputFormatter::write_matrix_to_file(E_ext_mat, options.output_N_ext_path);
                    } else {
                        std::cerr << "Note: --output-N-ext not written: the "
                                     "conditional-extinction sojourns are not "
                                     "computable in double precision for at "
                                     "least one requested starting state "
                                     "(B_ext below " << COND_PROB_MIN << ")."
                                  << std::endl;
                    }
                }
                if (!options.output_N_fix_path.empty()) {
                    if (fix_rows_ok && E_fix_mat.allFinite()) {
                        CLI::OutputFormatter::write_matrix_to_file(E_fix_mat, options.output_N_fix_path);
                    } else {
                        std::cerr << "Note: --output-N-fix not written: the "
                                     "conditional-fixation sojourns are not "
                                     "computable in double precision for at "
                                     "least one requested starting state "
                                     "(B_fix below " << COND_PROB_MIN << ")."
                                  << std::endl;
                    }
                }
                if (!options.output_B_path.empty()) {
                    dmat B(size, 2);
                    B.col(0) = B_ext;
                    B.col(1) = B_fix;
                    CLI::OutputFormatter::write_matrix_to_file(B, options.output_B_path);
                }

                // Output results. When every field is computable this goes
                // through the shared formatter, byte-identical to what it
                // always printed; the local partial printer exists only for
                // honest omissions.
                if (out_P_ext && out_P_fix && out_T_abs && out_T_abs_std &&
                    out_T_ext && out_T_ext_std && out_N_ext && out_T_fix &&
                    out_T_fix_std) {
                    CLI::OutputFormatter::print_absorption_results(
                        options, *out_P_ext, *out_P_fix, *out_T_abs, *out_T_abs_std,
                        *out_T_ext, *out_T_ext_std, *out_N_ext, *out_T_fix, *out_T_fix_std
                    );
                } else {
                    print_absorption_results_partial(options, {
                        {"P_ext", out_P_ext}, {"P_fix", out_P_fix},
                        {"T_abs", out_T_abs}, {"T_abs_std", out_T_abs_std},
                        {"T_ext", out_T_ext}, {"T_ext_std", out_T_ext_std},
                        {"N_ext", out_N_ext},
                        {"T_fix", out_T_fix}, {"T_fix_std", out_T_fix_std},
                    });
                }
                
                delete solver;
                break;
            }
            
            case CLI::ModelType::EQUILIBRIUM: {
                // Create equilibrium solving matrix
                llong size = (2 * options.population_size) + 1;
                WF::Matrix W = WF::EquilibriumSolvingMatrix(
                    options.population_size, 
                    options.selection_coefficient, options.dominance,
                    options.backward_mutation, options.forward_mutation,
                    options.alpha, options.verbose, options.block_size, options.library
                );
                
                // Create solver
                solver::Solver* solver = solver::SolverFactory::createSolver(
                    options.library, *W.Q, MKL_PARDISO_MATRIX_TYPE_REAL_UNSYMMETRIC, msg_level
                );
                solver->preprocess();
                
                // Set up right-hand side vector
                dvec O = dvec::Zero(size);
                O(size - 1) = 1;
                
                // Solve for equilibrium distribution
                dvec pi = solver->solve(O, true);
                if (!pi.allFinite()) {
                    throw std::runtime_error(
                        "the equilibrium solve returned non-finite values for "
                        "these parameters");
                }

                // Output equilibrium distribution if requested
                if (!options.output_E_path.empty()) {
                    CLI::OutputFormatter::write_vector_to_file(pi, options.output_E_path);
                }

                // Calculate expected frequency
                double e_freq = 0.0;
                for (llong i = 0; i < size; i++) {
                    e_freq += i * pi[i];
                }
                e_freq /= (size - 1);

                // Output results with distribution for JSON/CSV
                require_finite_result(e_freq, "E_freq");
                CLI::OutputFormatter::print_equilibrium_results_with_distribution(options, e_freq, pi);
                
                delete solver;
                break;
            }
            
            case CLI::ModelType::NON_ABSORBING: {
                // Create non-absorbing Wright-Fisher matrix
                WF::Matrix W = WF::Single(
                    options.population_size, options.population_size, 
                    WF::NON_ABSORBING,
                    options.selection_coefficient, options.dominance,
                    options.backward_mutation, options.forward_mutation,
                    options.recurrent_mutation, options.alpha,
                    options.verbose, options.block_size, options.library
                );
                
                // Output matrix if requested
                if (!options.output_Q_path.empty()) {
                    W.Q->saveMarket(options.output_Q_path);
                }
                
                // Output results
                CLI::OutputFormatter::print_non_absorbing_results(options);
                break;
            }
            
            case CLI::ModelType::FUNDAMENTAL: {
                // Create Wright-Fisher matrix with both absorbing states
                llong size = (2 * options.population_size) - 1;
                WF::Matrix W = WF::Single(
                    options.population_size, options.population_size, 
                    WF::BOTH_ABSORBING,
                    options.selection_coefficient, options.dominance,
                    options.backward_mutation, options.forward_mutation,
                    options.recurrent_mutation, options.alpha,
                    options.verbose, options.block_size, options.library
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
                
                // Create solver
                solver::Solver* solver = solver::SolverFactory::createSolver(
                    options.library, *W.Q, MKL_PARDISO_MATRIX_TYPE_REAL_UNSYMMETRIC, msg_level
                );
                solver->preprocess();
                
                // Sojourn times are defined per starting state: N(i, j) is the
                // expected number of generations spent at count j+1, before
                // absorption, having started at count i+1. So there are exactly
                // two useful outputs, and which one is wanted is said by -p:
                //
                //   -p given   one starting state, so one row of N. That is a
                //              SINGLE solve, not the 2N-1 the whole matrix costs.
                //   -p absent  every starting state, so the whole matrix.
                //
                // Averaging rows under a starting distribution is well defined but
                // answers a question this mode is not for, and an earlier version
                // of this branch offered it. --initial is refused here rather than
                // ignored, and --integration-cutoff has no meaning in this mode.
                if (!options.initial_distribution_path.empty()) {
                    throw std::invalid_argument(
                        "Error: --initial does not apply to --fundamental. Sojourn times are "
                        "conditioned on a starting state: give -p <count> for one row of N, "
                        "or omit it for the whole matrix.");
                }

                const bool one_row = (options.starting_copies >= 0 &&
                                      options.starting_copies < size);
                // V is built from N's diagonal and from N itself, so it needs the
                // whole matrix even when only one row was asked for.
                const bool need_full = !one_row || !options.output_V_path.empty();

                dmat N;
                dvec sojourn;   // empty means "no starting state given"

                if (need_full) {
                    N.resize(size, size);
                    dvec id(size);
                    for (llong i = 0; i < size; i++) {
                        id.setZero();
                        id(i) = 1;
                        N.row(i) = solver->solve(id, true);
                    }
                    if (one_row) sojourn = N.row(options.starting_copies);
                } else {
                    dvec id = dvec::Zero(size);
                    id(options.starting_copies) = 1;
                    sojourn = solver->solve(id, true);
                }
                if ((need_full && !N.allFinite()) ||
                    (sojourn.size() > 0 && !sojourn.allFinite())) {
                    throw std::runtime_error(
                        "the fundamental-matrix solve returned non-finite "
                        "values for these parameters");
                }

                // What --output-N writes follows the same rule: the row that was
                // asked for, or the whole matrix.
                if (!options.output_N_path.empty()) {
                    if (need_full) {
                        CLI::OutputFormatter::write_matrix_to_file(N, options.output_N_path);
                    } else {
                        dmat row_out(1, size);
                        row_out.row(0) = sojourn;
                        CLI::OutputFormatter::write_matrix_to_file(row_out, options.output_N_path);
                    }
                }

                double T_abs_total = sojourn.size() > 0 ? sojourn.sum() : 0.0;

                // Calculate variance-time matrix V if requested
                if (!options.output_V_path.empty()) {
                    dvec Ndg = (2 * N.diagonal().array()) - 1;
                    dmat Nsq = N.array().square();
                    dmat V = (N * Ndg.asDiagonal()) - Nsq;
                    if (!V.allFinite()) {
                        throw std::runtime_error(
                            "the variance-time matrix V is not finite for "
                            "these parameters; refusing to write it");
                    }
                    CLI::OutputFormatter::write_matrix_to_file(V, options.output_V_path);
                }

                // Output results
                require_finite_result(T_abs_total, "T_abs");
                CLI::OutputFormatter::print_fundamental_results(options, sojourn, T_abs_total);
                
                delete solver;
                break;
            }
            
            case CLI::ModelType::ALLELE_AGE: {
                // -1, not 0, is the parser's "flag not supplied" sentinel. It
                // used to be 0, which is a legal transient index -- the one for
                // a single observed copy -- so `-x 1` was reported as a missing
                // flag. The parser now range-checks -x against 1..2N-1 and
                // stores count-1, so every supplied value lands in 0..2N-2 and
                // cannot collide with the sentinel.
                if (options.observed_copies < 0) {
                    throw std::runtime_error(
                        "--observed-copies (-x) is required for --allele-age: "
                        "the age of an allele is conditional on the number of "
                        "copies it is observed at. Give a count between 1 and "
                        "2N-1 = " +
                        std::to_string(2 * options.population_size - 1));
                }

                llong x = options.observed_copies; // Already 0-based from args parser
                llong size = (2 * options.population_size) - 1;
                
                
                // Create Wright-Fisher matrix with both absorbing states
                WF::Matrix W = WF::Single(
                    options.population_size, options.population_size, 
                    WF::BOTH_ABSORBING,
                    options.selection_coefficient, options.dominance,
                    options.backward_mutation, options.forward_mutation,
                    options.recurrent_mutation, options.alpha,
                    options.verbose, options.block_size, options.library
                );
                
                // Output matrices if requested
                if (!options.output_Q_path.empty()) {
                    W.Q->saveMarket(options.output_Q_path);
                }
                if (!options.output_R_path.empty()) {
                    CLI::OutputFormatter::write_matrix_to_file(W.R, options.output_R_path);
                }
                
                // Extract column x from Q matrix before subtracting identity
                dvec Q_x = W.Q->getColCopy(x);

                // Higher moments (--num-moments K > 2), by the recipe in the
                // allele-age paper: mu_k = [Li_{-k}(Q)]_{p,x} / [(I-Q)^{-1}]_{p,x},
                // and Li_{-k}(z) = (sum_j <k,j> z^{j+1}) / (1-z)^{k+1} with
                // Eulerian numbers <k,j>. So each moment needs the x-column of
                // the Eulerian polynomial in Q -- built here as q_{j+1} = Q q_j
                // from the intact Q, before subtractIdentity rewrites it -- and
                // one extra back-substitution per moment against the same
                // factorization. K = 1 gives Q_x back; K = 2 gives Q(I+Q)e_x,
                // the paper's A_x.
                const llong K = options.n_moments;
                std::vector<dvec> qcols;   // qcols[j] = Q^{j+1} e_x
                std::vector<dvec> Bk;      // Bk[k-1]  = Eulerian polynomial column for mu_k
                if (K > 2) {
                    qcols.push_back(Q_x);
                    for (llong j = 1; j < K; j++) {
                        qcols.push_back(W.Q->multiply(qcols.back()));
                    }
                    // Eulerian triangle <k,j>: <k,j> = (j+1)<k-1,j> + (k-j)<k-1,j-1>
                    std::vector<std::vector<double>> eul(K + 1);
                    eul[0] = {1.0};
                    for (llong k = 1; k <= K; k++) {
                        eul[k].assign(k, 0.0);
                        for (llong j = 0; j < k; j++) {
                            double a = (j < (llong)eul[k-1].size()) ? eul[k-1][j] : 0.0;
                            double b = (j >= 1 && j-1 < (llong)eul[k-1].size()) ? eul[k-1][j-1] : 0.0;
                            eul[k][j] = (j + 1) * a + (k - j) * b;
                        }
                    }
                    for (llong k = 1; k <= K; k++) {
                        dvec bk = dvec::Zero(size);
                        for (llong j = 0; j < k; j++) bk += eul[k][j] * qcols[j];
                        Bk.push_back(bk);
                    }
                }
                // Raw moments E[T^k], k = 1..K, of the age distribution --
                // under integration, the mixture over starting copies.
                std::vector<double> raw_moments(K > 2 ? K : 0, 0.0);
                
                // Subtract identity once for solver setup
                W.Q->subtractIdentity();
                
                // Subtract identity again to get (Q-2I) for A_x calculation  
                W.Q->subtractIdentity();
                
                // Create A_x vector: (Q-2I) * ((Q-2I)_x + e_x) - matching original wfes2
                dvec Q_I_x = W.Q->getColCopy(x); // Extract column x from (Q-2I) - this matches original!
                Q_I_x(x) += 1; // Add e_x
                dvec A_x = W.Q->multiply(Q_I_x); // (Q-2I) * ((Q-2I)_x + e_x)
                
                
                // Add identity back to get (Q-I) for solver
                // Since we don't have addIdentity, we need to work around this
                // Let's create a new matrix for the solver
                WF::Matrix W_solver = WF::Single(
                    options.population_size, options.population_size, 
                    WF::BOTH_ABSORBING,
                    options.selection_coefficient, options.dominance,
                    options.backward_mutation, options.forward_mutation,
                    options.recurrent_mutation, options.alpha,
                    options.verbose, options.block_size, options.library
                );
                W_solver.Q->subtractIdentity(); // Only subtract once for solver
                
                // Create solver
                solver::Solver* solver = solver::SolverFactory::createSolver(
                    options.library, *W_solver.Q, MKL_PARDISO_MATRIX_TYPE_REAL_UNSYMMETRIC, msg_level
                );
                solver->preprocess();
                
                double E_allele_age = 0;
                double S_allele_age = 0;
                
                if (options.starting_copies < 0) { // Use integration (starting_copies is set to -1 when no -p flag)
                    
                    // Integrate over starting distribution
                    for (llong i = 0; i < z; i++) {
                        dvec e_p = dvec::Zero(size);
                        e_p(i) = 1;
                        
                        dvec M1 = solver->solve(e_p, true);
                        dvec M2 = solver->solve(M1, true);
                        
                        double mu1 = M2.dot(Q_x) / M1(x);
                        
                        dvec M3 = solver->solve(M2, true);
                        
                        // variance_term is the raw second moment E[T^2 | start i]
                        // (verified against the dense series). The mixture's raw
                        // moments are the weight-averaged per-start raw moments,
                        // so the SD of the age distribution under integration is
                        // sqrt(E_w[T^2] - E_w[T]^2). This used to accumulate
                        // sqrt(variance_i) instead -- an average of per-start SDs,
                        // which is not the SD of any distribution: it drops the
                        // between-start spread of the means (law of total
                        // variance) and sits below the within-start term by
                        // Jensen's inequality.
                        double M1_x = M1(x);
                        double M3_dot_Ax = M3.dot(A_x);
                        double variance_term = M3_dot_Ax / M1_x;

                        E_allele_age += mu1 * starting_copies_p(i);
                        S_allele_age += variance_term * starting_copies_p(i);

                        if (K > 2) {
                            // M chain continues: M_{m}^T is the p-th row of
                            // (I-Q)^{-m}; mu_k = M_{k+1} . Bk / M1(x).
                            std::vector<dvec> M = {M1, M2, M3};
                            for (llong m = 3; m <= K; m++) M.push_back(solver->solve(M.back(), true));
                            for (llong k = 1; k <= K; k++) {
                                raw_moments[k-1] += (M[k].dot(Bk[k-1]) / M1(x)) * starting_copies_p(i);
                            }
                        }
                    }
                    // S_allele_age accumulated E_w[T^2]; finish the mixture SD.
                    S_allele_age = sqrt(S_allele_age - E_allele_age * E_allele_age);
                } else {
                    // Use specified starting copies
                    dvec e_p = dvec::Zero(size);
                    e_p(options.starting_copies) = 1;
                    
                    dvec M1 = solver->solve(e_p, true);
                    dvec M2 = solver->solve(M1, true);
                    
                    E_allele_age = M2.dot(Q_x) / M1(x);
                    
                    dvec M3 = solver->solve(M2, true);
                    
                    // Debug variance calculation for specific starting copies
                    double M1_x = M1(x);
                    double M2_dot_Qx = M2.dot(Q_x);
                    double M3_dot_Ax = M3.dot(A_x);
                    double variance_term = M3_dot_Ax / M1_x;
                    double mu1_squared = pow(E_allele_age, 2);
                    double variance = variance_term - mu1_squared;
                    
                    S_allele_age = sqrt(variance);

                    if (K > 2) {
                        std::vector<dvec> M = {M1, M2, M3};
                        for (llong m = 3; m <= K; m++) M.push_back(solver->solve(M.back(), true));
                        for (llong k = 1; k <= K; k++) {
                            raw_moments[k-1] = M[k].dot(Bk[k-1]) / M1(x);
                        }
                    }
                }
                
                // Output results
                require_finite_result(E_allele_age, "E_T");
                require_finite_result(S_allele_age, "Std_T");
                for (size_t k = 0; k < raw_moments.size(); k++) {
                    require_finite_result(raw_moments[k],
                                          ("age_raw_moments[" + std::to_string(k) + "]").c_str());
                }
                CLI::OutputFormatter::print_allele_age_results(options, E_allele_age, S_allele_age,
                                                               raw_moments);
                
                delete solver;
                break;
            }
            
            case CLI::ModelType::ESTABLISHMENT: {
                if (options.odds_ratio <= 0) {
                    throw std::runtime_error("--odds-ratio parameter required for establishment calculation");
                }
                
                // Full Wright-Fisher matrix
                WF::Matrix W_full = WF::Single(
                    options.population_size, options.population_size, 
                    WF::BOTH_ABSORBING,
                    options.selection_coefficient, options.dominance,
                    options.backward_mutation, options.forward_mutation,
                    options.recurrent_mutation, options.alpha,
                    options.verbose, options.block_size, options.library
                );
                
                W_full.Q->subtractIdentity();
                llong size = (2 * options.population_size) - 1;
                
                // Create solver for full matrix
                solver::Solver* solver_full = solver::SolverFactory::createSolver(
                    options.library, *W_full.Q, MKL_PARDISO_MATRIX_TYPE_REAL_UNSYMMETRIC, msg_level
                );
                solver_full->preprocess();
                
                // Calculate fixation probabilities for full matrix
                dvec R_full_fix = W_full.R.col(1);
                dvec B_full_fix = solver_full->solve(R_full_fix, false);
                dvec B_full_ext = dvec::Constant(size, 1) - B_full_fix;
                
                // Find the establishment index: the FIRST count whose fixation
                // probability reaches the odds-ratio threshold k/(1+k).
                //
                // establishment.tex defines c* as the count at which fixation
                // becomes more likely than extinction once it is reached
                // (lines 49, 61), i.e. a first-crossing rule. The previous code
                // instead picked the count whose B_fix was CLOSEST to the
                // threshold, which can select a count that has not reached it at
                // all -- e.g. when the nearest value sits just below. B_fix is
                // monotonically increasing in the copy count, so the first
                // crossing is well defined.
                const double est_threshold = options.odds_ratio / (1 + options.odds_ratio);
                llong est_idx = -1;
                for (llong j = 0; j < size; j++) {
                    if (B_full_fix(j) >= est_threshold) { est_idx = j; break; }
                }
                if (est_idx < 0) {
                    throw std::runtime_error(
                        "No establishment count reached the requested odds ratio: even "
                        "2N-1 copies do not achieve a fixation probability of " +
                        std::to_string(est_threshold) + ". Lower -k or change the model");
                }
                // index j corresponds to copy count j+1, so index 0 is count 1
                if (est_idx == 0) {
                    throw std::runtime_error("Establishment is near-certain: establishment-count is 1");
                }
                if (z >= est_idx) {
                    throw std::runtime_error("Establishment can be reached by mutation alone");
                }
                
                // Convert to 1-based index for calculations
                est_idx++;
                double est_freq = (double)(est_idx) / (2 * options.population_size);
                
                // Post-establishment calculations.
                //
                // NOTE (deliberate, frozen): est_idx is now the copy count c*,
                // and the full BOTH_ABSORBING model indexes transient states as
                // index == count - 1, so id_full(est_idx) starts from count
                // c*+1, NOT c*. That is Ivan Krukov's original convention and is
                // preserved here on purpose so this implementation reproduces
                // wfes2; it is not an oversight. It is entangled with the
                // lumping of all states >= c* into a single absorbing state,
                // which makes neither c* nor c*+1 exactly principled. See
                // the establishment-method notes (internal dev notes) -- revisiting this is a
                // deliberate future decision, not a bug fix.
                dvec id_full(size);
                id_full.setZero();
                id_full(est_idx) = 1;
                dvec N1_aft_est = solver_full->solve(id_full, true);
                dvec N2_aft_est = solver_full->solve(N1_aft_est, true);
                
                // Segregation time calculations
                double T_seg = N1_aft_est.sum();
                double T_seg_var = (2 * N2_aft_est.sum() - N1_aft_est.sum()) - pow(N1_aft_est.sum(), 2);
                double T_seg_std = sqrt(T_seg_var);
                
                // Conditional extinction after establishment
                dvec E_seg_ext = B_full_ext.array() * N1_aft_est.array() / B_full_ext(est_idx);
                dvec E_seg_ext_var = B_full_ext.array() * N2_aft_est.array() / B_full_ext(est_idx);
                double T_seg_ext = E_seg_ext.sum();
                double T_seg_ext_var = (2 * E_seg_ext_var.sum() - E_seg_ext.sum()) - pow(E_seg_ext.sum(), 2);
                double T_seg_ext_std = sqrt(T_seg_ext_var);
                
                // Conditional fixation after establishment
                dvec E_seg_fix = B_full_fix.array() * N1_aft_est.array() / B_full_fix(est_idx);
                dvec E_seg_fix_var = B_full_fix.array() * N2_aft_est.array() / B_full_fix(est_idx);
                double T_seg_fix = E_seg_fix.sum();
                double T_seg_fix_var = (2 * E_seg_fix_var.sum() - E_seg_fix.sum()) - pow(E_seg_fix.sum(), 2);
                double T_seg_fix_std = sqrt(T_seg_fix_var);
                
                // Create truncated Wright-Fisher matrix
                WF::Matrix W_tr = WF::Truncated(
                    options.population_size, options.population_size, est_idx,
                    options.selection_coefficient, options.dominance,
                    options.backward_mutation, options.forward_mutation,
                    options.recurrent_mutation, options.alpha,
                    options.verbose, options.block_size, options.library
                );
                
                // Output truncated matrices if requested (using original paths)
                if (!options.output_Q_path.empty()) {
                    W_tr.Q->saveMarket(options.output_Q_path);
                }
                if (!options.output_R_path.empty()) {
                    CLI::OutputFormatter::write_matrix_to_file(W_tr.R, options.output_R_path);
                }
                
                W_tr.Q->subtractIdentity();
                
                // Create solver for truncated matrix
                solver::Solver* solver_tr = solver::SolverFactory::createSolver(
                    options.library, *W_tr.Q, MKL_PARDISO_MATRIX_TYPE_REAL_UNSYMMETRIC, msg_level
                );
                solver_tr->preprocess();
                
                // Calculate establishment probabilities
                dvec R_est = W_tr.R.col(1);
                dvec B_est = solver_tr->solve(R_est, false);
                dvec B_ext = dvec::Ones(est_idx - 1) - B_est;
                
                // Initialize result variables
                double P_ext = 0;
                double P_est = 0;
                double T_est = 0;
                double T_est_var = 0;
                
                // Matrices for calculations
                dmat N_mat(z, est_idx - 1);
                dmat N2_mat(z, est_idx - 1);
                
                dvec id(est_idx - 1);
                if (options.starting_copies < 0) { // Use integration (starting_copies is set to -1 when no -p flag)
                    // Integrate over starting distribution
                    for (llong i = 0; i < z; i++) {
                        double p_i = starting_copies_p(i);
                        id.setZero();
                        id(i) = 1;
                        
                        N_mat.row(i) = solver_tr->solve(id, true);
                        dvec N1 = N_mat.row(i);
                        N2_mat.row(i) = solver_tr->solve(N1, true);
                        dvec N2 = N2_mat.row(i);
                        
                        P_ext += B_ext(i) * p_i;
                        P_est += B_est(i) * p_i;
                        
                        dvec E_est = B_est.array() * N1.array() / B_est(i);
                        dvec E_est_var = B_est.array() * N2.array() / B_est(i);
                        T_est += E_est.sum() * p_i;
                        // Weight the WHOLE per-start variance by p_i. The previous
                        // form, ((2*Ev - E) * p_i) - pow(E * p_i, 2), mixed a
                        // p_i-weighted term with a p_i^2-weighted one and is not
                        // any coherent estimator. This matches the convention used
                        // by absorption mode and by the single -p establishment
                        // path below. (Like those, it accumulates only the
                        // within-starting-state variance; the between-state
                        // component is omitted throughout the codebase, which is a
                        // separate and broader question -- see the review report.)
                        T_est_var += ((2 * E_est_var.sum() - E_est.sum()) - pow(E_est.sum(), 2)) * p_i;
                    }
                } else {
                    // Use specified starting copies
                    id.setZero();
                    id(options.starting_copies) = 1;
                    N_mat.row(0) = solver_tr->solve(id, true);
                    dvec N1 = N_mat.row(0);
                    N2_mat.row(0) = solver_tr->solve(N1, true);
                    dvec N2 = N2_mat.row(0);
                    
                    P_ext = B_ext(options.starting_copies);
                    P_est = B_est(options.starting_copies);
                    
                    dvec E_est = B_est.array() * N1.array() / B_est(options.starting_copies);
                    dvec E_est_var = B_est.array() * N2.array() / B_est(options.starting_copies);
                    T_est = E_est.sum();
                    T_est_var = (2 * E_est_var.sum() - E_est.sum()) - pow(E_est.sum(), 2);
                }
                
                double T_est_std = sqrt(T_est_var);
                
                // Output results
                require_finite_result(est_freq, "est_freq");
                require_finite_result(P_est, "P_est");
                require_finite_result(T_seg, "T_seg");
                require_finite_result(T_seg_std, "T_seg_std");
                require_finite_result(T_seg_ext, "T_seg_ext");
                require_finite_result(T_seg_ext_std, "T_seg_ext_std");
                require_finite_result(T_seg_fix, "T_seg_fix");
                require_finite_result(T_seg_fix_std, "T_seg_fix_std");
                require_finite_result(T_est, "T_est");
                require_finite_result(T_est_std, "T_est_std");
                CLI::OutputFormatter::print_establishment_results(
                    options, est_freq, P_est, T_seg, T_seg_std,
                    T_seg_ext, T_seg_ext_std, T_seg_fix, T_seg_fix_std,
                    T_est, T_est_std
                );
                
                delete solver_full;
                delete solver_tr;
                break;
            }
            
            default:
                throw std::runtime_error("Model type not yet implemented");
        }
        
        // End timing if verbose
        if (options.verbose) {
            t_end = std::chrono::system_clock::now();
            time_diff dt = t_end - t_start;
            std::cout << "Total runtime: " << dt.count() << " s" << std::endl;
        }
        
        return EXIT_SUCCESS;
        
    } catch (const std::exception& e) {
        std::cerr << "Error: " << e.what() << std::endl;
        return EXIT_FAILURE;
    }
}