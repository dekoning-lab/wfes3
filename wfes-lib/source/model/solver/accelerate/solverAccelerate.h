#ifndef SOLVERACCELERATE_H
#define SOLVERACCELERATE_H

#include <string>
#include "../solver.h"
#include "backend_config.h"
#include "backend_types.h"

#ifdef WFES_USE_ACCELERATE

namespace wfes {
namespace solver {

/**
 * @brief Apple Accelerate implementation of the Solver interface
 * 
 * This class provides a wrapper around Apple's Accelerate framework
 * sparse linear solver functionality, implementing the same interface
 * as the Pardiso solver for seamless backend switching.
 */
class AccelerateSolver : public Solver {
public:
    /**
     * @brief Constructor
     * @param matrix The sparse matrix to factorize and solve
     * @param matrix_type Type of matrix (symmetric, general, etc.)
     * @param msg_level Message/verbosity level
     * @param solver_type Type of solver to use
     * @param solve_mode Solve mode configuration
     * @param n_rhs Number of right-hand sides (for multiple solve)
     */
    AccelerateSolver(sparsematrix::SparseMatrix& matrix, llong matrix_type, 
                     llong msg_level = 0, std::string solver_type = "QR",
                     std::string solve_mode = "", llong n_rhs = 1);
    
    /**
     * @brief Destructor - clean up Accelerate resources
     */
    virtual ~AccelerateSolver();
    
    // Required virtual function implementations from base Solver class
    virtual void preprocess() override;
    virtual dvec solve(dvec& b, bool transpose = false) override;
    virtual dmat solve_multiple(dmat& b, bool transpose = false) override;

    /// @copydoc Solver::backendName
    std::string backendName() const override { return "Apple Accelerate (Sparse)"; }
    
    // Additional Accelerate-specific methods
    void analyze();
    void factorize();
    
private:
    // Reference to the sparse matrix
    sparsematrix::SparseMatrix& A;
    
    // Accelerate-specific members
#ifdef __APPLE__
    SparseOpaqueFactorization_Double symbolic_factorization;
    SparseOpaqueFactorization_Double numeric_factorization;
    SparseMatrix_Double sparse_matrix;
#endif
    
    // Solver configuration
    wfes::backend::BackendSolverConfig config;
    llong matrix_type;
    llong msg_level;
    std::string solver_type;
    llong n_rhs;
    
    // State tracking
    bool analyzed;
    bool factorized;
    
    // Helper methods
    void checkAccelerateStatus(int status, const std::string& operation);
    void ensureFactorized();
};

} // namespace solver
} // namespace wfes

#endif // WFES_USE_ACCELERATE

#endif // SOLVERACCELERATE_H