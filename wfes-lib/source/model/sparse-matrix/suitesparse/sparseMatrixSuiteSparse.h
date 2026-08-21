#ifndef SPARSEMATRIXSUITESPARSE_H
#define SPARSEMATRIXSUITESPARSE_H

#include "../sparseMatrix.h"

namespace wfes {
namespace sparsematrix {

/**
 * @brief Simple sparse matrix wrapper for SuiteSparse
 * 
 * SuiteSparse can work with standard CSR/CSC formats, so this is a lightweight
 * wrapper that doesn't require special matrix structures like Pardiso or Accelerate.
 */
class SparseMatrixSuiteSparse : public SparseMatrix {
public:
    /**
     * @brief Constructor
     * @param rows Number of rows
     * @param cols Number of columns
     */
    SparseMatrixSuiteSparse(llong rows, llong cols);
    
    /**
     * @brief Constructor from Eigen matrix
     * @param eigenSparseMatrix Eigen sparse matrix
     */
    SparseMatrixSuiteSparse(dmat eigenSparseMatrix);
    
    /**
     * @brief Destructor
     */
    virtual ~SparseMatrixSuiteSparse() override = default;
    
    // No special implementation needed - base class handles everything
};

} // namespace sparsematrix
} // namespace wfes

#endif // SPARSEMATRIXSUITESPARSE_H