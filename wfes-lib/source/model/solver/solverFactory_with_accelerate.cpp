#include "solverFactory.h"
#include "backend_config.h"

// Include backend-specific headers based on platform
#ifdef WFES_USE_MKL
    #include "pardiso/solverPardiso.h"
    #include "../sparse-matrix/pardiso/sparseMatrixPardiso.h"
#endif

#ifdef WFES_USE_ACCELERATE
    #include "accelerate/solverAccelerate.h"
    #include "../sparse-matrix/accelerate/sparseMatrixAccelerate.h"
#endif

// The ViennaCL solver/matrix headers used to be included here; both classes
// have been deleted (nothing ever defined WFES_USE_VIENNACL). The
// WFES_USE_VIENNACL branches below are dead for the same reason.

#ifdef WFES_USE_SUITESPARSE
    #include "suitesparse/solverSuiteSparse.h"
    // sparseMatrixSuiteSparse.h used to be included here too. That class was
    // abstract -- it overrode none of SparseMatrix's pure virtuals -- so it
    // could never be constructed; only the SOLVER half of SuiteSparse is real.
#endif

#ifdef WFES_USE_PARU
    #include "paru/solverParU.h"
#endif

using namespace wfes::solver;

Solver* SolverFactory::createSolver(std::string solver, SparseMatrix& A, llong matrix_type, 
                                    llong message_level, std::string vienna_solver, 
                                    std::string preconditioner, llong n_rhs) {
    
    // Handle Pardiso request
    if(solver.compare("Pardiso") == 0) {
        #ifdef WFES_USE_MKL
            using namespace wfes::pardiso;
            return new PardisoSolver(dynamic_cast<SparseMatrixPardiso&>(A), matrix_type, message_level, n_rhs);
        #else
            throw std::runtime_error("Pardiso solver not available on this platform. Use Accelerate or ViennaCL instead.");
        #endif
    }
    // Handle Accelerate request - but use SuiteSparse for solving if available
    else if(solver.compare("Accelerate") == 0) {
        #ifdef WFES_USE_ACCELERATE
            #ifdef WFES_USE_SUITESPARSE
                // Use SuiteSparse solver with Accelerate matrix
                auto* suite_solver = new SuiteSparseSolver(A);
                suite_solver->setVerbosity(message_level);
                return suite_solver;
            #else
                // Fall back to pure Accelerate implementation
                using namespace wfes::solver;
                return new AccelerateSolver(A, matrix_type, message_level, "QR", "", n_rhs);
            #endif
        #else
            throw std::runtime_error("Accelerate solver not available on this platform. Use Pardiso or ViennaCL instead.");
        #endif
    }
    // Handle ViennaCL request
    else if(solver.compare("ViennaCL") == 0) {
        #ifdef WFES_USE_VIENNACL
            using namespace wfes::vienna;
            return new SolverViennaCL(dynamic_cast<SparseMatrixViennaCL&>(A), vienna_solver, preconditioner);
        #else
            throw std::runtime_error("ViennaCL solver not available. OpenCL support required.");
        #endif
    }
    // Handle SuiteSparse request
    else if(solver.compare("SuiteSparse") == 0) {
        #ifdef WFES_USE_SUITESPARSE
            auto* suite_solver = new SuiteSparseSolver(A);
            suite_solver->setVerbosity(message_level);
            return suite_solver;
        #else
            throw std::runtime_error("SuiteSparse solver not available on this platform.");
        #endif
    }
    // Handle ParU request
    else if(solver.compare("ParU") == 0) {
        #ifdef WFES_USE_PARU
            auto* paru_solver = new ParUSolver(A);
            paru_solver->setVerbosity(message_level);
            return paru_solver;
        #else
            throw std::runtime_error("ParU solver not available. SuiteSparse with ParU support required.");
        #endif
    }
    // Default based on platform
    else {
        #ifdef WFES_USE_ACCELERATE
            // On macOS, default to Accelerate
            return new AccelerateSolver(A, matrix_type, message_level, "QR", "", n_rhs);
        #elif defined(WFES_USE_MKL)
            // On Linux/Windows, default to Pardiso
            using namespace wfes::pardiso;
            return new PardisoSolver(dynamic_cast<SparseMatrixPardiso&>(A), matrix_type, message_level, n_rhs);
        #elif defined(WFES_USE_VIENNACL)
            // If only ViennaCL is available
            using namespace wfes::vienna;
            return new SolverViennaCL(dynamic_cast<SparseMatrixViennaCL&>(A), vienna_solver, preconditioner);
        #else
            throw std::runtime_error("No solver backend available!");
        #endif
    }
}