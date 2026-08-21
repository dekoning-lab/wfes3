#include "solverAccelerate.h"
#include "model/sparse-matrix/accelerate/sparseMatrixAccelerate.h"

#ifdef WFES_USE_ACCELERATE

#include <stdexcept>
#include <iostream>

#ifdef __APPLE__
#include <Accelerate/Accelerate.h>
#endif

namespace wfes {
namespace solver {

AccelerateSolver::AccelerateSolver(sparsematrix::SparseMatrix& matrix, llong matrix_type,
                                   llong msg_level, std::string solver_type,
                                   std::string solve_mode, llong n_rhs)
    : Solver(matrix), A(matrix), matrix_type(matrix_type), msg_level(msg_level),
      solver_type(solver_type), n_rhs(n_rhs), analyzed(false), factorized(false) {
    
    // Validate solver type
    if (solver_type != "QR" && solver_type != "Cholesky" && solver_type != "LU") {
        throw std::invalid_argument("Invalid solver type for Accelerate: " + solver_type);
    }
    
    // Set up configuration based on matrix type
    if (matrix_type == 11) {  // Real unsymmetric matrix (like MKL_PARDISO_MATRIX_TYPE_REAL_UNSYMMETRIC)
        config.factorization_type = SparseFactorizationQR;
    } else if (matrix_type == 2) {  // Real symmetric positive definite
        config.factorization_type = SparseFactorizationCholesky;
    } else {
        throw std::invalid_argument("Unsupported matrix type for Accelerate solver");
    }
    
    // Get the Accelerate matrix handle
    #ifdef __APPLE__
    sparsematrix::SparseMatrixAccelerate* accel_matrix = 
        dynamic_cast<sparsematrix::SparseMatrixAccelerate*>(&matrix);
    if (!accel_matrix) {
        throw std::runtime_error("AccelerateSolver requires SparseMatrixAccelerate");
    }
    
    // Note: We'll get the matrix handle during factorization when it's finalized
    // sparse_matrix = accel_matrix->getAccelerateMatrix();
    #endif
    
    if (msg_level > 0) {
        std::cout << "AccelerateSolver: Initialized with " << solver_type 
                  << " solver for matrix type " << matrix_type << std::endl;
    }
}

#ifdef __APPLE__
// Names for the SparseStatus_t values in <Accelerate/Sparse/Solve.h>, so a
// factorization failure reports something more useful than a bare integer.
static const char* sparseStatusName(SparseStatus_t s) {
    switch (s) {
        case SparseStatusOK:            return "SparseStatusOK";
        case SparseFactorizationFailed: return "SparseFactorizationFailed";
        case SparseMatrixIsSingular:    return "SparseMatrixIsSingular";
        case SparseInternalError:       return "SparseInternalError";
        case SparseParameterError:      return "SparseParameterError";
        case SparseStatusReleased:      return "SparseStatusReleased";
        default:                        return "unknown SparseStatus_t";
    }
}
#endif

AccelerateSolver::~AccelerateSolver() {
    #ifdef __APPLE__
    // Clean up Accelerate factorization resources
    if (factorized) {
        try {
            // Clean up exactly once.
            //
            // This used to guard the second cleanup with
            //     if (&numeric_factorization != &symbolic_factorization)
            // which compares the addresses of two distinct members of this
            // object and is therefore ALWAYS true. Meanwhile factorize() does
            //     numeric_factorization = symbolic_factorization;
            // a value copy of an opaque handle that carries the same internal
            // pointer -- so SparseCleanup ran twice on one factorization.
            //
            // The comparison that was intended is between what the handles
            // refer to, not where the handles live. Since factorize() always
            // assigns one to the other (Accelerate combines the symbolic and
            // numeric phases in SparseFactor), there is only ever one
            // factorization to release.
            SparseCleanup(numeric_factorization);
        } catch (...) {
            // Ignore cleanup errors in destructor
        }
    }
    #endif
}

void AccelerateSolver::analyze() {
    if (analyzed) return;
    
    #ifdef __APPLE__
    // For Accelerate, analysis and factorization are combined
    // We'll do the actual work in factorize()
    #else
    throw std::runtime_error("Accelerate backend is only available on macOS");
    #endif
    
    analyzed = true;
}

void AccelerateSolver::factorize() {
    if (!analyzed) {
        analyze();
    }
    
    if (factorized) return;
    
    #ifdef __APPLE__
    if (msg_level > 0) {
        std::cout << "AccelerateSolver: Starting factorization..." << std::endl;
    }
    
    // Get the matrix handle now that it should be finalized
    sparsematrix::SparseMatrixAccelerate* accel_matrix = 
        dynamic_cast<sparsematrix::SparseMatrixAccelerate*>(&A);
    if (!accel_matrix) {
        throw std::runtime_error("AccelerateSolver requires SparseMatrixAccelerate");
    }
    
    // Ensure the matrix is finalized before we use it
    accel_matrix->finalizeConstruction();
    sparse_matrix = accel_matrix->getAccelerateMatrix();
    
    if (msg_level > 0) {
        std::cout << "AccelerateSolver: Matrix finalized and obtained" << std::endl;
    }
    
    // Perform symbolic and numeric factorization using Accelerate
    try {
        if (config.factorization_type == SparseFactorizationQR) {
            if (msg_level > 0) {
                std::cout << "AccelerateSolver: Using QR factorization" << std::endl;
            }
            // QR factorization for general matrices
            symbolic_factorization = SparseFactor(SparseFactorizationQR, sparse_matrix);
            
            // Debug: Check symbolic factorization status
            if (msg_level > 0) {
                std::cout << "AccelerateSolver: Symbolic factorization status - "
                          << "workspace required: " << symbolic_factorization.solveWorkspaceRequiredStatic 
                          << " static, " << symbolic_factorization.solveWorkspaceRequiredPerRHS << " per RHS" << std::endl;
            }
        } else if (config.factorization_type == SparseFactorizationCholesky) {
            if (msg_level > 0) {
                std::cout << "AccelerateSolver: Using Cholesky factorization" << std::endl;
            }
            // Cholesky factorization for symmetric positive definite matrices
            symbolic_factorization = SparseFactor(SparseFactorizationCholesky, sparse_matrix);
        } else {
            throw std::runtime_error("Unsupported factorization type");
        }
        
        // SparseFactor reports failure through the returned handle's .status
        // field, not by throwing -- so the surrounding try/catch never saw it.
        // A singular or structurally deficient matrix produced a handle with
        // status != SparseStatusOK, which SparseSolve then happily accepted,
        // filling the solution vector with garbage and returning exit 0.
        //
        // This is the same class of defect as the UMFPACK singular-matrix
        // warning that used to be swallowed in the SuiteSparse backend: the
        // library did report the problem, nothing looked at the report.
        if (symbolic_factorization.status != SparseStatusOK) {
            throw std::runtime_error(
                "Accelerate factorization failed with status " +
                std::to_string(static_cast<int>(symbolic_factorization.status)) +
                " (" + sparseStatusName(symbolic_factorization.status) + "). "
                "The matrix is singular or structurally deficient; any solution "
                "computed from this factorization would be meaningless");
        }

        // For Accelerate, symbolic and numeric factorization are combined in SparseFactor
        numeric_factorization = symbolic_factorization;

        if (msg_level > 0) {
            std::cout << "AccelerateSolver: Factorization complete" << std::endl;
        }
    } catch (const std::exception& e) {
        throw std::runtime_error("Accelerate factorization failed: " + std::string(e.what()));
    }
    #else
    throw std::runtime_error("Accelerate backend is only available on macOS");
    #endif
    
    factorized = true;
}

void AccelerateSolver::preprocess() {
    // Accelerate combines analysis and factorization
    factorize();
}

dvec AccelerateSolver::solve(dvec& b, bool transpose) {
    ensureFactorized();
    
    #ifdef __APPLE__
    dvec x(b.size());
    
    // Create dense vector structures for Accelerate
    DenseVector_Double b_vec = {
        .count = static_cast<int>(b.size()),
        .data = b.data()
    };
    
    DenseVector_Double x_vec = {
        .count = static_cast<int>(x.size()),
        .data = x.data()
    };
    
    // Debug: Print initial b_vec values
    if (msg_level > 0) {
        std::cout << "AccelerateSolver: Initial b_vec values:" << std::endl;
        for (int i = 0; i < std::min(5, static_cast<int>(b.size())); i++) {
            std::cout << "b_vec[" << i << "] = " << b_vec.data[i] << std::endl;
        }
    }
    
    // Solve using the factorized matrix
    try {
        if (transpose) {
            // For transpose solve, we may need to handle differently
            // For now, use the same approach with transpose attribute
            SparseMatrix_Double sparse_T = sparse_matrix;
            sparse_T.structure.attributes.transpose = true;
            SparseOpaqueFactorization_Double factors_T = SparseFactor(config.factorization_type, sparse_T);
            // SparseSolve's real signature is (factorization, b_rhs,
            // x_solution, workspace) -- the doc comment's order, NOT the order
            // implied by the declaration's parameter names, which are written
            // `DenseVector_Double x, DenseVector_Double b` in the 4-arg
            // overload and `b, x` in the 3-arg one. The SDK header contradicts
            // itself and neither overload has a body there, so this was
            // settled empirically: factoring diag(2,4) and solving for
            // b = (2,4) puts the answer (1,1) in the THIRD argument.
            //
            // This previously passed (factorization, x_vec, b_vec, workspace),
            // which fed Accelerate the uninitialised x as the right-hand side,
            // wrote the solution over the caller's b, and returned x untouched
            // -- i.e. returned uninitialised heap memory as the result.
            // Allocate workspace memory for transpose solve
            size_t workspace_size = factors_T.solveWorkspaceRequiredStatic + 
                                   1 * factors_T.solveWorkspaceRequiredPerRHS;
            void* workspace = malloc(workspace_size);
            if (!workspace) {
                throw std::runtime_error("Failed to allocate workspace memory for transpose SparseSolve");
            }
            
            SparseSolve(factors_T, b_vec, x_vec, workspace);
            
            free(workspace);
            SparseCleanup(factors_T);
        } else {
            // SparseSolve's real signature is (factorization, b_rhs,
            // x_solution, workspace) -- the doc comment's order, NOT the order
            // implied by the declaration's parameter names, which are written
            // `DenseVector_Double x, DenseVector_Double b` in the 4-arg
            // overload and `b, x` in the 3-arg one. The SDK header contradicts
            // itself and neither overload has a body there, so this was
            // settled empirically: factoring diag(2,4) and solving for
            // b = (2,4) puts the answer (1,1) in the THIRD argument.
            //
            // This previously passed (factorization, x_vec, b_vec, workspace),
            // which fed Accelerate the uninitialised x as the right-hand side,
            // wrote the solution over the caller's b, and returned x untouched
            // -- i.e. returned uninitialised heap memory as the result.
            // Allocate workspace memory
            size_t workspace_size = numeric_factorization.solveWorkspaceRequiredStatic + 
                                   1 * numeric_factorization.solveWorkspaceRequiredPerRHS;
            void* workspace = malloc(workspace_size);
            if (!workspace) {
                throw std::runtime_error("Failed to allocate workspace memory for SparseSolve");
            }
            
            SparseSolve(numeric_factorization, b_vec, x_vec, workspace);
            
            free(workspace);
            
            // Debug: Print solution x_vec values
            if (msg_level > 0) {
                std::cout << "AccelerateSolver: Solution x_vec values:" << std::endl;
                for (int i = 0; i < std::min(5, static_cast<int>(x.size())); i++) {
                    std::cout << "x_vec[" << i << "] = " << x_vec.data[i] << std::endl;
                }
            }
        }
    } catch (const std::exception& e) {
        throw std::runtime_error("Accelerate solve failed: " + std::string(e.what()));
    }
    
    return x;
    #else
    throw std::runtime_error("Accelerate backend is only available on macOS");
    #endif
}

dmat AccelerateSolver::solve_multiple(dmat& b, bool transpose) {
    ensureFactorized();
    
    #ifdef __APPLE__
    // Solve each right-hand side independently
    dmat x(b.rows(), b.cols());
    
    for (int i = 0; i < b.cols(); ++i) {
        dvec bi = b.col(i);
        dvec xi = solve(bi, transpose);
        x.col(i) = xi;
    }
    
    return x;
    #else
    throw std::runtime_error("Accelerate backend is only available on macOS");
    #endif
}

void AccelerateSolver::checkAccelerateStatus(int status, const std::string& operation) {
    if (status != 0) {  // Assuming 0 is success
        throw std::runtime_error("Accelerate " + operation + " failed with status: " + 
                                 std::to_string(status));
    }
}

void AccelerateSolver::ensureFactorized() {
    if (!factorized) {
        factorize();
    }
}

} // namespace solver
} // namespace wfes

#endif // WFES_USE_ACCELERATE