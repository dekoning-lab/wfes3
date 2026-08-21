#include "solverPardiso.h"

#include <stdexcept>
#include <string>

using namespace wfes::pardiso;

PardisoSolver::PardisoSolver(SparseMatrixPardiso& A, llong matrix_type, llong message_level, llong n_rhs):
        Solver(A),
        size(A.num_rows),
        n_right_hand_sides(n_rhs),
        max_factors(1),
        matrix_type(matrix_type),
        matrix_number(1),
        error(0),
        message_level(message_level),
        control(lvec::Zero(MKL_IFS_SIZE)),
        internal(lvec::Zero(MKL_IFS_SIZE)),
        workspace(dvec::Zero(size * n_rhs))
{
    control(MKL_PARDISO_DEFAULT_SETTINGS) = MKL_PARDISO_FALSE;                                                                  // iparm[0]  = 1
    control(MKL_PARDISO_FILL_IN_REDUCING_ORDERING_OPTION) = MKL_PARDISO_FILL_IN_REDUCING_ORDERING_NESTED_DISSECTION_OMP;        // iparm[1]  = 3
    control(MKL_PARDISO_ITERATIVE_REFINEMENT_MAX) = 0;                                                                          // iparm[7]  = 0
    control(MKL_PARDISO_PIVOTING_PERTURBATION) = 20; // Perturb the pivot elements with 1E-20                                   // iparm[9]  = 20
    control(MKL_PARDISO_SCALING_OPTION) = MKL_PARDISO_SCALING_ENABLE;                                                           // iparm[10] = 1
    control(MKL_PARDISO_SOLVE_OPTION) = MKL_PARDISO_DEFAULT;                                                                    // iparm[11] = 0
    control(MKL_PARDISO_WEIGHTED_MATCHING_OPTION) = MKL_PARDISO_WEIGHTED_MATCHING_ENABLE;                                       // iparm[12] = 1
    control(MKL_PARDISO_PRECISION_OPTION) = MKL_PARDISO_PRECISION_DOUBLE;                                                       // iparm[27] = 0
    control(MKL_PARDISO_INDEXING_OPTION) = MKL_PARDISO_INDEXING_ZERO;                                                           // iparm[34] = 1
    control(MKL_PARDISO_OOC_OPTION) = MKL_PARDISO_OOC_ALWAYS;                                                                   // iparm[59] = 2
    control(MKL_PARDISO_REPORT_NNZ_FACTORS) = MKL_PARDISO_REPORT_ENABLE;                                                        // iparm[17] = -1
    control(MKL_PARDISO_REPORT_FLOP_FACTOR_PHASE) = MKL_PARDISO_REPORT_ENABLE;                                                  // iparm[18] = -1
    control(MKL_PARDISO_REPORT_CGS_CG_DIAGNOSTIC) = MKL_PARDISO_REPORT_ENABLE;                                                  // iparm[19] = -1
    control(MKL_PARDISO_MATRIX_CHECK_OPTION) = MKL_PARDISO_MATRIX_CHECK_ENABLE;                                                 // iparm[26] = 1
    control(MKL_PARDISO_PARALLEL_FACTORIZATION_OPTION) = MKL_PARDISO_PARALLEL_FACTORIZATION_TWO_LEVEL;                          // iparm[23] = 1
    control(MKL_PARDISO_PIVOT_OPTION) = MKL_PARDISO_PIVOT_CALLBACK; // allow calling get_diag                                   // iparm[55] = 1
}

void PardisoSolver::preprocess() {
    phase = MKL_PARDISO_SOLVER_PHASE_ANALYSIS;
    pardiso_64(internal.data(), &max_factors, &matrix_number,
               &matrix_type, &phase, &size,
               dynamic_cast<SparseMatrixPardiso&>(m).data, dynamic_cast<SparseMatrixPardiso&>(m).row_index, dynamic_cast<SparseMatrixPardiso&>(m).cols,
               nullptr, &n_right_hand_sides, control.data(),
               &message_level, nullptr, nullptr, &error);

    if(error != 0) throw std::runtime_error("Pardiso: Symbolic factorization error. Phase " + std::to_string(phase) + ". \n" + this->errorMessage(error));

    phase = MKL_PARDISO_SOLVER_PHASE_NUMERICAL_FACTORIZATION;
    pardiso_64(internal.data(), &max_factors, &matrix_number,
               &matrix_type, &phase, &size,
               dynamic_cast<SparseMatrixPardiso&>(m).data, dynamic_cast<SparseMatrixPardiso&>(m).row_index, dynamic_cast<SparseMatrixPardiso&>(m).cols,
               nullptr, &n_right_hand_sides, control.data(),
               &message_level, nullptr, nullptr, &error);

    if(error != 0) throw std::runtime_error("Pardiso: Numerical factorization error. Phase " + std::to_string(phase) + ". \n" + this->errorMessage(error));
}

dvec PardisoSolver::solve(dvec& b, bool transpose) {
    // pardiso_64 takes the system order and the right-hand-side count from this
    // object, never from b: it reads exactly (size * n_right_hand_sides) doubles
    // starting at b.data() whatever b's actual length is. A caller that passes a
    // mis-sized vector, or that uses this single-RHS entry point on a solver
    // constructed with n_rhs > 1, gets an out-of-bounds read and a
    // plausible-looking but wrong answer instead of a diagnostic.
    //
    // SuiteSparseSolver::solve and ParUSolver::solve already perform the
    // equivalent check. Pardiso had none here, and only a bare assert() in
    // solve_multiple -- which -DNDEBUG strips from release builds, i.e. from
    // every build anyone actually runs.
    //
    // Known caller that trips the second check: wfes-lib's Qt-era
    // executables/wfafs/wfafs.cpp, which builds the fundamental matrix with
    // single-vector solves (line ~211) on a solver constructed with
    // n_rhs = 2*N+1 (line ~114). That path is already reading out of bounds
    // under MKL today; this turns silent corruption into a hard failure.
    if (b.size() != size) {
        throw std::runtime_error(
            "PardisoSolver::solve: right-hand side has length " +
            std::to_string(static_cast<long long>(b.size())) +
            " but the factorized system has order " + std::to_string(size) +
            ". This is a caller bug: solving would read and write out of bounds");
    }
    if (n_right_hand_sides != 1) {
        throw std::runtime_error(
            "PardisoSolver::solve: this solver was constructed for " +
            std::to_string(n_right_hand_sides) +
            " right-hand sides, so the single-vector entry point would read "
            "past the end of b. Use solve_multiple, or construct the solver "
            "with n_rhs = 1");
    }

    phase = MKL_PARDISO_SOLVER_PHASE_SOLVE_ITERATIVE_REFINEMENT;
    if(transpose) control(MKL_PARDISO_SOLVE_OPTION) = MKL_PARDISO_SOLVE_TRANSPOSED;
    else control(MKL_PARDISO_SOLVE_OPTION) = MKL_PARDISO_DEFAULT;

    pardiso_64(internal.data(), &max_factors, &matrix_number,
               &matrix_type, &phase, &size,
               dynamic_cast<SparseMatrixPardiso&>(m).data, dynamic_cast<SparseMatrixPardiso&>(m).row_index, dynamic_cast<SparseMatrixPardiso&>(m).cols,
               nullptr, &n_right_hand_sides, control.data(),
               &message_level, b.data(), workspace.data(), &error);

    if(error != 0) throw std::runtime_error("Pardiso: Solution error. Phase " + std::to_string(phase) + ". \n" + this->errorMessage(error));

    dvec x(size);
    for(llong i = 0; i < size; i++) x(i) = workspace(i);
    return x;
}

dmat PardisoSolver::solve_multiple(dmat& B, bool transpose) {
    // Contract: dmat is RowMajor, so a (n_rhs x order) B is laid out as n_rhs
    // contiguous vectors of length order -- exactly what pardiso_64 expects.
    // The ROWS of B are therefore the right-hand sides, and the result is
    // (order x n_rhs) so that column i is the solution for RHS i.
    // SuiteSparseSolver::solve_multiple was aligned to this contract; these
    // checks make the contract enforced rather than assumed.
    //
    // This was an assert(), which -DNDEBUG removes from release builds. When it
    // is violated, pardiso_64 still runs: it reads the wrong number of doubles
    // from B and the extraction loop below leaves most of X uninitialised, so
    // the failure mode is a silently wrong matrix rather than a crash.
    if (B.rows() != n_right_hand_sides) {
        throw std::runtime_error(
            "PardisoSolver::solve_multiple: B has " +
            std::to_string(static_cast<long long>(B.rows())) +
            " rows but the solver was constructed for " +
            std::to_string(n_right_hand_sides) +
            " right-hand sides. Rows of B are the right-hand sides; pass n_rhs "
            "to SolverFactory::createSolver");
    }
    if (B.cols() != size) {
        throw std::runtime_error(
            "PardisoSolver::solve_multiple: right-hand sides have length " +
            std::to_string(static_cast<long long>(B.cols())) +
            " but the factorized system has order " + std::to_string(size) +
            ". Rows of the input are the right-hand sides");
    }

    phase = MKL_PARDISO_SOLVER_PHASE_SOLVE_ITERATIVE_REFINEMENT;
    if(transpose) control(MKL_PARDISO_SOLVE_OPTION) = MKL_PARDISO_SOLVE_TRANSPOSED;
    else control(MKL_PARDISO_SOLVE_OPTION) = MKL_PARDISO_DEFAULT;

    pardiso_64(internal.data(), &max_factors, &matrix_number,
               &matrix_type, &phase, &size,
               dynamic_cast<SparseMatrixPardiso&>(m).data, dynamic_cast<SparseMatrixPardiso&>(m).row_index, dynamic_cast<SparseMatrixPardiso&>(m).cols,
               nullptr, &n_right_hand_sides, control.data(),
               &message_level, B.data(), workspace.data(), &error);

    if(error != 0) throw std::runtime_error("Pardiso: Solution error. Phase " + std::to_string(phase) + ". \n" + this->errorMessage(error));

    // rows of B are RHS components
    dmat X(B.cols(), B.rows());
    for(llong i = 0; i < n_right_hand_sides; i++) {
        for(llong j = 0; j < size; j++) {
            X(j, i) = workspace(i * size + j);
        }
    }
    return X;
}

dvec PardisoSolver::get_diagonal() {
  dvec d_factorized(size);
  dvec d_initial(size);

  pardiso_getdiag(internal.data(), d_factorized.data(), d_initial.data(), &matrix_number, &error);

  if(error == 1) throw std::runtime_error("Pardiso: Diagonal information not turned on before pardiso main loop: " + std::to_string(error));

  return d_factorized;
}

std::string PardisoSolver::errorMessage(long long code) {
    // Free mkl buffers.
    mkl_free_buffers();
    // Free pardiso memory.
    phase = MKL_PARDISO_SOLVER_PHASE_RELEASE_MEMORY_ALL;
    pardiso_64(internal.data(), &max_factors, &matrix_number,
               &matrix_type, &phase, &size,
               nullptr, dynamic_cast<SparseMatrixPardiso&>(m).row_index, dynamic_cast<SparseMatrixPardiso&>(m).cols,
               nullptr, &n_right_hand_sides, control.data(),
               &message_level, nullptr, nullptr, &error);

    // Return error message.
    switch (code) {
        case -1:
            return "Error Code is " + std::to_string(code) + ". Input inconsistency.";
        case -2:
            return "Error Code is " + std::to_string(code) + ". Not enough memory.";
        case -3:
            return "Error Code is " + std::to_string(code) + ". Reordering problem.";
        case -4:
            return "Error Code is " + std::to_string(code) + ". Zero pivot, numerical factorization or iterative refinement problem.";
        case -5:
            return "Error Code is " + std::to_string(code) + ". Unclassified (internal) error.";
        case -6:
            return "Error Code is " + std::to_string(code) + ". Preordering failed (matrix types 11, 13 only).";
        case -7:
            return "Error Code is " + std::to_string(code) + ". Diagonal matrix is singular.";
        case -8:
            return "Error Code is " + std::to_string(code) + ". 32-bit integer overflow problem.";
        case -9:
            return "Error Code is " + std::to_string(code) + ". Not enough RAM memory.";
        case -10:
            return "Error Code is " + std::to_string(code) + ". Problems with opening OOC temporary files.";
        case -11:
            return "Error Code is " + std::to_string(code) + ". read/write problems with the OOC data file.";
        case 0:
        default:
            return "Error code is " + std::to_string(code) + ". Unknown error.";
    }
}

PardisoSolver::~PardisoSolver()
{
    phase = MKL_PARDISO_SOLVER_PHASE_RELEASE_MEMORY_ALL;
    pardiso_64(internal.data(), &max_factors, &matrix_number,
               &matrix_type, &phase, &size,
               nullptr, dynamic_cast<SparseMatrixPardiso&>(m).row_index, dynamic_cast<SparseMatrixPardiso&>(m).cols,
               nullptr, &n_right_hand_sides, control.data(),
               &message_level, nullptr, nullptr, &error);

}
