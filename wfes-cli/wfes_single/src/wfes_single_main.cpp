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
// cond(I - Q) * eps. Measured solver-level overshoot at representative
// parameters is ulp-scale: worst B_ext excursion 1.33e-15 at N = 200,
// s = -0.09, h = 0.5. (This comment previously cited "B_ext(0) = 1 + 3.4e-11
// at N = 200" as the observed solver overshoot. That figure was never the
// solve: it was the injection-weight renormalizer's cancellation error,
// which showed up in P_ext -- B_ext's own entries were fine -- and it is
// now fixed at source; see the tail-sum note at the default-initial-
// distribution site below.) 1e-8 therefore sits far above the excursions
// actually observed, while still refusing anything that cannot plausibly be
// roundoff of a probability: a value outside [0,1] by more than 1e-8 means
// the solve lost at least half its digits, and nothing downstream of it
// could be trusted either.
constexpr double PROB_RANGE_TOL = 1e-8;

// Ceiling on the MEASURED forward-error bound (solve_error_scale) above which
// a solve certifies nothing about a PROBABILITY it produced, and the run is
// refused rather than the bound being used as a tolerance.
//
// Without a ceiling, `tol = max(PROB_RANGE_TOL, solve_error_scale(...))` grows
// without limit with the conditioning, so a bound large enough to admit ANY
// value at all was still being reported as "solver roundoff, within
// tolerance". Measured on the pre-fix build:
//
//   wfes_single --fixation -N 200 -s -0.05 -h 0.5 --output-B b.txt
//   Note: B: 400 of 400 entries exceeded [0,1], worst excursion 1.05926
//         (solver roundoff, within tolerance 13892.7); clamped to the boundary.
//
// -- 400 clamped 1.0s written at exit 0, under a "solved, within tolerance"
// provenance, from a solve whose own bound was four orders of magnitude wider
// than the range of the quantity. That file is indistinguishable from the
// hardcoded `dvec::Ones(size)` this task removed.
//
// WHY 1e-2. solve_error_scale bounds the ABSOLUTE error of a solve whose
// right-hand side is a column of R, i.e. of B itself. A probability's entire
// range is 1, so a bound of 1e-2 already admits an error of one percent of
// everything the quantity can possibly be: past that line the solve does not
// certify two decimal places of any probability, and for --fixation -- where
// B == 1 exactly and enforce_probability_range then clamps every entry to the
// boundary -- it certifies nothing whatsoever about whether the solve
// reproduced the identity. The line is deliberately drawn an order of
// magnitude BELOW the zero-digit point (a bound of 1 admits every probability
// there is), so the refusal fires while the file is merely uncertifiable
// rather than already pure noise.
//
// Calibrated against the healthy cases the suite pins, using each model's own
// max expected time to absorption (independent GTH reference, see
// require_resolvable_time): N=8 defaults 7.1e-6, N=50 s=0 4.4e-5,
// N=100 s=0.01 3.9e-5, N=500 s=0.001 2.8e-4. 1e-2 clears the worst of those
// by more than an order of magnitude, and refuses the 1.4e4 case above.
constexpr double PROB_SOLVE_ERROR_CEILING = 1e-2;

// The same bound read as a RELATIVE error on an expected time, and the ceiling
// past which not one printed digit of that time is certified.
//
// (I - Q)^-1 is nonnegative with row sums equal to the expected times to
// absorption, so ||(I - Q)^-1||_inf = T_max and the solution vector of a
// time solve has norm ~T_max. The absolute bound 2*n*eps*T_max that
// solve_error_scale returns is therefore, divided by that same T_max, a
// RELATIVE bound on any expected time this factorization produces. At 1.0 the
// bound permits an error as large as the answer: zero significant digits.
//
// This is the principled zero-digit line for a relative bound, not a tuned
// constant. It is conservative -- the a priori bound overestimates the
// realised error by a roughly constant ~1.3e4 on this family (see the table in
// require_resolvable_time), so runs whose answer still holds a few good digits
// are refused along with the ones that hold none. That is the intended
// direction: the tool prints 17 digits and has no way to say "the first four
// of these are real", so a bound that certifies none of them is not a bound to
// print under.
constexpr double TIME_SOLVE_ERROR_CEILING = 1.0;

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

// Refuse non-finite values and values outside [0,1] by more than `tol`;
// clamp roundoff-level excursions into [0,1] with a stderr note (never
// silently).
//
// `tol` defaults to PROB_RANGE_TOL. It is a parameter because one caller
// needs a MEASURED bound rather than the standing constant: in --fixation
// every entry of B is 1 in exact arithmetic, so it sits exactly on the upper
// boundary and any positive solve error puts it outside [0,1]. There the
// tolerance is derived from the conditioning of the system actually solved
// (see solve_error_scale) instead of guessed.
void enforce_probability_range(dvec& B, const char* name,
                               double tol = PROB_RANGE_TOL) {
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
    if (lo < -tol || hi > 1.0 + tol) {
        std::ostringstream os;
        os << std::setprecision(std::numeric_limits<double>::max_digits10)
           << name << " is outside [0,1] by more than the roundoff tolerance "
           << tol << " (min " << lo << ", max " << hi
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
                  << " (solver roundoff, within tolerance " << tol
                  << "); clamped to the boundary." << std::endl;
    }
}

// Refuse an expected first-passage time that the linear solve cannot resolve
// at these parameters.
//
// CORRECTION (task CX1b, fix round 1). The first version of this gate asserted,
// in this comment and in the user-facing diagnostic, that the sojourn sums had
// OVERFLOWED and wrapped negative. That is not what happens, and it cannot be:
// IEEE 754 doubles saturate to +inf, never to a negative, so a sum of
// nonnegative terms cannot come back with a sign -- and if it did reach +inf,
// require_finite_result would already have caught it. The mechanism recorded
// there was wrong, and the wrong mechanism sent users looking for a
// representable-range problem they do not have.
//
// What actually happens, measured against an independent GTH (Grassmann-
// Taksar-Heyman) state-reduction reference implemented in pure Python. GTH is
// entirely subtraction-free for a substochastic M-matrix -- it recovers every
// diagonal it divides by as a SUM of nonnegative off-diagonal and absorption
// probabilities rather than as 1 - Q(k,k) -- and is therefore componentwise
// relative-accurate INDEPENDENT of the condition number. --fixation, N = 200,
// h = 0.5, u = v = 1e-9, T_fix from count 1:
//
//   s        GTH (true)      LU (this tool)    relative error of the LU
//   -0.01    1.35134e+10     1.35134e+10       1.8e-07
//   -0.02    3.93843e+11     3.93845e+11       5.3e-06
//   -0.03    1.56684e+13     1.56718e+13       2.1e-04
//   -0.04    7.31124e+14     7.38436e+14       1.0e-02
//   -0.05    3.79792e+16     7.82089e+16       1.06   <- 0 digits, printed
//   -0.20    4.34509e+45    -7.38341e+16       garbage
//
// Two things follow, and both contradict the overflow story. The true values
// are ALL comfortably representable -- 4.3e45 at s = -0.2 is 260 orders below
// DBL_MAX -- so the quantity is fine and it is the SOLVE that fails. And the
// LU's answer does not track the truth at all once it breaks: it saturates
// near 1/eps in magnitude (7.8e16, -7.4e16) while the true time ranges over
// 1e16 to 1e45. (I - Q) is an M-matrix whose inverse row sums ARE these
// times, so cond_inf(I - Q) ~ 2 * T_max and a plain LU loses digits in
// proportion; GTH gets the same numbers right in the same double precision
// because it never subtracts. The honest diagnosis names the conditioning of
// the solve, not the size of the answer.
//
// Three independent signals, any ONE of which is proof the solve failed:
//
//  (a) a nonpositive value: an expected first-passage time is positive by
//      definition;
//  (b) a negative entry anywhere in the sojourn matrix: each row of N is a row
//      of (I - Q)^-1 = sum_k Q^k, entrywise nonnegative for an M-matrix by
//      construction, so a negative entry is not a rounding of anything. Free
//      -- the matrix is already in hand;
//  (c) the factorization's forward-error bound read as a RELATIVE error on a
//      time, at or above TIME_SOLVE_ERROR_CEILING.
//
// (a) alone was the gate that landed, and it caught only the negative half.
// The s = -0.05 row above is positive, has no negative entry in N, and was
// printed to 17 digits at exit 0 with none of them correct -- which is what
// (c) closes.
void require_resolvable_time(double value, const char* name,
                             const dmat& sojourn, double solve_err,
                             double t_max) {
    std::ostringstream proof;
    proof << std::setprecision(std::numeric_limits<double>::max_digits10);

    if (!std::isfinite(value) || value <= 0) {
        proof << "computed " << name << " is " << value
              << ", which is not a possible expected time: a first-passage "
                 "time is positive by definition";
    } else if (sojourn.size() > 0 && sojourn.minCoeff() < 0.0) {
        proof << "the sojourn solve behind " << name
              << " returned negative entries (smallest " << sojourn.minCoeff()
              << "). Each row of N is a row of (I - Q)^-1 = sum_k Q^k, which is "
                 "entrywise nonnegative for this M-matrix by construction, so a "
                 "negative entry cannot be a rounding of the true value";
    } else if (!(solve_err < TIME_SOLVE_ERROR_CEILING)) {
        proof << "the forward-error bound on the solve behind " << name
              << " is " << solve_err
              << " RELATIVE (2 * n * eps * T_max, with n = " << sojourn.cols()
              << " states and T_max = " << t_max
              << "), at or above " << TIME_SOLVE_ERROR_CEILING
              << ": the bound permits an error as large as the answer, so not "
                 "one of the digits that would be printed is certified";
    } else {
        return;
    }

    std::ostringstream os;
    os << std::setprecision(std::numeric_limits<double>::max_digits10)
       << proof.str()
       << ". This is the CONDITIONING of the (I - Q) solve at these "
          "parameters, not an overflow and not the magnitude of the answer: "
          "the true value is representable in double precision, and a "
          "subtraction-free method reaches it in double precision, but the "
          "sparse LU this tool uses cannot -- cond(I - Q) grows in proportion "
          "to the expected time to absorption, and every backend factorizes "
          "the same matrix, so changing --library will not change this. "
          "Refusing to print a number with no correct digits. Bring the "
          "expected time to absorption within reach of the solve: a smaller "
          "population size, a weaker |selection coefficient|, or larger "
          "mutation rates (the time scales roughly as 1 / (2Nv)) all reduce "
          "the conditioning";
    throw std::runtime_error(os.str());
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

// The absolute error a back-substitution against this factorization can carry
// into an absorption probability.
//
// (I - Q)^-1 is nonnegative for these M-matrix systems and its row sums are
// the expected times to absorption, so ||(I - Q)^-1||_inf = max_j T_abs(j),
// while ||I - Q||_inf <= 2. A standard forward-error bound for a solve is
// about n * eps * cond_inf(A), which is therefore about 2 * n * eps * T_max.
// One extra back-substitution ((I - Q) t = 1) buys the whole bound.
//
// This exists because T_abs can be enormous -- 9.4e8 generations for
// --fixation at N = 8 with default mutation rates -- and at that conditioning
// the solve's own error is ~1e-6, four orders above the standing
// PROB_RANGE_TOL. Comparing such a solve against a fixed 1e-8 would refuse
// perfectly healthy runs; comparing it against nothing would accept anything.
//
// The bound is a TOLERANCE only up to PROB_SOLVE_ERROR_CEILING (probabilities)
// and TIME_SOLVE_ERROR_CEILING (times). Past those it stops being a tolerance
// and becomes the refusal itself: a bound wider than the quantity's own range
// certifies nothing, and using it to wave a value through was the defect those
// two ceilings close. Callers must apply them; this function only measures.
double solve_error_scale(solver::Solver& solver, llong size, double& t_max_out) {
    dvec ones = dvec::Ones(size);
    dvec t = solver.solve(ones, false);
    t_max_out = t.allFinite() ? t.maxCoeff() : std::numeric_limits<double>::infinity();
    // (I - Q)^-1 = sum_k Q^k is entrywise nonnegative for this M-matrix, so
    // every entry of t is a nonnegative expected time by construction. A
    // negative or non-finite one is proof the solve failed -- not evidence
    // about the true value's magnitude.
    //
    // CORRECTION (fix round 1): this used to say the time was "not
    // representable in double precision", which is false at exactly the
    // parameters that reach it. At --fixation -N 200 -s -0.2 -h 0.5 the LU
    // returns all-negative times of magnitude ~7.4e16 while the true maximum,
    // from an independent subtraction-free GTH reference, is 4.35e45 -- 260
    // orders of magnitude below DBL_MAX and perfectly representable. See
    // require_resolvable_time for the measurement table.
    if (!std::isfinite(t_max_out) || t_max_out < 0) {
        std::ostringstream os;
        os << std::setprecision(std::numeric_limits<double>::max_digits10)
           << "the (I - Q) x = 1 solve returned non-finite or negative expected "
              "times (largest entry " << t_max_out
           << "). Those times are the row sums of (I - Q)^-1, which is "
              "entrywise nonnegative for this M-matrix by construction, so this "
              "is proof the linear solve failed at these parameters -- the "
              "CONDITIONING of (I - Q), not the magnitude of the answer, which "
              "is representable and which a subtraction-free method reaches in "
              "the same double precision. Neither the absorption probabilities "
              "nor any expected time can be established from this "
              "factorization. A smaller population size, a weaker |selection "
              "coefficient|, or larger mutation rates all reduce the "
              "conditioning.";
        throw std::runtime_error(os.str());
    }
    return 2.0 * static_cast<double>(size) * t_max_out *
           std::numeric_limits<double>::epsilon();
}

// Solve BOTH absorbing columns of a two-absorbing-state system against an
// existing factorization, and hold the pair to the CX1a evidence standard.
//
// Integrity audit fix (section 1.1), applied wherever the pattern occurs:
// neither vector may be DERIVED from the other. B_a = 1 - B_b caps the
// accuracy of B_a at ~2.2e-16 ABSOLUTE, so whenever the true probability is at
// or below that level the derived entries are pure roundoff -- negative
// probabilities, mixtures above 1, conditional moments conditioned on
// impossible events, nan standard deviations. Solving (I - Q) x = R.col(j)
// directly is one extra back-substitution against the factorization that
// already exists and, because the substitution is subtraction-free for these
// M-matrix systems, it preserves RELATIVE accuracy for arbitrarily small
// probabilities, which is this tool's reason to exist.
//
// B_a + B_b = 1 then becomes a residual DIAGNOSTIC of the solve rather than
// the definition of either vector -- and a real failure mode of its own: the
// two vectors are solved independently against their own right-hand sides, so
// both can individually land inside [0,1] (and so pass
// enforce_probability_range) while the pair is still arbitrarily wrong.
struct AbsorptionPair {
    dvec first;   // R.col(0)
    dvec second;  // R.col(1)
};

AbsorptionPair solve_absorption_pair(solver::Solver& solver, const dmat& R,
                                     llong size, const char* first_name,
                                     const char* second_name) {
    AbsorptionPair out;
    dvec rhs_first = R.col(0);
    dvec rhs_second = R.col(1);
    out.first = solver.solve(rhs_first, false);
    out.second = solver.solve(rhs_second, false);

    const double one_residual =
        (out.first + out.second - dvec::Ones(size)).cwiseAbs().maxCoeff();
    // IEEE 754 trap: every comparison against NaN is false, so a solve that
    // produced NaN entries can make one_residual itself NaN (or, depending on
    // how maxCoeff() treats a NaN entry, silently skip it and return the max
    // of whatever finite entries remain) -- either way
    // `one_residual > PROB_RANGE_TOL` alone would be false and let the worst
    // case (a NaN solve) sail straight through this refusal. Check
    // non-finiteness explicitly; do not simplify this back to a bare `>`.
    if (!std::isfinite(one_residual) || one_residual > PROB_RANGE_TOL) {
        std::ostringstream os;
        os << std::setprecision(std::numeric_limits<double>::max_digits10)
           << "|" << first_name << " + " << second_name << " - 1| = "
           << one_residual << ", exceeding the roundoff tolerance "
           << PROB_RANGE_TOL << ". " << first_name
           << " solves (I - Q) x = R.col(0) and " << second_name
           << " solves (I - Q) x = R.col(1) independently against the same "
              "factorization (integrity audit section 1.1 fix): a residual "
              "this large means that solve failed for these parameters even "
              "though each vector may individually lie inside [0,1]. Refusing "
              "to produce results that cannot be trusted.";
        throw std::runtime_error(os.str());
    }

    enforce_probability_range(out.first, first_name);
    enforce_probability_range(out.second, second_name);
    return out;
}

// E(r, j) = B(j) * N(r, j) / B(start_r): expected generations spent at state j
// before absorption, CONDITIONED on absorption into the state whose
// probability vector is B, starting from starts[r].
//
// Returns false, with a stderr diagnostic naming `flag`, when the anchor
// B(start) of any requested row is below COND_PROB_MIN -- there the division
// turns roundoff into the entire answer, so no file is written rather than a
// file of noise. Nothing non-finite may ever reach an output file.
bool build_conditional_sojourn(const dvec& B, const dmat& N,
                               const std::vector<llong>& starts,
                               const char* flag, const char* b_name,
                               dmat& out) {
    // Row r of N must BE the sojourn row for starts[r]; a mismatch would
    // silently pair each row with the wrong anchor and write a plausible,
    // wrong file. Cheap to assert, impossible to spot in the output.
    if (N.rows() != static_cast<llong>(starts.size()) || B.size() != N.cols()) {
        throw std::runtime_error(
            "internal error: the sojourn matrix, its starting states and the "
            "absorption vector disagree in size, so the conditional sojourn "
            "cannot be formed");
    }
    out.resize(static_cast<llong>(starts.size()), N.cols());
    for (size_t r = 0; r < starts.size(); r++) {
        if (starts[r] < 0 || starts[r] >= B.size()) {
            throw std::runtime_error(
                "internal error: a starting state lies outside the absorption "
                "probability vector, so the conditional sojourn cannot be "
                "anchored");
        }
        const double anchor = B(starts[r]);
        if (!(anchor >= COND_PROB_MIN)) {
            std::cerr << "Note: " << flag << " not written: the conditional "
                         "sojourn divides by " << b_name << " at the starting "
                         "state, which is " << anchor << " (below "
                      << COND_PROB_MIN << ") for at least one requested "
                         "starting state, so every entry would be roundoff "
                         "rather than a sojourn time." << std::endl;
            return false;
        }
        out.row(r) = B.array() * N.row(r).transpose().array() / anchor;
    }
    if (!out.allFinite()) {
        std::cerr << "Note: " << flag << " not written: the conditional "
                     "sojourn matrix is not finite for these parameters."
                  << std::endl;
        return false;
    }
    return true;
}

// The starting-state vector this run ACTUALLY uses, over the model's own
// state space.
//
// Integrity audit fix (section 3.1): --output-I used to be written before
// -p / -c were applied, so every run recorded the full mutational injection
// distribution -- byte-identical whether -p was given or not, and in every
// mode, including modes whose state space is not the transient interior.
// `index_of_first_weight` is where the branch actually puts
// starting_copies_p(0): the transient index (0) in the both-absorbing models,
// the copy count (starting_copies_start) in --fixation, where index == count.
dvec used_initial_vector(const CLI::CommandLineOptions& options, llong size,
                         const dvec& starting_copies_p,
                         llong index_of_first_weight, llong z) {
    dvec v = dvec::Zero(size);
    if (options.starting_copies >= 0) {
        // -p collapses the distribution to a delta; the parser has already
        // mapped the count to this model's index convention.
        if (options.starting_copies >= size) {
            std::ostringstream os;
            os << "the starting state index " << options.starting_copies
               << " is outside this model's state space of " << size
               << " states; --output-I cannot record it";
            throw std::runtime_error(os.str());
        }
        v(options.starting_copies) = 1.0;
        return v;
    }
    for (llong i = 0; i < z && i < starting_copies_p.size(); i++) {
        const llong idx = index_of_first_weight + i;
        if (idx < 0 || idx >= size) {
            std::ostringstream os;
            os << "the starting distribution reaches state index " << idx
               << ", outside this model's state space of " << size
               << " states; --output-I cannot record it";
            throw std::runtime_error(os.str());
        }
        v(idx) = starting_copies_p(i);
    }
    return v;
}

// ---------------------------------------------------------------------------
// Per-mode scope of the --output-* flags (integrity audit section 3.1).
//
// Every one of the nine flags was parsed in every one of the seven modes, and
// a mode that does not compute the quantity simply never read the path: no
// file, no warning, exit 0. 24 of the 63 cells behaved that way with no
// scoping documented anywhere, and 14 more (--output-E / --output-V outside
// their documented single mode) were accepted just as silently. A recorded
// analysis pipeline cannot tell that apart from success.
//
// Now every cell is one of exactly two things: the mode produces the quantity
// and writes it, or asking for it is an error that names the mode. Nothing is
// accepted and dropped.
// ---------------------------------------------------------------------------

enum OutIdx { OUT_Q, OUT_R, OUT_N, OUT_N_EXT, OUT_N_FIX, OUT_B, OUT_I, OUT_E,
              OUT_V, OUT_COUNT };

const char* const OUT_FLAG[OUT_COUNT] = {
    "--output-Q", "--output-R", "--output-N", "--output-N-ext",
    "--output-N-fix", "--output-B", "--output-I", "--output-E", "--output-V"};

const std::string& out_path(const CLI::CommandLineOptions& o, int idx) {
    switch (idx) {
        case OUT_Q:     return o.output_Q_path;
        case OUT_R:     return o.output_R_path;
        case OUT_N:     return o.output_N_path;
        case OUT_N_EXT: return o.output_N_ext_path;
        case OUT_N_FIX: return o.output_N_fix_path;
        case OUT_B:     return o.output_B_path;
        case OUT_I:     return o.output_I_path;
        case OUT_E:     return o.output_E_path;
        default:        return o.output_V_path;
    }
}

const char* mode_flag(CLI::ModelType m) {
    switch (m) {
        case CLI::ModelType::ABSORPTION:    return "--absorption";
        case CLI::ModelType::FIXATION:      return "--fixation";
        case CLI::ModelType::ESTABLISHMENT: return "--establishment";
        case CLI::ModelType::FUNDAMENTAL:   return "--fundamental";
        case CLI::ModelType::EQUILIBRIUM:   return "--equilibrium";
        case CLI::ModelType::NON_ABSORBING: return "--non-absorbing";
        case CLI::ModelType::ALLELE_AGE:    return "--allele-age";
    }
    return "(unknown model)";
}

// Reasons, shared by every cell that refuses for the same modelling reason.
constexpr const char* WHY_NO_ABSORBING =
    "this model has no absorbing state -- it is the bare transition matrix "
    "over counts 0..2N -- so it has no absorption probabilities, no "
    "fundamental matrix and no expected time to absorption";
constexpr const char* WHY_EQUILIBRIUM_NO_ABSORBING =
    "--equilibrium solves for the stationary distribution of a chain with no "
    "absorbing state, so there is no absorption probability, no fundamental "
    "matrix and no time to absorption to write";
constexpr const char* WHY_FIXATION_NO_EXTINCTION =
    "--fixation makes fixation the only absorbing state; extinction (count 0) "
    "is a transient state of this model, so it has no "
    "extinction-conditional sojourn";
constexpr const char* WHY_EST_LUMPED =
    "the establishment model lumps every count at or above the establishment "
    "threshold into one absorbing state, so its two absorbing states are "
    "extinction and ESTABLISHMENT, not fixation; neither conditional-sojourn "
    "flag names a quantity this model computes (--output-N gives the "
    "unconditional sojourns and --output-B the two absorption probabilities)";
constexpr const char* WHY_NO_START =
    "this model does not use a starting distribution -- its result does not "
    "depend on where the population starts -- so there is no initial "
    "distribution to record";
constexpr const char* WHY_E_SCOPE =
    "--output-E writes the stationary distribution, which only --equilibrium "
    "computes";
constexpr const char* WHY_V_SCOPE =
    "--output-V writes the variance-time matrix, which is built from the "
    "fundamental matrix and only --fundamental computes";

// nullptr => the mode produces this quantity. Otherwise the reason it does
// not, quoted verbatim in the refusal.
struct ModeOutputRow {
    CLI::ModelType mode;
    const char* reason[OUT_COUNT];
};

// One entry per line, in OutIdx order, with the flag named in the comment.
// Written out longhand on purpose: aggregate initialization pads a short
// initializer list with zeros, and a zero here reads as nullptr, which means
// "this mode produces the quantity" -- so a dropped entry would silently turn
// a refusal back into the silent no-op this table exists to remove. The
// suite in baseline_tests/test_single_output_matrix.py checks all 63 cells.
const ModeOutputRow OUTPUT_SCOPE[] = {
    {CLI::ModelType::ABSORPTION, {
        nullptr,                        // --output-Q
        nullptr,                        // --output-R
        nullptr,                        // --output-N
        nullptr,                        // --output-N-ext
        nullptr,                        // --output-N-fix
        nullptr,                        // --output-B
        nullptr,                        // --output-I
        WHY_E_SCOPE,                    // --output-E
        WHY_V_SCOPE,                    // --output-V
    }},
    {CLI::ModelType::FIXATION, {
        nullptr,                        // --output-Q
        nullptr,                        // --output-R
        nullptr,                        // --output-N
        WHY_FIXATION_NO_EXTINCTION,     // --output-N-ext
        nullptr,                        // --output-N-fix
        nullptr,                        // --output-B
        nullptr,                        // --output-I
        WHY_E_SCOPE,                    // --output-E
        WHY_V_SCOPE,                    // --output-V
    }},
    {CLI::ModelType::FUNDAMENTAL, {
        nullptr,                        // --output-Q
        nullptr,                        // --output-R
        nullptr,                        // --output-N
        nullptr,                        // --output-N-ext
        nullptr,                        // --output-N-fix
        nullptr,                        // --output-B
        nullptr,                        // --output-I  (only with -p; see below)
        WHY_E_SCOPE,                    // --output-E
        nullptr,                        // --output-V
    }},
    {CLI::ModelType::EQUILIBRIUM, {
        nullptr,                        // --output-Q  (the solving matrix)
        WHY_EQUILIBRIUM_NO_ABSORBING,   // --output-R
        WHY_EQUILIBRIUM_NO_ABSORBING,   // --output-N
        WHY_EQUILIBRIUM_NO_ABSORBING,   // --output-N-ext
        WHY_EQUILIBRIUM_NO_ABSORBING,   // --output-N-fix
        WHY_EQUILIBRIUM_NO_ABSORBING,   // --output-B
        WHY_NO_START,                   // --output-I
        nullptr,                        // --output-E
        WHY_V_SCOPE,                    // --output-V
    }},
    {CLI::ModelType::ESTABLISHMENT, {
        nullptr,                        // --output-Q  (truncated system)
        nullptr,                        // --output-R  (truncated system)
        nullptr,                        // --output-N  (truncated system)
        WHY_EST_LUMPED,                 // --output-N-ext
        WHY_EST_LUMPED,                 // --output-N-fix
        nullptr,                        // --output-B  ([B_ext, B_est])
        nullptr,                        // --output-I
        WHY_E_SCOPE,                    // --output-E
        WHY_V_SCOPE,                    // --output-V
    }},
    {CLI::ModelType::ALLELE_AGE, {
        nullptr,                        // --output-Q
        nullptr,                        // --output-R
        nullptr,                        // --output-N
        nullptr,                        // --output-N-ext
        nullptr,                        // --output-N-fix
        nullptr,                        // --output-B
        nullptr,                        // --output-I
        WHY_E_SCOPE,                    // --output-E
        WHY_V_SCOPE,                    // --output-V
    }},
    {CLI::ModelType::NON_ABSORBING, {
        nullptr,                        // --output-Q
        WHY_NO_ABSORBING,               // --output-R
        WHY_NO_ABSORBING,               // --output-N
        WHY_NO_ABSORBING,               // --output-N-ext
        WHY_NO_ABSORBING,               // --output-N-fix
        WHY_NO_ABSORBING,               // --output-B
        WHY_NO_START,                   // --output-I
        WHY_E_SCOPE,                    // --output-E
        WHY_V_SCOPE,                    // --output-V
    }},
};

const ModeOutputRow& scope_row(CLI::ModelType m) {
    for (const auto& row : OUTPUT_SCOPE) {
        if (row.mode == m) return row;
    }
    // A model type with no row would fall through check_output_flag_scope
    // entirely, which is the silent-acceptance behaviour this table replaces.
    // Fail loudly instead of defaulting to "everything is supported".
    throw std::runtime_error(
        "internal error: no --output-* scope is defined for this model type, "
        "so the output flags cannot be validated");
}

// Refuse every requested --output-* flag the selected mode does not produce,
// before any matrix is built or any file is opened, so a refused run leaves
// nothing behind.
void check_output_flag_scope(const CLI::CommandLineOptions& options) {
    const ModeOutputRow& row = scope_row(options.model_type);
    for (int i = 0; i < OUT_COUNT; i++) {
        if (out_path(options, i).empty() || row.reason[i] == nullptr) continue;
        std::vector<const char*> available;
        for (const auto& other : OUTPUT_SCOPE) {
            if (other.reason[i] == nullptr) available.push_back(mode_flag(other.mode));
        }
        std::ostringstream os;
        os << OUT_FLAG[i] << " is not produced by " << mode_flag(options.model_type)
           << ": " << row.reason[i] << ". Available in: ";
        if (available.empty()) {
            os << "(no model)";
        } else {
            for (size_t k = 0; k < available.size(); k++) {
                os << (k ? ", " : "") << available[k];
            }
        }
        os << ".";
        throw std::runtime_error(os.str());
    }

    // --fundamental takes its starting state from -p and refuses --initial, so
    // without -p it uses no starting distribution at all: it computes the whole
    // matrix. The flag is in scope for the mode, but not for that variant of it.
    if (options.model_type == CLI::ModelType::FUNDAMENTAL &&
        !options.output_I_path.empty() && options.starting_copies < 0) {
        throw std::runtime_error(
            "--output-I is not produced by --fundamental without -p: with no "
            "starting count the mode computes the whole fundamental matrix and "
            "uses no starting distribution, so there is nothing to record. "
            "Give -p <count> (which selects one row of N) to write it.");
    }

    // The stationary distribution is a property of the chain, not of where the
    // population started. Both parameters used to be parsed and range-checked
    // here and then discarded, which told the user they had changed the model
    // when they had not: the output is byte-identical with and without them.
    if (options.model_type == CLI::ModelType::EQUILIBRIUM) {
        if (options.starting_copies >= 0) {
            throw std::runtime_error(
                "-p / --starting-copies does not apply to --equilibrium: the "
                "stationary distribution of the Wright-Fisher chain does not "
                "depend on the starting state, so this parameter cannot change "
                "the result. Drop it, or choose a model that has a starting "
                "state (--absorption, --fixation, --fundamental, --allele-age, "
                "--establishment).");
        }
        if (!options.initial_distribution_path.empty()) {
            throw std::runtime_error(
                "--initial does not apply to --equilibrium: the stationary "
                "distribution of the Wright-Fisher chain does not depend on the "
                "starting distribution, so this file cannot change the result. "
                "Drop it, or choose a model that integrates over a starting "
                "distribution (--absorption, --fixation, --allele-age, "
                "--establishment).");
        }
    }
}

// Results with optional fields. Mirrors the corresponding
// OutputFormatter::print_*_results exactly (same field order, same layout,
// same stream so the same precision), minus the omitted fields. The shared
// formatter keeps the all-fields path so healthy runs are byte-identical;
// this local variant exists only because a field may now be honestly absent,
// and the shared formatter (owned by another remediation task) has fixed
// all-fields signatures.
struct AbsorptionField {
    const char* name;               // JSON key and CSV column header
    std::optional<double> value;
    // Plain-text label, when the shared formatter's differs from `name`.
    // Only --establishment needs this: output_formatter.cpp prints
    // "Est. freq. = " where the JSON/CSV key is "est_freq" (every other field
    // in every other mode prints its own name). Without it, a run that omitted
    // one establishment field silently relabelled a row of the plain-text
    // output, so the same quantity had two names depending on whether some
    // OTHER field was reportable.
    const char* label = nullptr;
};

void print_results_partial(const CLI::CommandLineOptions& options,
                           const char* model,
                           const std::vector<AbsorptionField>& fields) {
    size_t n_present = 0;
    for (const auto& f : fields) n_present += f.value.has_value();
    if (options.json_output) {
        std::cout << "{" << std::endl;
        std::cout << "  \"model\": \"" << model << "\"," << std::endl;
        // Solver-backend provenance, exactly as the shared formatter's
        // all-fields path emits it -- this variant differs only in which
        // RESULT fields it may omit (see the struct comment above), and the
        // parameters block is not a result.
        std::cout << CLI::OutputFormatter::library_provenance_json_block(
            options.library);
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
            if (f.value) {
                std::cout << (f.label ? f.label : f.name) << " = " << *f.value
                          << std::endl;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Matrix-mode status output (integrity audit section 5.3a, validated NF-3).
//
// --fundamental without -p and --non-absorbing produce a MATRIX, not a table
// of scalars: the mode's whole product leaves through --output-N / --output-V
// / --output-Q. The shared formatter reported that as a fixed "... completed"
// message under --json and as ZERO BYTES with exit 0 under --csv. A zero-byte
// success is indistinguishable from a crashed pipe, and the fixed message says
// nothing about whether anything was actually written.
//
// Both formats now report the same facts: the dimensions computed, and the
// path each matrix went to (or that it went nowhere). No numbers are invented
// to fill the space -- the fields describe the run, and a run that wrote
// nothing says so.
// ---------------------------------------------------------------------------
struct StatusField {
    const char* name;
    std::string value;      // empty means "not written"
    bool numeric;
};

// Escape a string for a JSON string literal.
//
// Mirrors OutputFormatter's json_escape (output_formatter.cpp, landed in
// 9ebf5eb) rather than handling only the three characters this file happened
// to hit. The values that pass through here are user-supplied paths, and a
// path may legally contain any byte except '/' and NUL on a POSIX filesystem
// -- a tab or a stray control byte in one used to be copied through verbatim,
// producing JSON that a strict parser rejects (RFC 8259 forbids unescaped
// U+0000..U+001F inside a string). Every control character is emitted as a
// \uXXXX escape, which is valid for all of them.
std::string json_escape(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (char c : s) {
        if (c == '"' || c == '\\') {
            out += '\\';
            out += c;
        } else if (static_cast<unsigned char>(c) < 0x20) {
            std::ostringstream os;
            os << "\\u" << std::hex << std::setw(4) << std::setfill('0')
               << static_cast<int>(static_cast<unsigned char>(c));
            out += os.str();
        } else {
            out += c;
        }
    }
    return out;
}

void print_matrix_mode_status(const CLI::CommandLineOptions& options,
                              const char* model, const std::string& message,
                              const std::vector<StatusField>& fields) {
    if (options.json_output) {
        std::cout << "{" << std::endl;
        std::cout << "  \"model\": \"" << model << "\"," << std::endl;
        std::cout << CLI::OutputFormatter::library_provenance_json_block(
            options.library);
        std::cout << "  \"results\": {" << std::endl;
        std::cout << "    \"message\": \"" << json_escape(message) << "\"";
        for (const auto& f : fields) {
            std::cout << "," << std::endl << "    \"" << f.name << "\": ";
            if (f.value.empty()) std::cout << "null";
            else if (f.numeric) std::cout << f.value;
            else std::cout << "\"" << json_escape(f.value) << "\"";
        }
        std::cout << std::endl << "  }" << std::endl << "}" << std::endl;
    } else if (options.csv_output) {
        std::cout << "field,value" << std::endl;
        std::cout << "message,\"" << message << "\"" << std::endl;
        for (const auto& f : fields) {
            std::cout << f.name << ",";
            if (f.value.empty()) std::cout << std::endl;
            else if (f.numeric) std::cout << f.value << std::endl;
            else std::cout << "\"" << f.value << "\"" << std::endl;
        }
    } else {
        std::cout << message << std::endl;
        for (const auto& f : fields) {
            std::cout << f.name << " = "
                      << (f.value.empty() ? "(not written)" : f.value) << std::endl;
        }
    }
}

// --fundamental WITH a starting state has real data to report, and the shared
// formatter emitted the fixed "Fundamental matrix calculation completed"
// message as the first key of that same results object (validated NEW FINDING
// 3). A consumer that keys off the presence of "message" to detect a no-data
// run misclassifies every successful -p run. The message belongs to the
// no-data variant only, which print_matrix_mode_status now handles; this path
// reports the data and nothing else.
void print_fundamental_sojourn(const CLI::CommandLineOptions& options,
                               const dvec& sojourn, double T_abs) {
    if (options.json_output) {
        std::cout << "{" << std::endl;
        std::cout << "  \"model\": \"fundamental\"," << std::endl;
        std::cout << CLI::OutputFormatter::library_provenance_json_block(
            options.library);
        std::cout << "  \"results\": {" << std::endl;
        std::cout << "    \"T_abs\": " << std::setprecision(17) << T_abs << ","
                  << std::endl;
        std::cout << "    \"sojourn_times\": [";
        for (llong i = 0; i < sojourn.size(); i++) {
            if (i) std::cout << ", ";
            std::cout << std::setprecision(17) << sojourn(i);
        }
        std::cout << "]" << std::endl;
        std::cout << "  }" << std::endl << "}" << std::endl;
    } else if (options.csv_output) {
        std::cout << "count,sojourn_time" << std::endl;
        for (llong i = 0; i < sojourn.size(); i++) {
            std::cout << (i + 1) << "," << std::setprecision(17) << sojourn(i)
                      << std::endl;
        }
    } else {
        std::cout << "Fundamental matrix calculation completed." << std::endl;
        std::cout << "Results saved to output files (if specified)." << std::endl;
        std::cout << "Expected time to absorption from the starting distribution: "
                  << T_abs << std::endl;
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

        // Every --output-* flag the selected model does not produce, and every
        // starting-state parameter the selected model cannot honour, is
        // refused HERE: before any matrix is built, any solver runs, or any
        // file is opened, so a refused run leaves nothing behind and costs
        // nothing.
        check_output_flag_scope(options);

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
            
            // Condition on at least one copy appearing: drop the count-0 entry
            // and renormalize over counts >= 1 -- by the tail's own sum, NOT by
            // 1 - first_row(0). first_row(0) is 1 - O(2Nv), so that subtraction
            // cancels to roundoff (relative error up to ~eps/(2*2Nv): ~3e-11 at
            // N = 200 with v = 1e-9, and growing as 2Nv shrinks), and the error
            // rescaled EVERY injection-integrated output (P_ext, P_fix, T_abs,
            // ...) as a common factor -- the old P_ext = 1 + 3.4e-11 headline
            // artifact at N = 200 was exactly this factor. binom_row sum-
            // normalizes the row, so the tail sum IS 1 - first_row(0), computed
            // from small same-sign entries with no cancellation; the weights
            // then sum to 1 at machine precision by construction.
            starting_copies_p = first_row.tail(first_row.size() - 1);
            starting_copies_p /= starting_copies_p.sum();
            starting_copies_start = first_row_start + 1; // Skip the 0 copies
        }
        
        // NOTE: --output-I is deliberately NOT written here. It used to be,
        // 24 lines above the -c / -p collapse below, so the file recorded the
        // full mutational injection distribution no matter what the run
        // actually used: byte-identical with and without -p, in every mode,
        // over a state space that is not even the right length for three of
        // them (integrity audit section 3.1, validated claim 8 / NF-5). Each
        // branch now writes the vector its own model uses, over its own state
        // space, after the collapse and after every refusal below -- see
        // used_initial_vector.


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
                //
                // Sourced from the same function that fills the machine-readable
                // library_effective field, so this text line and every --json /
                // --csv provenance record in the eleven tools can never disagree
                // about the same run. It therefore prints the name
                // Args_Parser::supported_libraries() uses ("SuiteSparse") rather
                // than the solver class's own longer label ("SuiteSparse
                // (UMFPACK)"): one vocabulary for the backend everywhere.
                if (options.verbose) {
                    std::cout << "  Library (in use):    "
                              << CLI::OutputFormatter::library_provenance(
                                     options.library).effective
                              << std::endl;
                }

                // Conditioning of THIS factorization, measured once and shared
                // by every gate below. One extra back-substitution
                // ((I - Q) t = 1) against a factorization that already exists;
                // the factorization itself dominates the cost.
                //
                // Measured UNCONDITIONALLY, not only when --output-B was asked
                // for. It used to sit inside the need_B block, which is how the
                // tool came to give two different verdicts on the same run: at
                // -N 200 -s -0.05 -h 0.5 the bound is ~1.4e4, and the run
                // refused or printed 17 digits of garbage depending on whether
                // a --output-B path happened to be on the command line. The
                // conditioning of the solve is a property of the parameters,
                // not of which files the user asked for.
                double t_max = 0;
                const double solve_err = solve_error_scale(*solver, size, t_max);

                // Absorption probabilities for this model.
                //
                // Integrity audit fix (section 5.3c): --output-B used to write
                // `dvec::Ones(size)` -- a literal, never solved. With fixation
                // the only absorbing state, absorption into it IS certain, so
                // the vector is analytically 1; but the file said so on the
                // authority of a hardcoded constant, and nothing in it, in the
                // help text or in the output disclosed that. It is now SOLVED
                // against the factorization that already exists, which makes
                // the file a measurement of the identity rather than an
                // assertion of it -- and makes --output-N-fix (the same
                // conditional sojourn every other absorbing model reports)
                // computable here too.
                //
                // The tolerance is measured, not assumed: every entry of B sits
                // exactly on the upper boundary of [0,1], so any positive solve
                // error puts it outside, and T_abs for this model runs to ~1e9
                // generations at default mutation rates, where the solve's own
                // error is ~1e-6. See solve_error_scale.
                //
                // ... but a measured tolerance still needs a CEILING, which the
                // first version of this did not have. Because B == 1 here and
                // enforce_probability_range clamps to the boundary, an
                // uncapped tolerance turns a total solve failure into a file of
                // 400 exactly-1.0 entries at exit 0 -- byte-identical to the
                // hardcoded ones-vector this whole change replaced, and carrying
                // a "solved, within tolerance" provenance it has not earned.
                // See PROB_SOLVE_ERROR_CEILING.
                const bool need_B = !options.output_B_path.empty() ||
                                    !options.output_N_fix_path.empty();
                dvec B_fix_only;
                if (need_B) {
                    if (W.R.cols() < 1) {
                        throw std::runtime_error(
                            "this model has no absorbing-state column R, so "
                            "there is no absorption probability vector to solve "
                            "for");
                    }
                    if (!(solve_err < PROB_SOLVE_ERROR_CEILING)) {
                        std::ostringstream os;
                        os << std::setprecision(std::numeric_limits<double>::max_digits10)
                           << "the absorption probability B cannot be certified "
                              "at these parameters: the forward-error bound on "
                              "the solve that produces it is " << solve_err
                           << " (2 * n * eps * T_max, with n = " << size
                           << " states and a max expected time to absorption of "
                           << t_max << "), while B is a probability whose entire "
                              "range is 1. A bound wider than "
                           << PROB_SOLVE_ERROR_CEILING
                           << " certifies fewer than two decimal places of any "
                              "probability, and here -- where B = 1 exactly and "
                              "the range guard clamps to the boundary -- it "
                              "certifies nothing at all: every entry would be "
                              "written as exactly 1.0 whether the solve "
                              "succeeded or failed. This is the CONDITIONING of "
                              "(I - Q) at these parameters, not roundoff: "
                              "cond(I - Q) grows in proportion to the expected "
                              "time to absorption, and every --library backend "
                              "factorizes the same matrix. Refusing to write a "
                              "vector the solve cannot vouch for. A smaller "
                              "population size, a weaker |selection "
                              "coefficient|, or larger mutation rates all "
                              "reduce the conditioning.";
                        throw std::runtime_error(os.str());
                    }
                    const double b_tol = std::max(PROB_RANGE_TOL, solve_err);
                    dvec R_fix = W.R.col(0);
                    B_fix_only = solver->solve(R_fix, false);
                    if (!B_fix_only.allFinite()) {
                        throw std::runtime_error(
                            "the absorption-probability solve returned "
                            "non-finite values for these parameters");
                    }
                    const double worst = (B_fix_only - dvec::Ones(size)).cwiseAbs().maxCoeff();
                    if (!std::isfinite(worst) || worst > b_tol) {
                        std::ostringstream os;
                        os << std::setprecision(std::numeric_limits<double>::max_digits10)
                           << "the solved absorption probability B departs from "
                              "1 by " << worst << ", beyond the " << b_tol
                           << " a solve of this conditioning can explain "
                              "(max expected time to absorption " << t_max
                           << "). With fixation the only absorbing state, "
                              "absorption is certain from every transient "
                              "state, so B = 1 exactly: a departure this large "
                              "means the linear solve failed for these "
                              "parameters. Refusing to write a vector that "
                              "cannot be trusted.";
                        throw std::runtime_error(os.str());
                    }
                    enforce_probability_range(B_fix_only, "B", b_tol);
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

                    // Gate BEFORE anything is written. Every file below comes
                    // out of the same factorization as T_fix, so if the solve
                    // cannot resolve T_fix it cannot resolve N, B or N-fix
                    // either -- refusing after writing them would leave
                    // uncertifiable artefacts on disk at a nonzero exit, which
                    // is exactly the "refuse but litter" shape this task fixed
                    // in --establishment.
                    require_resolvable_time(T_fix, "T_fix", N_mat, solve_err, t_max);
                    require_finite_result(T_std, "T_std");
                    require_finite_result(rate, "rate");

                    // Output N matrix if requested
                    if (!options.output_N_path.empty()) {
                        CLI::OutputFormatter::write_matrix_to_file(N_mat, options.output_N_path);
                    }

                    // Output B vector if requested (solved above, not asserted)
                    if (!options.output_B_path.empty()) {
                        CLI::OutputFormatter::write_vector_to_file(B_fix_only, options.output_B_path);
                    }

                    // Fixation-conditional sojourn. Absorption into fixation is
                    // certain here, so conditioning on it changes nothing in
                    // exact arithmetic -- but the file is computed from the
                    // solved B, not copied from N, so it carries the same
                    // evidence as every other mode's.
                    if (!options.output_N_fix_path.empty()) {
                        dmat E_fix_mat;
                        if (build_conditional_sojourn(B_fix_only, N_mat,
                                                      {options.starting_copies},
                                                      "--output-N-fix", "B", E_fix_mat)) {
                            CLI::OutputFormatter::write_matrix_to_file(
                                E_fix_mat, options.output_N_fix_path);
                        }
                    }

                    if (!options.output_I_path.empty()) {
                        CLI::OutputFormatter::write_vector_to_file(
                            used_initial_vector(options, size, starting_copies_p,
                                                starting_copies_start, z),
                            options.output_I_path);
                    }

                    // Output results (gated above, before the files went out)
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
                    std::vector<llong> starts;

                    // Integrate over starting number of copies
                    for (llong i = 0; i < z; i++) {
                        llong actual_copy_num = starting_copies_start + i;
                        starts.push_back(actual_copy_num);
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

                    // Gate BEFORE anything is written -- see the single-start
                    // branch above for why the refusal has to come first.
                    require_resolvable_time(T_fix, "T_fix", N_mat, solve_err, t_max);
                    require_finite_result(T_std, "T_std");
                    require_finite_result(rate, "rate");

                    // Output N matrix if requested
                    if (!options.output_N_path.empty()) {
                        CLI::OutputFormatter::write_matrix_to_file(N_mat, options.output_N_path);
                    }

                    // Output B vector if requested (solved above, not asserted)
                    if (!options.output_B_path.empty()) {
                        CLI::OutputFormatter::write_vector_to_file(B_fix_only, options.output_B_path);
                    }

                    if (!options.output_N_fix_path.empty()) {
                        dmat E_fix_mat;
                        if (build_conditional_sojourn(B_fix_only, N_mat, starts,
                                                      "--output-N-fix", "B", E_fix_mat)) {
                            CLI::OutputFormatter::write_matrix_to_file(
                                E_fix_mat, options.output_N_fix_path);
                        }
                    }

                    if (!options.output_I_path.empty()) {
                        CLI::OutputFormatter::write_vector_to_file(
                            used_initial_vector(options, size, starting_copies_p,
                                                starting_copies_start, z),
                            options.output_I_path);
                    }

                    // Output results (gated above, before the files went out)
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
                // BOTH absorption vectors against the same factorization --
                // neither derived from the other. See solve_absorption_pair for
                // the integrity-audit section 1.1 reasoning and the residual
                // policy it enforces.
                AbsorptionPair BB = solve_absorption_pair(*solver, W.R, size,
                                                          "B_ext", "B_fix");
                dvec& B_ext = BB.first;
                dvec& B_fix = BB.second;

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
                if (!options.output_I_path.empty()) {
                    CLI::OutputFormatter::write_vector_to_file(
                        used_initial_vector(options, size, starting_copies_p, 0, z),
                        options.output_I_path);
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
                    print_results_partial(options, "absorption", {
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

                // --output-Q used to be parsed and dropped in this mode. The
                // matrix this branch builds and factorizes is not the plain
                // Wright-Fisher transition matrix: EquilibriumSolvingMatrix
                // assembles I - P over counts 0..2N and then overwrites the
                // last column with ones, the normalization constraint that
                // makes the stationary system square. Writing it is far more
                // useful than dropping the flag, but it is a different object
                // from the --output-Q of every other mode, so say so at the
                // point of use rather than leaving the file to be
                // misinterpreted later.
                if (!options.output_Q_path.empty()) {
                    W.Q->saveMarket(options.output_Q_path);
                    std::cerr << "Note: --output-Q in --equilibrium writes the "
                                 "equilibrium SOLVING matrix over counts 0..2N "
                                 "(I - P with its last column replaced by the "
                                 "normalization constraint), not the "
                                 "Wright-Fisher transition matrix. Use "
                                 "--non-absorbing --output-Q for the transition "
                                 "matrix itself." << std::endl;
                }

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

                // Output results. This mode's entire product is the matrix, so
                // the report says what was built and where it went. Under
                // --csv the shared formatter emitted ZERO BYTES with exit 0
                // (integrity audit section 5.3a), which a pipeline cannot tell
                // apart from a killed process.
                {
                    const llong q_size = (2 * options.population_size) + 1;
                    print_matrix_mode_status(
                        options, "non_absorbing",
                        "Non-absorbing matrix construction completed. This model "
                        "has no absorbing state, so it reports no probabilities "
                        "or times; the transition matrix is its whole product.",
                        {{"matrix_rows", std::to_string(q_size), true},
                         {"matrix_cols", std::to_string(q_size), true},
                         {"output_Q", options.output_Q_path, false}});
                }
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
                //
                // The rows this run is reporting on, for the conditional
                // sojourns below: the one -p row, or every row of the matrix.
                std::vector<llong> fund_starts;
                dmat N_out;
                if (one_row) {
                    fund_starts.push_back(options.starting_copies);
                    N_out.resize(1, size);
                    N_out.row(0) = sojourn;
                } else {
                    for (llong i = 0; i < size; i++) fund_starts.push_back(i);
                    N_out = N;
                }
                if (!options.output_N_path.empty()) {
                    CLI::OutputFormatter::write_matrix_to_file(N_out, options.output_N_path);
                }

                // Absorption probabilities and the two absorption-conditional
                // sojourn matrices.
                //
                // Integrity audit fix (section 3.1): --output-B, --output-N-ext
                // and --output-N-fix were parsed here and never read, so asking
                // for them produced no file and exit 0 -- and the GUI's
                // fundamental view asks for the two conditional matrices by
                // name, so its "Write N_ext / N_fix" checkboxes silently did
                // nothing. All three are one or two extra back-substitutions
                // against the factorization this branch already built, on top
                // of the N it already has.
                if (!options.output_B_path.empty() ||
                    !options.output_N_ext_path.empty() ||
                    !options.output_N_fix_path.empty()) {
                    AbsorptionPair BB = solve_absorption_pair(*solver, W.R, size,
                                                              "B_ext", "B_fix");
                    if (!options.output_B_path.empty()) {
                        dmat B(size, 2);
                        B.col(0) = BB.first;
                        B.col(1) = BB.second;
                        CLI::OutputFormatter::write_matrix_to_file(B, options.output_B_path);
                    }
                    if (!options.output_N_ext_path.empty()) {
                        dmat E;
                        if (build_conditional_sojourn(BB.first, N_out, fund_starts,
                                                      "--output-N-ext", "B_ext", E)) {
                            CLI::OutputFormatter::write_matrix_to_file(
                                E, options.output_N_ext_path);
                        }
                    }
                    if (!options.output_N_fix_path.empty()) {
                        dmat E;
                        if (build_conditional_sojourn(BB.second, N_out, fund_starts,
                                                      "--output-N-fix", "B_fix", E)) {
                            CLI::OutputFormatter::write_matrix_to_file(
                                E, options.output_N_fix_path);
                        }
                    }
                }

                if (!options.output_I_path.empty()) {
                    // check_output_flag_scope has already refused the no--p
                    // variant, where this mode uses no starting distribution.
                    CLI::OutputFormatter::write_vector_to_file(
                        used_initial_vector(options, size, starting_copies_p, 0, z),
                        options.output_I_path);
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

                // Output results.
                //
                // Integrity audit fix (section 5.3a, validated NEW FINDING 3):
                // with -p this mode has real data, and the shared formatter
                // put the fixed "Fundamental matrix calculation completed"
                // message in the same results object, so a consumer keying off
                // "message" to detect a no-data run misclassified every
                // successful one. Without -p the mode's whole product is the
                // matrix, and --csv emitted zero bytes with exit 0. Data path
                // and status path are now separate, and the status names the
                // dimensions and the destination of everything written.
                if (sojourn.size() > 0) {
                    require_finite_result(T_abs_total, "T_abs");
                    print_fundamental_sojourn(options, sojourn, T_abs_total);
                } else {
                    print_matrix_mode_status(
                        options, "fundamental",
                        "Fundamental matrix calculation completed. No starting "
                        "count was given (-p), so there are no per-start sojourn "
                        "times to report; the matrix is this run's whole product.",
                        {{"matrix_rows", std::to_string(size), true},
                         {"matrix_cols", std::to_string(size), true},
                         {"output_N", options.output_N_path, false},
                         {"output_V", options.output_V_path, false},
                         {"output_B", options.output_B_path, false},
                         {"output_N_ext", options.output_N_ext_path, false},
                         {"output_N_fix", options.output_N_fix_path, false}});
                }

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

                // The rows of the fundamental matrix this run touches, and the
                // starting states they belong to. M1 IS row `start` of
                // (I - Q)^-1, so --output-N costs nothing beyond keeping it:
                // the flag was parsed and dropped here, producing no file and
                // exit 0 (integrity audit section 3.1).
                std::vector<llong> aa_starts;
                dmat aa_N;

                if (options.starting_copies < 0) { // Use integration (starting_copies is set to -1 when no -p flag)

                    aa_N.resize(z, size);
                    // Integrate over starting distribution
                    for (llong i = 0; i < z; i++) {
                        dvec e_p = dvec::Zero(size);
                        e_p(i) = 1;

                        dvec M1 = solver->solve(e_p, true);
                        dvec M2 = solver->solve(M1, true);

                        aa_starts.push_back(i);
                        aa_N.row(i) = M1;

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

                    aa_starts.push_back(options.starting_copies);
                    aa_N.resize(1, size);
                    aa_N.row(0) = M1;

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
                
                // Matrix and vector outputs. The allele-age model is the same
                // BOTH_ABSORBING Wright-Fisher chain every other absorbing mode
                // uses, so the sojourn matrix, the two absorption probabilities
                // and the two conditional sojourns are all defined here and all
                // fall out of the factorization already built -- yet all five
                // flags were parsed and dropped.
                if (!aa_N.allFinite()) {
                    throw std::runtime_error(
                        "the sojourn-time solve returned non-finite values for "
                        "these parameters");
                }
                if (!options.output_N_path.empty()) {
                    CLI::OutputFormatter::write_matrix_to_file(aa_N, options.output_N_path);
                }
                if (!options.output_B_path.empty() ||
                    !options.output_N_ext_path.empty() ||
                    !options.output_N_fix_path.empty()) {
                    AbsorptionPair BB = solve_absorption_pair(*solver, W_solver.R, size,
                                                              "B_ext", "B_fix");
                    if (!options.output_B_path.empty()) {
                        dmat B(size, 2);
                        B.col(0) = BB.first;
                        B.col(1) = BB.second;
                        CLI::OutputFormatter::write_matrix_to_file(B, options.output_B_path);
                    }
                    if (!options.output_N_ext_path.empty()) {
                        dmat E;
                        if (build_conditional_sojourn(BB.first, aa_N, aa_starts,
                                                      "--output-N-ext", "B_ext", E)) {
                            CLI::OutputFormatter::write_matrix_to_file(
                                E, options.output_N_ext_path);
                        }
                    }
                    if (!options.output_N_fix_path.empty()) {
                        dmat E;
                        if (build_conditional_sojourn(BB.second, aa_N, aa_starts,
                                                      "--output-N-fix", "B_fix", E)) {
                            CLI::OutputFormatter::write_matrix_to_file(
                                E, options.output_N_fix_path);
                        }
                    }
                }
                if (!options.output_I_path.empty()) {
                    CLI::OutputFormatter::write_vector_to_file(
                        used_initial_vector(options, size, starting_copies_p, 0, z),
                        options.output_I_path);
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
                
                // Absorption probabilities of the FULL model. Both columns are
                // solved; neither is derived from the other.
                //
                // Integrity audit fix (section 1.1, applied to this branch by
                // task CX1b): B_full_ext used to be `1 - B_full_fix`, the same
                // subtraction that produced impossible probabilities in
                // --absorption. It matters most exactly where this mode is
                // used: the establishment index is the first count whose
                // fixation probability reaches k/(1+k), so B_full_ext at that
                // index is about 1/(1+k) BY CONSTRUCTION, and every
                // conditional-on-extinction segregation moment divides by it.
                // The subtraction caps that anchor's absolute accuracy at
                // ~eps, i.e. its RELATIVE accuracy at ~(1+k)*eps: measured
                // against an independent dense reference at N = 100, s = 0.5,
                // the printed T_seg_ext lost 4 significant digits at
                // --odds-ratio 1e12 (7.1e-4 relative) and T_seg_ext_std 4.5e-3,
                // while the direct solve reproduces the reference to 1.3e-16 /
                // 2.2e-16 / 2.0e-16 in T_seg_ext at --odds-ratio 1e6 / 1e9 /
                // 1e12 and to 1.5e-15 / 0 / 9.5e-16 in T_seg_ext_std -- i.e. to
                // the last bit, not to "~1e-9". (The 1e-9 in the earlier
                // wording was the loosest figure in the measurement table, not
                // the direct solve's accuracy; the test gate is set at 1e-12,
                // which separates the two methods at every odds ratio tested.)
                AbsorptionPair BB_full = solve_absorption_pair(
                    *solver_full, W_full.R, size, "B_full_ext", "B_full_fix");
                dvec& B_full_ext = BB_full.first;
                dvec& B_full_fix = BB_full.second;


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
                        std::to_string(est_threshold) + ". Lower --odds-ratio or change the model");
                }
                // index j corresponds to copy count j+1, so index 0 is count 1
                if (est_idx == 0) {
                    throw std::runtime_error("Establishment is near-certain: establishment-count is 1");
                }
                if (z >= est_idx) {
                    // This guard is load-bearing: the integration loop below
                    // writes id(i) for i = 0..z-1 into a vector of length
                    // est_idx - 1, so z == est_idx is a one-past-the-end write.
                    // Keep it -- but say what it is.
                    //
                    // Integrity audit fix (section 5.3d): the message used to be
                    // "Establishment can be reached by mutation alone", a
                    // statement about the MODEL, for what is really a range
                    // condition on the run. With --initial it is structurally
                    // unsatisfiable -- z is then 2N-1 while est_idx <= 2N-1 --
                    // so every --establishment --initial run failed with a
                    // sentence about mutation that had nothing to do with the
                    // file the user supplied.
                    std::ostringstream os;
                    if (!options.initial_distribution_path.empty()) {
                        os << "--initial is not supported by --establishment: a "
                              "supplied distribution spans all 2N-1 = " << size
                           << " transient states, while this model integrates "
                              "only over states BELOW the establishment count "
                              "(" << est_idx << " here), so the two can never be "
                              "compatible. Use -p <count> to start from a single "
                              "count below " << est_idx << ", or omit both and "
                              "integrate over the mutational injection "
                              "distribution.";
                    } else {
                        os << "the starting distribution spans " << z
                           << " counts, reaching the establishment count "
                           << est_idx
                           << ": this model integrates only over states below "
                              "establishment, so there is nothing left to "
                              "integrate over. Raise -c to narrow the starting "
                              "distribution, give -p <count> below " << est_idx
                           << ", or raise --odds-ratio so establishment needs more copies.";
                    }
                    throw std::runtime_error(os.str());
                }
                
                // Convert to 1-based index for calculations
                est_idx++;
                double est_freq = (double)(est_idx) / (2 * options.population_size);

                // -p must lie inside the TRUNCATED state space, and this has to
                // be settled HERE -- the moment est_idx is known and before
                // anything is built, solved or written.
                //
                // Fix round 1: this guard used to sit ~160 lines further down,
                // after WF::Truncated was built and after --output-Q /
                // --output-R had already been written from it. A refusal that
                // leaves files behind is not a refusal: measured on the
                // pre-fix build, `--establishment -N 8 -s 0.05 -h 0.5 -p 10
                // --output-Q leak.mtx` exited 1 with leak.mtx on disk, so a
                // rejected run still produced an artefact a user could pick up
                // and analyse. Nothing between est_idx and that old position
                // was needed to decide this: the condition is a range check on
                // -p against est_idx alone.
                //
                // The check itself is load-bearing (validated NEW FINDING, §4):
                // -p is range-checked by the parser against the FULL model's
                // 1..2N-1, but this branch indexes vectors of length
                // est_idx - 1, so any count at or above the establishment
                // threshold indexed one past the end. On macOS that aborts on
                // an Eigen assertion (SIGABRT, no message naming the
                // parameter); in a Release build with NDEBUG the assertion
                // compiles out and it is a genuine out-of-bounds write.
                // The post-establishment start must exist in the FULL model.
                //
                // NEW FINDING (fix round 1, found while verifying the -p guard
                // below). The frozen convention immediately after this starts
                // the post-establishment calculation at index est_idx of a
                // vector of length `size` = 2N-1 -- count c*+1. When the odds
                // threshold is first crossed at the LAST transient count
                // (pre-increment est_idx == size - 1, so c* == 2N-1), that
                // index is one past the end and there is no such state: c*+1
                // IS fixation, which is absorbing, not transient.
                //
                // Reproduced at --establishment -N 5 -s 0.05 -h 0.5
                // --odds-ratio 10, where est_idx == size == 9. Unoptimised
                // build: SIGABRT on the Eigen bounds assertion, exit 134, no
                // message naming a parameter. Release build (-DNDEBUG, which
                // is now the default -- commit bd0bc2e -- and is what ships):
                // the assertion is compiled out, id_full(est_idx) = 1 writes
                // past the end, B_full_ext(est_idx) and B_full_fix(est_idx)
                // read past it, and the run PRINTS
                //
                //   Est. freq. = 0.9   P_est = 0.131484
                //   T_seg = 0   T_seg_std = 0   T_est = 14.1072
                //
                // at exit 0. The two zeros are not results: id_full never got
                // its 1, so the sojourn solve returned the zero vector. The
                // two "B ... is 0 (below 1e-300)" notes on stderr are reads of
                // whatever follows the vector in memory.
                //
                // This does NOT touch the c*+1 convention, which is deliberate
                // and frozen (see the note below): it refuses the case where
                // that convention has no state to point at.
                if (est_idx >= size) {
                    std::ostringstream os;
                    os << "the establishment count is " << est_idx
                       << ", the largest count below fixation at 2N = "
                       << (2 * options.population_size)
                       << ". This model measures segregation AFTER "
                          "establishment, starting one copy above the "
                          "establishment count, and that state is fixation "
                          "itself -- an absorbing state, not a transient one, "
                          "so there is no post-establishment segregation to "
                          "measure. Nothing here is computable rather than "
                          "merely small. Lower --odds-ratio so establishment "
                          "is reached before the last count, or use a larger "
                          "population size or a stronger selection "
                          "coefficient.";
                    throw std::runtime_error(os.str());
                }

                if (options.starting_copies >= est_idx - 1) {
                    // -p omitted is starting_copies == -1, which cannot reach
                    // this: est_idx - 1 >= 1 here (est_idx == 0 was refused
                    // above, then incremented), so the integration case falls
                    // through to the z >= est_idx guard that already covers it.
                    std::ostringstream os;
                    os << "-p / --starting-copies " << (options.starting_copies + 1)
                       << " is at or above the establishment count " << est_idx
                       << ", but this model only follows the population UP TO "
                          "establishment: its state space is counts 1.."
                       << (est_idx - 1) << ". Give a starting count below "
                       << est_idx << ", or raise --odds-ratio so establishment "
                          "needs more copies.";
                    throw std::runtime_error(os.str());
                }

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
                
                if (!N1_aft_est.allFinite() || !N2_aft_est.allFinite()) {
                    throw std::runtime_error(
                        "the post-establishment sojourn solve returned "
                        "non-finite values for these parameters");
                }

                // Segregation time calculations
                double T_seg = N1_aft_est.sum();
                double T_seg_var = (2 * N2_aft_est.sum() - N1_aft_est.sum()) - pow(N1_aft_est.sum(), 2);
                double T_seg_std = sqrt(T_seg_var);

                // Conditional segregation times after establishment. Each
                // divides by its own absorption probability at the
                // post-establishment starting index; below COND_PROB_MIN that
                // division turns roundoff into the whole answer, so the family
                // is OMITTED with a diagnostic rather than printed (the CX1a
                // convention, applied here).
                std::optional<double> out_T_seg_ext, out_T_seg_ext_std,
                    out_T_seg_fix, out_T_seg_fix_std;
                if (B_full_ext(est_idx) >= COND_PROB_MIN) {
                    dvec E_seg_ext = B_full_ext.array() * N1_aft_est.array() / B_full_ext(est_idx);
                    dvec E_seg_ext_var = B_full_ext.array() * N2_aft_est.array() / B_full_ext(est_idx);
                    out_T_seg_ext = E_seg_ext.sum();
                    double T_seg_ext_var = (2 * E_seg_ext_var.sum() - E_seg_ext.sum()) - pow(E_seg_ext.sum(), 2);
                    if (T_seg_ext_var >= 0) {
                        out_T_seg_ext_std = sqrt(T_seg_ext_var);
                    } else {
                        std::cerr << "Note: the T_seg_ext variance came out "
                                     "negative at double precision "
                                     "(cancellation; computed " << T_seg_ext_var
                                  << "). Omitting T_seg_ext_std." << std::endl;
                    }
                } else {
                    std::cerr << "Note: conditional-on-extinction segregation "
                                 "moments are numerically meaningless here: "
                                 "B_full_ext at the post-establishment starting "
                                 "state is " << B_full_ext(est_idx) << " (below "
                              << COND_PROB_MIN << "), and every conditional "
                                 "moment divides by it. Omitting T_seg_ext and "
                                 "T_seg_ext_std." << std::endl;
                }

                if (B_full_fix(est_idx) >= COND_PROB_MIN) {
                    dvec E_seg_fix = B_full_fix.array() * N1_aft_est.array() / B_full_fix(est_idx);
                    dvec E_seg_fix_var = B_full_fix.array() * N2_aft_est.array() / B_full_fix(est_idx);
                    out_T_seg_fix = E_seg_fix.sum();
                    double T_seg_fix_var = (2 * E_seg_fix_var.sum() - E_seg_fix.sum()) - pow(E_seg_fix.sum(), 2);
                    if (T_seg_fix_var >= 0) {
                        out_T_seg_fix_std = sqrt(T_seg_fix_var);
                    } else {
                        std::cerr << "Note: the T_seg_fix variance came out "
                                     "negative at double precision "
                                     "(cancellation; computed " << T_seg_fix_var
                                  << "). Omitting T_seg_fix_std." << std::endl;
                    }
                } else {
                    std::cerr << "Note: conditional-on-fixation segregation "
                                 "moments are numerically meaningless here: "
                                 "B_full_fix at the post-establishment starting "
                                 "state is " << B_full_fix(est_idx) << " (below "
                              << COND_PROB_MIN << "), and every conditional "
                                 "moment divides by it. Omitting T_seg_fix and "
                                 "T_seg_fix_std." << std::endl;
                }


                // Create truncated Wright-Fisher matrix
                WF::Matrix W_tr = WF::Truncated(
                    options.population_size, options.population_size, est_idx,
                    options.selection_coefficient, options.dominance,
                    options.backward_mutation, options.forward_mutation,
                    options.recurrent_mutation, options.alpha,
                    options.verbose, options.block_size, options.library
                );
                
                // Output truncated matrices if requested (using original paths).
                // These are the TRUNCATED system's matrices -- dimension
                // est_idx - 1, with everything at or above the establishment
                // count lumped into one absorbing state -- not the full model's,
                // which is what --output-Q and --output-R mean in every other
                // mode. That was deliberate but undisclosed (validated NEW
                // FINDING 6): a recorded --output-Q artefact from an
                // establishment run is a different object from one produced by
                // any other mode, and nothing in the file or the help text said
                // so. Say it at the point of use.
                if (!options.output_Q_path.empty() || !options.output_R_path.empty()) {
                    std::cerr << "Note: --output-Q/--output-R in --establishment "
                                 "write the TRUNCATED system (" << (est_idx - 1)
                              << " transient states, everything at or above the "
                                 "establishment count " << est_idx
                              << " lumped into one absorbing state), not the "
                                 "full Wright-Fisher model over 2N-1 = " << size
                              << " transient states." << std::endl;
                }
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

                // Absorption probabilities of the TRUNCATED system: both
                // columns solved, neither derived. R.col(0) is the jump-to-count-0
                // (extinction) column and R.col(1) the collapsed
                // at-or-above-establishment column (wrightFisher.cpp, WF::Truncated).
                //
                // Integrity audit fix (section 1.1, CX1b): B_ext was
                // `1 - B_est` here too. It feeds only P_ext, which this mode
                // never prints -- but solving it directly is what makes
                // B_est + B_ext = 1 available as a residual DIAGNOSTIC on this
                // factorization, and that diagnostic guards T_est, which IS
                // printed. A derived complement cannot fail that test by
                // construction, so it certified nothing.
                AbsorptionPair BB_tr = solve_absorption_pair(
                    *solver_tr, W_tr.R, est_idx - 1, "B_ext", "B_est");
                dvec& B_ext = BB_tr.first;
                dvec& B_est = BB_tr.second;


                // Initialize result variables
                double P_ext = 0;
                double P_est = 0;
                double T_est = 0;
                double T_est_var = 0;
                
                // Matrices for calculations
                dmat N_mat(z, est_idx - 1);
                dmat N2_mat(z, est_idx - 1);
                
                // Every starting state whose establishment probability anchors a
                // conditional moment must be resolvable in double precision.
                // T_est divides by B_est(start), so an anchor below
                // COND_PROB_MIN makes the whole quantity roundoff -- refuse
                // rather than print it. (Unlike the segregation families above,
                // T_est has no reportable sibling to fall back to: P_est and
                // T_est come from the same solve.)
                {
                    std::vector<llong> est_starts;
                    if (options.starting_copies < 0) {
                        for (llong i = 0; i < z; i++) est_starts.push_back(i);
                    } else {
                        est_starts.push_back(options.starting_copies);
                    }
                    for (llong st : est_starts) {
                        // The range of every starting state was settled the
                        // moment est_idx was known, above, and before anything
                        // was built or written -- see the -p guard there.
                        // Keep the invariant asserted here anyway: this is the
                        // line that actually indexes B_est, and an out-of-range
                        // index is an out-of-bounds read that NDEBUG would
                        // compile the Eigen assertion out of.
                        if (st < 0 || st >= B_est.size()) {
                            throw std::runtime_error(
                                "internal error: a starting state lies outside "
                                "the truncated model's establishment "
                                "probability vector");
                        }
                        if (!(B_est(st) >= COND_PROB_MIN)) {
                            std::ostringstream os;
                            os << std::setprecision(std::numeric_limits<double>::max_digits10)
                               << "the establishment probability at starting "
                                  "state " << (st + 1) << " is " << B_est(st)
                               << ", below " << COND_PROB_MIN
                               << ". T_est is the expected time to establishment "
                                  "CONDITIONED on establishing, so it divides by "
                                  "that probability: at this magnitude the "
                                  "quotient is roundoff, not a time. Refusing to "
                                  "print it.";
                            throw std::runtime_error(os.str());
                        }
                    }
                }

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

                // Matrix and vector outputs. This branch computed N_mat, B_est
                // and B_ext and then discarded all three: --output-N and
                // --output-B were parsed and never read (the integrity audit's
                // "worst case" for section 3.1), so asking for them produced no
                // file and exit 0.
                if (!N_mat.allFinite() || !N2_mat.allFinite()) {
                    throw std::runtime_error(
                        "the truncated-system sojourn solve returned non-finite "
                        "values for these parameters");
                }
                if (!options.output_N_path.empty()) {
                    CLI::OutputFormatter::write_matrix_to_file(N_mat, options.output_N_path);
                }
                if (!options.output_B_path.empty()) {
                    std::cerr << "Note: --output-B in --establishment writes the "
                                 "TRUNCATED system's two absorption "
                                 "probabilities, [B_ext, B_est] -- extinction and "
                                 "ESTABLISHMENT -- not the full model's "
                                 "[B_ext, B_fix]." << std::endl;
                    dmat B(est_idx - 1, 2);
                    B.col(0) = B_ext;
                    B.col(1) = B_est;
                    CLI::OutputFormatter::write_matrix_to_file(B, options.output_B_path);
                }
                if (!options.output_I_path.empty()) {
                    CLI::OutputFormatter::write_vector_to_file(
                        used_initial_vector(options, est_idx - 1, starting_copies_p, 0, z),
                        options.output_I_path);
                }

                // Output results
                require_finite_result(est_freq, "est_freq");
                require_finite_result(P_est, "P_est");
                require_finite_result(T_seg, "T_seg");
                require_finite_result(T_seg_std, "T_seg_std");
                require_finite_result(T_est, "T_est");
                require_finite_result(T_est_std, "T_est_std");
                for (const auto& f : {std::make_pair("T_seg_ext", out_T_seg_ext),
                                      std::make_pair("T_seg_ext_std", out_T_seg_ext_std),
                                      std::make_pair("T_seg_fix", out_T_seg_fix),
                                      std::make_pair("T_seg_fix_std", out_T_seg_fix_std)}) {
                    if (f.second) require_finite_result(*f.second, f.first);
                }
                if (out_T_seg_ext && out_T_seg_ext_std && out_T_seg_fix &&
                    out_T_seg_fix_std) {
                    // Every field computable: through the shared formatter,
                    // byte-identical to what it always printed.
                    CLI::OutputFormatter::print_establishment_results(
                        options, est_freq, P_est, T_seg, T_seg_std,
                        *out_T_seg_ext, *out_T_seg_ext_std,
                        *out_T_seg_fix, *out_T_seg_fix_std,
                        T_est, T_est_std
                    );
                } else {
                    print_results_partial(options, "establishment", {
                        // "Est. freq." is the plain-text label the shared
                        // formatter uses for this field; the JSON/CSV key stays
                        // "est_freq". See AbsorptionField::label.
                        {"est_freq", est_freq, "Est. freq."}, {"P_est", P_est},
                        {"T_seg", T_seg}, {"T_seg_std", T_seg_std},
                        {"T_seg_ext", out_T_seg_ext},
                        {"T_seg_ext_std", out_T_seg_ext_std},
                        {"T_seg_fix", out_T_seg_fix},
                        {"T_seg_fix_std", out_T_seg_fix_std},
                        {"T_est", T_est}, {"T_est_std", T_est_std},
                    });
                }

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