#include "solverFactory.h"

using namespace wfes::solver;

Solver* SolverFactory::createSolver(std::string solver, sparsematrix::SparseMatrix& A, llong matrix_type, llong message_level, std::string vienna_solver, std::string preconditioner, llong n_rhs){
    
#ifdef WFES_USE_MKL
    if(solver.compare("Pardiso") == 0) {
        return new pardiso::PardisoSolver(dynamic_cast<sparsematrix::SparseMatrixPardiso&>(A), matrix_type, message_level, n_rhs);
    }
#endif

#ifdef WFES_USE_ACCELERATE
    if(solver.compare("Accelerate") == 0) {
        auto* accelerate_solver = new AccelerateSolver(A);
        accelerate_solver->setVerbosity(message_level);
        return accelerate_solver;
    }
#endif

#ifdef WFES_USE_SUITESPARSE
    if(solver.compare("SuiteSparse") == 0) {
        auto* suite_solver = new SuiteSparseSolver(A);
        suite_solver->setVerbosity(message_level);
        return suite_solver;
    }
#endif

#ifdef WFES_USE_PARU
    if(solver.compare("ParU") == 0) {
        auto* paru_solver = new ParUSolver(A);
        paru_solver->setVerbosity(message_level);
        return paru_solver;
    }
#endif

#ifdef WFES_USE_VIENNACL
    if(solver.compare("ViennaCL") == 0) {
        return new vienna::SolverViennaCL(dynamic_cast<sparsematrix::SparseMatrixViennaCL&>(A), vienna_solver, preconditioner);
    }
#endif

    // Default based on platform
#ifdef WFES_USE_MKL
    return new pardiso::PardisoSolver(dynamic_cast<sparsematrix::SparseMatrixPardiso&>(A), matrix_type, message_level, n_rhs);
#elif defined(WFES_USE_ACCELERATE)
    auto* accelerate_solver = new AccelerateSolver(A);
    accelerate_solver->setVerbosity(message_level);
    return accelerate_solver;
#elif defined(WFES_USE_SUITESPARSE)
    auto* suite_solver = new SuiteSparseSolver(A);
    suite_solver->setVerbosity(message_level);
    return suite_solver;
#else
    return new vienna::SolverViennaCL(dynamic_cast<sparsematrix::SparseMatrixViennaCL&>(A), vienna_solver, preconditioner);
#endif
}
