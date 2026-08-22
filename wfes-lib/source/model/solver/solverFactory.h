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

// solverViennaCL.h used to be included here. Nothing ever defined
// WFES_USE_VIENNACL, so the class was compiled into every binary and reachable
// from none of them; it has been removed.

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

                /**
                 * @brief The backend createSolver ACTUALLY builds for a request
                 *
                 * createSolver does not always serve what was asked for: a
                 * "--library Accelerate" request is served by SuiteSparse
                 * whenever this build has SuiteSparse, which is every shipped
                 * macOS build. Echoing the REQUESTED name into a run's
                 * provenance record therefore names a backend that never
                 * executed. This function answers the other half of the
                 * question, so no caller has to re-derive the substitution
                 * rule for itself.
                 *
                 * Pure: it inspects nothing but @p requested and this build's
                 * WFES_USE_* macros, so it can be called by a mode that never
                 * constructs a solver at all.
                 *
                 * @param requested The --library value, e.g. "Accelerate"
                 * @return The name of the backend that would actually run, as
                 *         spelled by Args_Parser::supported_libraries() (the
                 *         naming authority): "Pardiso", "Accelerate",
                 *         "SuiteSparse" or "ParU". Empty when this build has no
                 *         backend for @p requested -- exactly the cases
                 *         createSolver throws on. Callers must publish nothing
                 *         rather than guess; from the CLI this cannot happen,
                 *         because Args_Parser::validate_library() refuses those
                 *         values before any of this runs.
                 *
                 * @note This function and createSolver encode the same
                 *       decision and MUST be edited together. They are kept
                 *       adjacent in solverFactory_with_accelerate.cpp, with the
                 *       same #ifdef ladder in the same order, so that a new
                 *       backend or a new substitution is visibly missing from
                 *       one if it is added only to the other.
                 */
                static std::string effectiveLibrary(const std::string& requested);
        };
    }
}

#endif // SOLVERFACTORY_H
