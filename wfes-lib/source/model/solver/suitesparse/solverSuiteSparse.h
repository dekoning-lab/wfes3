#ifndef SOLVERSUITESPARSE_H
#define SOLVERSUITESPARSE_H

#include <string>
#include "../solver.h"
#include <suitesparse/umfpack.h>
#include <memory>
#include <vector>

namespace wfes {
namespace solver {

class SuiteSparseSolver : public Solver {
public:
    SuiteSparseSolver(SparseMatrix& A);
    virtual ~SuiteSparseSolver() override;
    
    virtual void preprocess() override;
    virtual dvec solve(dvec& b, bool transpose = false) override;
    virtual dmat solve_multiple(dmat& b, bool transpose = false) override;

    /// @copydoc Solver::backendName
    std::string backendName() const override { return "SuiteSparse (UMFPACK)"; }
    
    // Internal methods
    void analyze();
    void factorize();
    
    // Set verbosity level
    void setVerbosity(int level) { msg_level = level; }
    
    
private:
    void ensureFactorized();
    void checkUmfpackStatus(int status, const std::string& operation);
    void convertFromDense();
    
    // UMFPACK data structures
    void* symbolic_factorization;
    void* numeric_factorization;
    
    // Control and info arrays
    std::vector<double> control;
    std::vector<double> info;
    
    
    // Matrix data in CSC format (cached for efficiency)
    std::vector<int> col_pointers;
    std::vector<int> row_indices;
    std::vector<double> values;
    
    // Matrix dimensions
    int n_rows;
    int n_cols;
    int nnz;
    
    // Factorization state
    bool analyzed;
    bool factorized;
    
    // Verbosity level
    int msg_level;
    
};

} // namespace solver
} // namespace wfes

#endif // SOLVERSUITESPARSE_H