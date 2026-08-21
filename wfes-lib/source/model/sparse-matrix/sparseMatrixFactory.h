#ifndef SPARSEMATRIXFACTORY_H
#define SPARSEMATRIXFACTORY_H

#include "sparseMatrix.h"
#include "backend_config.h"

/**
 * @file sparseMatrixFactory.h
 * @brief Factory class for creating platform-specific sparse matrices
 * 
 * This factory provides runtime selection of sparse matrix backends based on
 * platform availability and user preference. It automatically includes only
 * the backends available at compile time.
 */

// Include backend-specific headers based on platform
#ifdef WFES_USE_MKL
    #include "model/sparse-matrix/pardiso/sparseMatrixPardiso.h"
#endif

#ifdef WFES_USE_ACCELERATE
    #include "model/sparse-matrix/accelerate/sparseMatrixAccelerate.h"
#endif

#ifdef WFES_USE_VIENNACL
    #include "model/sparse-matrix/viennacl/sparseMatrixViennacl.h"
#endif

#ifdef WFES_USE_SUITESPARSE
    #include "model/sparse-matrix/suitesparse/sparseMatrixSuiteSparse.h"
#endif

#include <Eigen/SparseCore>

namespace wfes {
    namespace sparsematrix{

        /**
         * @class SparseMatrixFactory
         * @brief Factory for creating appropriate sparse matrix instances
         * 
         * Uses the Factory design pattern to instantiate the correct sparse
         * matrix implementation based on the requested backend library.
         * Supports:
         * - Pardiso (Intel MKL) - High performance CSR format
         * - Accelerate (macOS) - Native Apple sparse format
         * - ViennaCL - OpenCL-based, cross-platform
         * - SuiteSparse - Open source CSC format
         */
        class SparseMatrixFactory{
            public:

                /**
                 * @brief Create an empty sparse matrix for the specified backend
                 * 
                 * Factory method that instantiates the appropriate sparse matrix
                 * based on the library name and compile-time configuration.
                 * The matrix is initialized empty and ready for row-by-row construction.
                 * 
                 * @param library Backend library name ("Pardiso", "Accelerate", "ViennaCL", "SuiteSparse")
                 * @param numRows Number of rows in the matrix
                 * @param numCols Number of columns in the matrix
                 * @return SparseMatrix* Pointer to the created sparse matrix instance
                 * @throws std::runtime_error if the requested backend is not available
                 * @note Caller is responsible for deleting the returned pointer
                 */
                static SparseMatrix* createSparseMatrix(std::string library, llong numRows, llong numCols);

                /**
                 * @brief Create a sparse matrix from an Eigen dense matrix
                 * 
                 * Converts a dense Eigen matrix to the appropriate sparse format
                 * for the requested backend. Useful for testing and small matrices.
                 * 
                 * @param library Backend library name ("Pardiso", "Accelerate", "ViennaCL", "SuiteSparse")
                 * @param eigenSparseMatrix Dense matrix to convert (despite the parameter name)
                 * @return SparseMatrix* Pointer to the created sparse matrix instance
                 * @throws std::runtime_error if the requested backend is not available
                 * @note Caller is responsible for deleting the returned pointer
                 * @warning The parameter name is misleading - it accepts a dense matrix
                 */
                static SparseMatrix* createSparseMatrix(std::string library, dmat eigenSparseMatrix);

        };

    }
}
#endif // SPARSEMATRIXFACTORY_H
