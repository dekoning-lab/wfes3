#include "sparseMatrix.h"

wfes::sparsematrix::SparseMatrix::SparseMatrix(int num_rows, int num_cols)
        : num_non_zeros(0), num_rows(num_rows), num_cols(num_cols) {}
