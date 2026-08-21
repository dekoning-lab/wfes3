#include "solverSuiteSparse.h"
#include <iostream>
#include <cmath>
#include <stdexcept>
#include <cstdlib>
#ifdef OMP
#include <omp.h>
#endif

#ifdef WFES_USE_ACCELERATE
#include "model/sparse-matrix/accelerate/sparseMatrixAccelerate.h"
#endif


namespace wfes {
namespace solver {

SuiteSparseSolver::SuiteSparseSolver(SparseMatrix& A) 
    : Solver(A), symbolic_factorization(nullptr), numeric_factorization(nullptr),
      analyzed(false), factorized(false), msg_level(0) {
    
    
    // Get matrix dimensions
    n_rows = m.num_rows;
    n_cols = m.num_cols;
    
    // Initialize control structures
    control.resize(UMFPACK_CONTROL);
    info.resize(UMFPACK_INFO);
    umfpack_di_defaults(control.data());
    control[UMFPACK_PRL] = msg_level;
    
    if (msg_level > 0) {
        std::cout << "SuiteSparseSolver: Initialized UMFPACK solver for " 
                  << n_rows << "x" << n_cols << " matrix" << std::endl;
    }
}

SuiteSparseSolver::~SuiteSparseSolver() {
    if (symbolic_factorization) {
        umfpack_di_free_symbolic(&symbolic_factorization);
    }
    if (numeric_factorization) {
        umfpack_di_free_numeric(&numeric_factorization);
    }
}

void SuiteSparseSolver::preprocess() {
    // Preprocess performs both symbolic and numeric factorization
    factorize();
}

void SuiteSparseSolver::analyze() {
    if (analyzed) return;
    
    // Starting symbolic analysis (silent)
    
    // Try to use efficient CSR to CSC conversion if using Accelerate backend
    #ifdef WFES_USE_ACCELERATE
    // Check if the matrix is an Accelerate sparse matrix
    auto* accel_matrix = dynamic_cast<wfes::sparsematrix::SparseMatrixAccelerate*>(&m);
    if (accel_matrix) {
        // Ensure matrix is finalized before conversion
        accel_matrix->finalizeConstruction();
        
        // Use efficient CSR to CSC conversion
        accel_matrix->convertToCSC(col_pointers, row_indices, values);
        nnz = values.size();
        
        // Converted CSR to CSC format efficiently (silent)
    } else {
        // Fall back to dense conversion
        if (msg_level > 0) {
            std::cout << "SuiteSparseSolver: Warning - using dense conversion (inefficient)" << std::endl;
        }
        convertFromDense();
    }
    #else
    // No Accelerate, use dense conversion
    convertFromDense();
    #endif
    
    // Perform symbolic factorization
    int status = umfpack_di_symbolic(n_rows, n_cols, col_pointers.data(), 
                                     row_indices.data(), values.data(), 
                                     &symbolic_factorization, control.data(), 
                                     info.data());
    
    checkUmfpackStatus(status, "symbolic factorization");
    
    // Symbolic analysis complete (silent)
    
    analyzed = true;
}

void SuiteSparseSolver::factorize() {
    if (!analyzed) {
        analyze();
    }
    
    if (factorized) return;
    
    // Starting numeric factorization (silent)
        
        // Perform numeric factorization
        int status = umfpack_di_numeric(col_pointers.data(), row_indices.data(), 
                                        values.data(), symbolic_factorization, 
                                        &numeric_factorization, control.data(), 
                                        info.data());
        
        checkUmfpackStatus(status, "numeric factorization");
        
        // Numeric factorization complete (silent)
        
    factorized = true;
}

dvec SuiteSparseSolver::solve(dvec& b, bool transpose) {
    ensureFactorized();

    // UMFPACK takes the system order from the factorized matrix, not from the
    // vectors, so a caller-side dimension error is not detected by the library:
    // it reads n_rows doubles from b and writes n_rows doubles to x regardless
    // of their actual length. Without this check a mis-sized RHS becomes silent
    // heap corruption with a plausible-looking result, which is exactly how
    // wfes_sweep ran for its entire history (2N-length vectors against a 4N+1
    // system). ParUSolver::solve already performs this check; SuiteSparse did
    // not.
    if (b.size() != n_rows) {
        throw std::runtime_error(
            "SuiteSparseSolver::solve: right-hand side has length " +
            std::to_string(b.size()) + " but the factorized system has order " +
            std::to_string(n_rows) +
            ". This is a caller bug: solving would read and write out of bounds");
    }

    dvec x(b.size());

    if (msg_level > 1) {
        std::cout << "SuiteSparseSolver: Solving system with RHS size " 
                  << b.size() << std::endl;
        std::cout << "  RHS sample: ";
        for (int i = 0; i < std::min(5, static_cast<int>(b.size())); i++) {
            std::cout << b[i] << " ";
        }
        std::cout << std::endl;
        std::cout << "  Transpose: " << (transpose ? "true" : "false") << std::endl;
    }
    
    // Solve the system
    int sys = transpose ? UMFPACK_At : UMFPACK_A;
        
        int status = umfpack_di_solve(sys, col_pointers.data(), row_indices.data(), 
                                      values.data(), x.data(), b.data(), 
                                      numeric_factorization, control.data(), 
                                      info.data());
        
        checkUmfpackStatus(status, "solve");
        
        if (msg_level > 1) {
            std::cout << "SuiteSparseSolver: Solution complete" << std::endl;
            std::cout << "  Solution sample: ";
            for (int i = 0; i < std::min(5, static_cast<int>(x.size())); i++) {
                std::cout << x[i] << " ";
            }
            std::cout << std::endl;
        }
    
    return x;
}

dmat SuiteSparseSolver::solve_multiple(dmat& b, bool transpose) {
    ensureFactorized();

    // Contract, matching PardisoSolver::solve_multiple which this replaces on
    // macOS: the ROWS of b are the right-hand sides, each of length equal to the
    // system order, and the result is (order x n_rhs) so that column i is the
    // solution for RHS i.
    //
    // This previously treated the COLUMNS of b as right-hand sides and returned
    // (b.rows() x b.cols()). Both the orientation and the shape were wrong.
    // Callers pass a rectangular b, so the two conventions only coincide when
    // b is square -- which is why wfafs_stochastic worked for a single epoch
    // (n_rhs == system order) and aborted with an Eigen Block assertion for two
    // or more, its actual purpose. Under the old code each solve also ran with a
    // vector shorter than the system order, i.e. hundreds of out-of-bounds
    // accesses before the assertion fired.
    if (b.cols() != n_rows) {
        throw std::runtime_error(
            "SuiteSparseSolver::solve_multiple: right-hand sides have length " +
            std::to_string(b.cols()) + " but the factorized system has order " +
            std::to_string(n_rows) +
            ". Rows of the input are the right-hand sides");
    }

    dmat x(b.cols(), b.rows());   // (order x n_rhs)
    for (int i = 0; i < b.rows(); ++i) {
        dvec bi = b.row(i);
        dvec xi = solve(bi, transpose);
        x.col(i) = xi;
    }

    return x;
}

void SuiteSparseSolver::checkUmfpackStatus(int status, const std::string& operation) {
    if (status == UMFPACK_OK) {
        return;
    }
    
    std::string error_msg = "UMFPACK " + operation + " failed: ";
    
    switch (status) {
        case UMFPACK_WARNING_singular_matrix:
            // Deliberately a hard error.
            //
            // This case previously returned as success, with the comment "This
            // is expected for Q-matrices, so we'll allow it", printing a warning
            // only when msg_level > 0 (i.e. only under --verbose). A singular
            // factorization then yielded NaN entries that were formatted as
            // ordinary scientific results with exit status 0 -- the worst
            // failure mode available to a tool whose output goes into papers.
            //
            // The premise was also false. (I - Q) for a proper absorbing
            // Wright-Fisher chain is nonsingular: Q is substochastic with
            // spectral radius < 1, so exact singularity is not an expected
            // property of these systems. The reported instance
            // (wfes_single --fixation -N 100 -s 0 -u 1e-9 -v 0.25 --force,
            // which returned T_fix = nan) was caused by the Accelerate
            // sparse-matrix backend dropping structurally-zero diagonal
            // placeholders through a 1e-15 magnitude filter, leaving (I - Q)
            // with structurally-zero diagonals. With that filter removed the
            // same invocation returns 17.7732, matching an independent dense
            // reference exactly.
            //
            // So a singular report here means the matrix handed to UMFPACK is
            // malformed, not that the model is degenerate. Failing loudly is
            // what surfaces the real bug instead of hiding it in a NaN.
            error_msg += "matrix is singular. (I - Q) for a well-formed "
                         "absorbing Wright-Fisher model is nonsingular, so this "
                         "usually indicates a malformed transition matrix "
                         "(for example a missing diagonal entry) rather than a "
                         "degenerate model. Results would be NaN; refusing to "
                         "report them";
            break;
        case UMFPACK_ERROR_out_of_memory:
            error_msg += "out of memory";
            break;
        case UMFPACK_ERROR_invalid_Numeric_object:
            error_msg += "invalid numeric object";
            break;
        case UMFPACK_ERROR_invalid_Symbolic_object:
            error_msg += "invalid symbolic object";
            break;
        case UMFPACK_ERROR_argument_missing:
            error_msg += "argument missing";
            break;
        case UMFPACK_ERROR_n_nonpositive:
            error_msg += "n is not positive";
            break;
        case UMFPACK_ERROR_invalid_matrix:
            error_msg += "invalid matrix";
            break;
        case UMFPACK_ERROR_different_pattern:
            error_msg += "pattern changed between symbolic and numeric factorization";
            break;
        case UMFPACK_ERROR_invalid_system:
            error_msg += "invalid system";
            break;
        case UMFPACK_ERROR_invalid_permutation:
            error_msg += "invalid permutation";
            break;
        case UMFPACK_ERROR_internal_error:
            error_msg += "internal error";
            break;
        case UMFPACK_ERROR_file_IO:
            error_msg += "file I/O error";
            break;
        default:
            error_msg += "unknown error code " + std::to_string(status);
            break;
    }
    
    throw std::runtime_error(error_msg);
}

void SuiteSparseSolver::ensureFactorized() {
    if (!factorized) {
        factorize();
    }
}

void SuiteSparseSolver::convertFromDense() {
    // Get the dense representation
    dmat dense_matrix = m.dense();
    
    // Debug: Check matrix values
    if (msg_level > 1) {
        std::cout << "SuiteSparseSolver: Matrix sample (first 5x5):" << std::endl;
        for (int i = 0; i < std::min(5, n_rows); i++) {
            for (int j = 0; j < std::min(5, n_cols); j++) {
                std::cout << dense_matrix(i, j) << " ";
            }
            std::cout << std::endl;
        }
    }
    
    // Count non-zeros and build CSC format
    nnz = 0;
    for (int j = 0; j < n_cols; j++) {
        for (int i = 0; i < n_rows; i++) {
            if (std::abs(dense_matrix(i, j)) > 1e-15) {
                nnz++;
            }
        }
    }
    
    // Build CSC format directly from dense matrix
    col_pointers.resize(n_cols + 1, 0);
    row_indices.reserve(nnz);
    values.reserve(nnz);
    
    // Build column by column
    for (int j = 0; j < n_cols; j++) {
        col_pointers[j] = row_indices.size();
        for (int i = 0; i < n_rows; i++) {
            double val = dense_matrix(i, j);
            if (std::abs(val) > 1e-15) {
                row_indices.push_back(i);
                values.push_back(val);
            }
        }
    }
    col_pointers[n_cols] = row_indices.size();
}

} // namespace solver
} // namespace wfes