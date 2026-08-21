#ifdef WFES_USE_PARU

#include "solverParU.h"
#include <iostream>
#include <stdexcept>
#include <algorithm>
#include <cmath>

#ifdef WFES_USE_ACCELERATE
#include "model/sparse-matrix/accelerate/sparseMatrixAccelerate.h"
#endif
#include <cstring>

namespace wfes {
namespace solver {

ParUSolver::ParUSolver(SparseMatrix& A) 
    : Solver(A), A_cholmod(nullptr), A_transpose_cholmod(nullptr),
      Sym(nullptr), Num(nullptr), Sym_transpose(nullptr), Num_transpose(nullptr),
      Control(nullptr), analyzed(false), factorized(false),
      matrix_converted(false), transpose_analyzed(false), transpose_factorized(false), 
      msg_level(0) {
    
    // Initialize CHOLMOD (must use long integer version for ParU)
    // CRITICAL: Must zero-initialize the cholmod_common structure first!
    std::memset(&cc, 0, sizeof(cholmod_common));
    cholmod_l_start(&cc);
    
    // Get matrix dimensions
    n_rows = m.num_rows;
    n_cols = m.num_cols;
    
    if (n_rows != n_cols) {
        cholmod_l_finish(&cc);
        throw std::runtime_error("ParUSolver requires square matrices");
    }
    
    // Initialize ParU control (NULL for defaults)
    Control = nullptr;
    
    if (msg_level > 0) {
        std::cout << "ParUSolver: Initialized for " << n_rows << "x" << n_cols 
                  << " matrix" << std::endl;
    }
}

ParUSolver::~ParUSolver() {
    // Free ParU structures
    if (Num != nullptr) {
        ParU_FreeNumeric(&Num, Control);
    }
    if (Sym != nullptr) {
        ParU_FreeSymbolic(&Sym, Control);
    }
    if (Num_transpose != nullptr) {
        ParU_FreeNumeric(&Num_transpose, Control);
    }
    if (Sym_transpose != nullptr) {
        ParU_FreeSymbolic(&Sym_transpose, Control);
    }
    if (Control != nullptr) {
        ParU_FreeControl(&Control);
    }
    
    // Free CHOLMOD matrices
    if (A_cholmod != nullptr) {
        cholmod_l_free_sparse(&A_cholmod, &cc);
    }
    if (A_transpose_cholmod != nullptr) {
        cholmod_l_free_sparse(&A_transpose_cholmod, &cc);
    }
    
    // Finish CHOLMOD
    cholmod_l_finish(&cc);
}

void ParUSolver::convertToLongFormat() {
    if (matrix_converted) return;
    
    // Get CSC format - use same approach as SuiteSparse solver
    #ifdef WFES_USE_ACCELERATE
    // Check if the matrix is an Accelerate sparse matrix
    auto* accel_matrix = dynamic_cast<wfes::sparsematrix::SparseMatrixAccelerate*>(&m);
    if (accel_matrix) {
        // Ensure matrix is finalized before conversion
        accel_matrix->finalizeConstruction();
        
        // Use efficient CSR to CSC conversion
        std::vector<int> temp_col_ptrs, temp_row_indices;
        std::vector<double> temp_values;
        accel_matrix->convertToCSC(temp_col_ptrs, temp_row_indices, temp_values);
        
        // Convert to SuiteSparse_long arrays
        col_ptrs.resize(temp_col_ptrs.size());
        row_indices.resize(temp_row_indices.size());
        values = temp_values;
        
        for (size_t i = 0; i < temp_col_ptrs.size(); i++) {
            col_ptrs[i] = static_cast<SuiteSparse_long>(temp_col_ptrs[i]);
        }
        for (size_t i = 0; i < temp_row_indices.size(); i++) {
            row_indices[i] = static_cast<SuiteSparse_long>(temp_row_indices[i]);
        }
    } else {
        // Fall back to dense conversion
        convertFromDense();
    }
    #else
    // No Accelerate, use dense conversion
    convertFromDense();
    #endif
    
    nnz = values.size();
    
    // Allocate CHOLMOD sparse matrix (long integer version required by ParU)
    A_cholmod = cholmod_l_allocate_sparse(
        n_rows, n_cols, nnz,
        1,              // sorted
        1,              // packed
        0,              // stype (0 = unsymmetric)
        CHOLMOD_REAL,   // xtype
        &cc
    );
    
    if (A_cholmod == nullptr) {
        throw std::runtime_error("Failed to allocate CHOLMOD sparse matrix");
    }
    
    // Copy data to CHOLMOD matrix (convert int to int64_t)
    int64_t* Ap = (int64_t*)A_cholmod->p;
    int64_t* Ai = (int64_t*)A_cholmod->i;
    double* Ax = (double*)A_cholmod->x;
    
    // Copy column pointers
    for (int64_t j = 0; j <= n_cols; j++) {
        Ap[j] = col_ptrs[j];
    }
    
    // Copy row indices
    for (int64_t k = 0; k < nnz; k++) {
        Ai[k] = row_indices[k];
    }
    
    // Copy values
    std::memcpy(Ax, values.data(), nnz * sizeof(double));
    
    // Verify the matrix
    if (!cholmod_l_check_sparse(A_cholmod, &cc)) {
        cholmod_l_free_sparse(&A_cholmod, &cc);
        A_cholmod = nullptr;
        throw std::runtime_error("Invalid CHOLMOD sparse matrix");
    }
    
    if (msg_level > 0) {
        std::cout << "ParUSolver: CHOLMOD matrix status: " << cc.status << std::endl;
        std::cout << "ParUSolver: Matrix is sorted: " << A_cholmod->sorted << std::endl;
        std::cout << "ParUSolver: Matrix is packed: " << A_cholmod->packed << std::endl;
        std::cout << "ParUSolver: Matrix stype: " << A_cholmod->stype << std::endl;
    }
    
    matrix_converted = true;
    
    if (msg_level > 1) {
        std::cout << "ParUSolver: Converted matrix to CHOLMOD long format" << std::endl;
        std::cout << "  nnz = " << nnz << std::endl;
    }
}

void ParUSolver::analyze() {
    if (analyzed) return;
    
    // Ensure matrix is converted
    convertToLongFormat();
    
    if (msg_level > 0) {
        std::cout << "ParUSolver: Starting symbolic analysis..." << std::endl;
    }
    
    // Perform symbolic analysis
    ParU_Info info = ParU_Analyze(A_cholmod, &Sym, Control);
    
    if (info != PARU_SUCCESS) {
        std::string error_msg = "ParU symbolic analysis failed: ";
        switch (info) {
            case PARU_OUT_OF_MEMORY:
                error_msg += "out of memory";
                break;
            case PARU_INVALID:
                error_msg += "invalid input";
                break;
            case PARU_SINGULAR:
                error_msg += "matrix is singular";
                break;
            default:
                error_msg += "unknown error (" + std::to_string(info) + ")";
        }
        throw std::runtime_error(error_msg);
    }
    
    analyzed = true;
    
    if (msg_level > 0) {
        std::cout << "ParUSolver: Symbolic analysis complete" << std::endl;
    }
}

void ParUSolver::factorize() {
    if (factorized) return;
    
    // Ensure symbolic analysis is done
    analyze();
    
    if (msg_level > 0) {
        std::cout << "ParUSolver: Starting numeric factorization..." << std::endl;
        std::cout << "ParUSolver: Matrix dimensions: " << n_rows << "x" << n_cols << std::endl;
        std::cout << "ParUSolver: NNZ: " << nnz << std::endl;
        std::cout << "ParUSolver: CHOLMOD common status before factorize: " << cc.status << std::endl;
    }
    
    // Perform numeric factorization  
    if (msg_level > 1) {
        std::cout << "ParUSolver: Calling ParU_Factorize..." << std::endl;
    }
    ParU_Info info = ParU_Factorize(A_cholmod, Sym, &Num, Control);
    if (msg_level > 1) {
        std::cout << "ParUSolver: ParU_Factorize returned: " << info << std::endl;
    }
    
    if (info != PARU_SUCCESS) {
        std::string error_msg = "ParU numeric factorization failed: ";
        switch (info) {
            case PARU_OUT_OF_MEMORY:
                error_msg += "out of memory";
                break;
            case PARU_INVALID:
                error_msg += "invalid input";
                break;
            case PARU_SINGULAR:
                error_msg += "matrix is singular";
                break;
            default:
                error_msg += "unknown error (" + std::to_string(info) + ")";
        }
        throw std::runtime_error(error_msg);
    }
    
    factorized = true;
    
    if (msg_level > 0) {
        std::cout << "ParUSolver: Numeric factorization complete" << std::endl;
        
        // Report statistics
        double flops;
        if (ParU_Get(Sym, Num, PARU_GET_FLOPS_BOUND, &flops, Control) == PARU_SUCCESS) {
            std::cout << "  FLOPs: " << flops << std::endl;
        }
        
        int64_t nnz_LU;
        if (ParU_Get(Sym, Num, PARU_GET_LNZ_BOUND, &nnz_LU, Control) == PARU_SUCCESS) {
            std::cout << "  Nonzeros in L+U: " << nnz_LU << std::endl;
        }
    }
}

void ParUSolver::createTranspose() {
    if (A_transpose_cholmod != nullptr) return;
    
    // Ensure original matrix is converted
    convertToLongFormat();
    
    if (msg_level > 0) {
        std::cout << "ParUSolver: Creating transpose matrix..." << std::endl;
    }
    
    // Use CHOLMOD to transpose the matrix
    A_transpose_cholmod = cholmod_l_transpose(A_cholmod, 1, &cc);
    
    if (A_transpose_cholmod == nullptr) {
        throw std::runtime_error("Failed to create transpose matrix");
    }
    
    if (msg_level > 0) {
        std::cout << "ParUSolver: Transpose matrix created successfully" << std::endl;
    }
}

void ParUSolver::factorizeTranspose() {
    if (transpose_factorized) return;
    
    // Create transpose matrix if needed
    createTranspose();
    
    if (msg_level > 0) {
        std::cout << "ParUSolver: Starting transpose matrix analysis..." << std::endl;
    }
    
    // Perform symbolic analysis on transpose
    if (!transpose_analyzed) {
        ParU_Info info = ParU_Analyze(A_transpose_cholmod, &Sym_transpose, Control);
        
        if (info != PARU_SUCCESS) {
            std::string error_msg = "ParU transpose symbolic analysis failed: ";
            switch (info) {
                case PARU_OUT_OF_MEMORY:
                    error_msg += "out of memory";
                    break;
                case PARU_INVALID:
                    error_msg += "invalid input";
                    break;
                default:
                    error_msg += "unknown error (" + std::to_string(info) + ")";
            }
            throw std::runtime_error(error_msg);
        }
        transpose_analyzed = true;
    }
    
    if (msg_level > 0) {
        std::cout << "ParUSolver: Starting transpose numeric factorization..." << std::endl;
    }
    
    // Perform numeric factorization on transpose
    ParU_Info info = ParU_Factorize(A_transpose_cholmod, Sym_transpose, &Num_transpose, Control);
    
    if (info != PARU_SUCCESS) {
        std::string error_msg = "ParU transpose numeric factorization failed: ";
        switch (info) {
            case PARU_OUT_OF_MEMORY:
                error_msg += "out of memory";
                break;
            case PARU_INVALID:
                error_msg += "invalid input";
                break;
            case PARU_SINGULAR:
                error_msg += "matrix is singular";
                break;
            default:
                error_msg += "unknown error (" + std::to_string(info) + ")";
        }
        throw std::runtime_error(error_msg);
    }
    
    transpose_factorized = true;
    
    if (msg_level > 0) {
        std::cout << "ParUSolver: Transpose factorization complete" << std::endl;
    }
}

void ParUSolver::preprocess() {
    factorize();
}

void ParUSolver::ensureFactorized() {
    if (!factorized) {
        factorize();
    }
}

dvec ParUSolver::solve(dvec& b, bool transpose) {
    if (b.size() != n_rows) {
        throw std::runtime_error("ParUSolver: RHS vector size mismatch");
    }
    
    // Allocate solution vector
    dvec x(n_rows);
    
    if (transpose) {
        // Ensure transpose matrix is factorized
        factorizeTranspose();
        
        if (msg_level > 0) {
            std::cout << "ParUSolver: Solving transposed system A^T x = b" << std::endl;
        }
        
        // Solve the transposed system
        ParU_Info info = ParU_Solve(Sym_transpose, Num_transpose, b.data(), x.data(), Control);
        
        if (info != PARU_SUCCESS) {
            std::string error_msg = "ParU transpose solve failed: ";
            switch (info) {
                case PARU_OUT_OF_MEMORY:
                    error_msg += "out of memory";
                    break;
                case PARU_INVALID:
                    error_msg += "invalid input";
                    break;
                default:
                    error_msg += "unknown error (" + std::to_string(info) + ")";
            }
            throw std::runtime_error(error_msg);
        }
        
        if (msg_level > 1) {
            // Compute and report residual for transpose system
            double resid_norm, anorm, xnorm;
            if (ParU_Residual(A_transpose_cholmod, x.data(), b.data(), resid_norm, anorm, xnorm, Control) == PARU_SUCCESS) {
                std::cout << "ParUSolver: Transpose solution complete" << std::endl;
                std::cout << "  Relative residual: " << resid_norm << std::endl;
            }
        }
    } else {
        // Ensure the matrix is factorized
        ensureFactorized();
        
        // Solve the system
        ParU_Info info = ParU_Solve(Sym, Num, b.data(), x.data(), Control);
        
        if (info != PARU_SUCCESS) {
            std::string error_msg = "ParU solve failed: ";
            switch (info) {
                case PARU_OUT_OF_MEMORY:
                    error_msg += "out of memory";
                    break;
                case PARU_INVALID:
                    error_msg += "invalid input";
                    break;
                default:
                    error_msg += "unknown error (" + std::to_string(info) + ")";
            }
            throw std::runtime_error(error_msg);
        }
        
        if (msg_level > 1) {
            // Compute and report residual
            double resid_norm, anorm, xnorm;
            if (ParU_Residual(A_cholmod, x.data(), b.data(), resid_norm, anorm, xnorm, Control) == PARU_SUCCESS) {
                std::cout << "ParUSolver: Solution complete" << std::endl;
                std::cout << "  Relative residual: " << resid_norm << std::endl;
            }
        }
    }
    
    return x;
}

dmat ParUSolver::solve_multiple(dmat& b, bool transpose) {
    // Contract, documented and enforced in PardisoSolver::solve_multiple and
    // matched by SuiteSparseSolver::solve_multiple: the ROWS of b are the
    // right-hand sides, each of length equal to the system order, and the
    // result is (order x n_rhs) so that column i is the solution for RHS i.
    // transpose == true solves A^T x = b_i for every row b_i, with the same
    // semantics as the single-RHS entry point.
    //
    // This previously enforced the opposite (columns-are-RHS) convention: it
    // required b.rows() == order and iterated over b.col(i), so the only
    // production caller -- wfafs_stochastic, which passes the rectangular
    // Identity(n_rhs, order) with transpose == true -- died here with
    // "RHS matrix row size mismatch". The "transpose solve not yet
    // implemented" stub that used to sit below that check was unreachable
    // from that caller; the orientation guard threw first.
    if (b.cols() != n_rows) {
        throw std::runtime_error(
            "ParUSolver::solve_multiple: right-hand sides have length " +
            std::to_string(b.cols()) + " but the factorized system has order " +
            std::to_string(n_rows) +
            ". Rows of the input are the right-hand sides");
    }

    // Factorize whichever matrix the per-row solves use. ParU_Solve (the whole
    // solve API of ParU in SuiteSparse 7.x) has no transpose option -- it only
    // solves Ax=b / AX=B for the factorized matrix -- so solve() realizes
    // A^T x = b by factorizing an explicit transpose of the matrix
    // (createTranspose()/factorizeTranspose()) and solving that system. Only
    // the factorization actually needed is computed here: factorizing A too
    // would double the memory and time for a transpose-only workload.
    if (transpose) {
        factorizeTranspose();
    } else {
        ensureFactorized();
    }

    int64_t nrhs = b.rows();
    dmat x(n_rows, nrhs);   // (order x n_rhs)

    // Solve each RHS independently through the single-RHS entry point, which
    // already implements both the plain and the transpose solve.
    for (int64_t i = 0; i < nrhs; i++) {
        dvec bi = b.row(i);
        dvec xi = solve(bi, transpose);
        x.col(i) = xi;
    }
    
    if (msg_level > 0) {
        std::cout << "ParUSolver: Multiple RHS solution complete" << std::endl;
        std::cout << "  Solved " << nrhs << " systems" << std::endl;
    }
    
    return x;
}

void ParUSolver::convertFromDense() {
    // Get the dense representation
    dmat dense_matrix = m.dense();
    
    // Debug: Check matrix values
    if (msg_level > 1) {
        std::cout << "ParUSolver: Matrix sample (first 5x5):" << std::endl;
        for (int i = 0; i < std::min(5, (int)n_rows); i++) {
            for (int j = 0; j < std::min(5, (int)n_cols); j++) {
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
    
    // Reserve space
    col_ptrs.resize(n_cols + 1);
    row_indices.reserve(nnz);
    values.reserve(nnz);
    
    // Build CSC format
    col_ptrs[0] = 0;
    for (int j = 0; j < n_cols; j++) {
        for (int i = 0; i < n_rows; i++) {
            double val = dense_matrix(i, j);
            if (std::abs(val) > 1e-15) {
                row_indices.push_back(static_cast<SuiteSparse_long>(i));
                values.push_back(val);
            }
        }
        col_ptrs[j + 1] = static_cast<SuiteSparse_long>(row_indices.size());
    }
    
    if (msg_level > 0) {
        std::cout << "ParUSolver: Converted dense matrix to CSC format (" 
                  << nnz << " non-zeros)" << std::endl;
    }
}

} // namespace solver
} // namespace wfes

#endif // WFES_USE_PARU