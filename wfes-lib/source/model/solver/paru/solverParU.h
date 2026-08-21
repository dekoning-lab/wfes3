#ifndef SOLVER_PARU_H
#define SOLVER_PARU_H

#ifdef WFES_USE_PARU

#include <string>
#include "model/solver/solver.h"
#include "backend_config.h"
#include <suitesparse/ParU.h>
#include <suitesparse/cholmod.h>
#include <vector>
#include <memory>

namespace wfes {
namespace solver {

class ParUSolver : public Solver {
public:
    ParUSolver(SparseMatrix& A);
    ~ParUSolver();
    
    void preprocess() override;
    dvec solve(dvec& b, bool transpose = false) override;
    dmat solve_multiple(dmat& b, bool transpose = false) override;

    /// @copydoc Solver::backendName
    std::string backendName() const override { return "ParU (SuiteSparse)"; }
    void setVerbosity(int level) { msg_level = level; }
    
private:
    void analyze();
    void factorize();
    void ensureFactorized();
    void convertToLongFormat();
    void createTranspose();
    void factorizeTranspose();
    
    // CHOLMOD workspace
    cholmod_common cc;
    cholmod_sparse* A_cholmod;
    cholmod_sparse* A_transpose_cholmod;
    
    // ParU structures
    ParU_Symbolic Sym;
    ParU_Numeric Num;
    ParU_Symbolic Sym_transpose;
    ParU_Numeric Num_transpose;
    ParU_Control Control;
    
    // State tracking
    bool analyzed;
    bool factorized;
    bool matrix_converted;
    bool transpose_analyzed;
    bool transpose_factorized;
    
    // Matrix dimensions
    int64_t n_rows;
    int64_t n_cols;
    
    // CSC format data
    std::vector<SuiteSparse_long> col_ptrs, row_indices;
    std::vector<double> values;
    int64_t nnz;
    
    // Verbosity
    int msg_level;
    
    // Helper methods
    void convertFromDense();
};

} // namespace solver
} // namespace wfes

#endif // WFES_USE_PARU
#endif // SOLVER_PARU_H