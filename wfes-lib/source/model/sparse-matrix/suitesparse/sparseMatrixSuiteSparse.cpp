#include "sparseMatrixSuiteSparse.h"

namespace wfes {
namespace sparsematrix {

SparseMatrixSuiteSparse::SparseMatrixSuiteSparse(llong rows, llong cols) 
    : SparseMatrix(rows, cols) {
    // Base class handles all the functionality
    // SuiteSparse works with standard CSR format which the base class provides
}

SparseMatrixSuiteSparse::SparseMatrixSuiteSparse(dmat eigenSparseMatrix)
    : SparseMatrix(eigenSparseMatrix.rows(), eigenSparseMatrix.cols()) {
    // For now, we'll just create an empty matrix with the right dimensions
    // The actual matrix data will be filled by the Wright-Fisher construction
}

} // namespace sparsematrix
} // namespace wfes