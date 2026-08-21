#ifndef SOLVERFACTORY_H
#define SOLVERFACTORY_H

#include "solver.h"
#include "backend_config.h"

/**
 * @file solverFactory.h
 * @brief Factory class for creating platform-specific linear solvers
 * 
 * This factory provides runtime selection of linear algebra backends based on
 * platform availability and user preference. It automatically includes only
 * the backends available at compile time.
 */

// Include backend-specific headers based on platform
#ifdef WFES_USE_MKL
    #include "model/solver/pardiso/solverPardiso.h"
#endif

#ifdef WFES_USE_ACCELERATE
    #include "model/solver/accelerate/solverAccelerate.h"
#endif

#ifdef WFES_USE_VIENNACL
    #include "model/solver/viennacl/solverViennaCL.h"
#endif

#ifdef WFES_USE_SUITESPARSE
    #include "model/solver/suitesparse/solverSuiteSparse.h"
#endif

#ifdef WFES_USE_PARU
    #include "model/solver/paru/solverParU.h"
#endif

namespace wfes {
    namespace solver {

        /**
         * @class SolverFactory
         * @brief Factory for creating appropriate solver instances
         * 
         * Uses the Factory design pattern to instantiate the correct solver
         * based on the requested backend library. Supports:
         * - Pardiso (Intel MKL) - High performance, requires MKL
         * - Accelerate (macOS) - Native Apple framework
         * - ViennaCL - OpenCL-based, cross-platform
         * - SuiteSparse - Open source alternative
         * - ParU - Experimental parallel solver
         */
        class SolverFactory{
            public:

                /**
                 * @brief Create a solver instance for the specified backend
                 * 
                 * Factory method that instantiates the appropriate solver based on
                 * the library name and compile-time configuration. Falls back to
                 * available alternatives if the requested backend is not available.
                 * 
                 * @param solver Backend library name ("Pardiso", "Accelerate", "ViennaCL", "SuiteSparse", "ParU")
                 * @param A Sparse matrix to be solved
                 * @param matrix_type Matrix type for Pardiso (11 = real unsymmetric)
                 * @param message_level Verbosity level for Pardiso (0 = quiet, 1 = verbose)
                 * @param vienna_solver Iterative solver for ViennaCL ("GMRes", "BiCGStab", "CG")
                 * @param preconditioner Preconditioner for ViennaCL ("ILU0", "ILU", "Jacobi", "" = none)
                 * @param n_rhs Number of right-hand sides (for optimization)
                 * @return Solver* Pointer to the created solver instance
                 * @throws std::runtime_error if no suitable backend is available
                 * @note Caller is responsible for deleting the returned pointer
                 */
                static Solver* createSolver(std::string solver, SparseMatrix& A, llong matrix_type = 11LL, llong message_level = 0LL, std::string vienna_solver = "GMRes", std::string preconditioner = "", llong n_rhs = 1LL);
        };
    }
}

#endif // SOLVERFACTORY_H
