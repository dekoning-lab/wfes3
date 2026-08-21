#ifndef SOLVER_H
#define SOLVER_H

#include "model/sparse-matrix/sparseMatrix.h"

using namespace wfes::sparsematrix;

/**
 * @file solver.h
 * @brief Abstract base class for sparse linear system solvers
 * 
 * This file defines the interface that all WFES linear solvers must implement.
 * Concrete implementations include Pardiso (MKL), Accelerate (macOS), ViennaCL,
 * SuiteSparse, and ParU backends.
 */

namespace wfes {
    namespace solver {

        /**
         * @class Solver
         * @brief Abstract base class for solving sparse linear systems
         * 
         * Provides a unified interface for different sparse linear algebra backends.
         * All solvers must implement preprocessing and solving methods for the
         * linear system Ax = b, where A is a sparse matrix.
         */
        class Solver {
            protected:
                /**
                 * @brief Reference to the sparse matrix to be solved
                 * 
                 * This matrix represents the coefficient matrix A in the linear
                 * system Ax = b. The matrix is typically (Q - I) where Q is the
                 * Wright-Fisher transition matrix.
                 */
                SparseMatrix& m;
            public:
                /**
                 * @brief Construct a solver for the given sparse matrix
                 * @param A Sparse matrix to be factorized and solved
                 */
                Solver(SparseMatrix& A);

                /**
                 * @brief Virtual destructor for proper cleanup
                 */
                virtual ~Solver(){};

                /**
                 * @brief Preprocess the matrix for efficient solving
                 * 
                 * This method performs backend-specific preprocessing such as:
                 * - Symbolic factorization (determining sparsity pattern)
                 * - Numerical factorization (LU, Cholesky, etc.)
                 * - Memory allocation for solver workspace
                 * 
                 * Must be called once before any solve operations.
                 */
                virtual void preprocess() = 0;

                /**
                 * @brief Solve the linear system Ax = b
                 * 
                 * Uses the preprocessed factorization to solve for x given b.
                 * Can optionally solve the transposed system A^T x = b.
                 * 
                 * @param b Right-hand side vector
                 * @param transpose If true, solve A^T x = b instead of Ax = b
                 * @return dvec Solution vector x
                 * @throws std::runtime_error if solving fails
                 */
                virtual dvec solve(dvec& b, bool transpose = false) =0;

                /**
                 * @brief Solve multiple linear systems AX = B
                 * 
                 * Efficiently solves for multiple right-hand side vectors
                 * simultaneously, where B is a matrix with each column being
                 * a different RHS vector.
                 * 
                 * @param b Matrix of right-hand side vectors (each column is one RHS)
                 * @param transpose If true, solve A^T X = B instead of AX = B
                 * @return dmat Solution matrix X (each column is one solution)
                 * @throws std::runtime_error if solving fails
                 */
                virtual dmat solve_multiple(dmat& b, bool transpose = false) = 0;

                /**
                 * @brief Name of the backend that will actually do the arithmetic.
                 *
                 * This is NOT the same as the string the user passed to
                 * --library, and that is the point. SolverFactory substitutes
                 * backends: on macOS, "--library Accelerate" is served by
                 * SuiteSparse/UMFPACK whenever SuiteSparse is available, so
                 * every tool that echoed options.library was reporting a
                 * backend that did not run. For a reproducibility record --
                 * a methods section, a provenance log -- that is simply wrong.
                 *
                 * Ask the solver what it is rather than assuming.
                 */
                virtual std::string backendName() const = 0;
        };
    }
}
#endif // SOLVER_H
