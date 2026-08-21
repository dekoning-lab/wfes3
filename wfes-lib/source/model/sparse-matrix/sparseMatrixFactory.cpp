#include "sparseMatrixFactory.h"

using namespace wfes::sparsematrix;

SparseMatrix* SparseMatrixFactory::createSparseMatrix(std::string library, llong numRows, llong numCols) {
#ifdef WFES_USE_MKL
    if(library.compare("Pardiso") == 0){
        return new pardiso::SparseMatrixPardiso(numRows, numCols);
    }
#endif

#ifdef WFES_USE_ACCELERATE
    if(library.compare("Accelerate") == 0){
        return new SparseMatrixAccelerate(numRows, numCols);
    }
#endif

#ifdef WFES_USE_SUITESPARSE
    if(library.compare("SuiteSparse") == 0){
        return new SparseMatrixSuiteSparse(numRows, numCols);
    }
#endif

#ifdef WFES_USE_VIENNACL
    if(library.compare("ViennaCL") == 0){
        return new vienna::SparseMatrixViennaCL(numRows, numCols);
    }
#endif

    // Default based on platform
#ifdef WFES_USE_MKL
    return new pardiso::SparseMatrixPardiso(numRows, numCols);
#elif defined(WFES_USE_ACCELERATE)
    return new SparseMatrixAccelerate(numRows, numCols);
#elif defined(WFES_USE_SUITESPARSE)
    return new SparseMatrixSuiteSparse(numRows, numCols);
#else
    return new vienna::SparseMatrixViennaCL(numRows, numCols);
#endif
}

SparseMatrix* SparseMatrixFactory::createSparseMatrix(std::string library, dmat eigenSparseMatrix) {
#ifdef WFES_USE_MKL
    if(library.compare("Pardiso") == 0){
        return new pardiso::SparseMatrixPardiso(eigenSparseMatrix);
    }
#endif

#ifdef WFES_USE_ACCELERATE
    if(library.compare("Accelerate") == 0){
        return new SparseMatrixAccelerate(eigenSparseMatrix);
    }
#endif

#ifdef WFES_USE_SUITESPARSE
    if(library.compare("SuiteSparse") == 0){
        return new SparseMatrixSuiteSparse(eigenSparseMatrix);
    }
#endif

#ifdef WFES_USE_VIENNACL
    if(library.compare("ViennaCL") == 0){
        return new vienna::SparseMatrixViennaCL(eigenSparseMatrix);
    }
#endif

    // Default based on platform
#ifdef WFES_USE_MKL
    return new pardiso::SparseMatrixPardiso(eigenSparseMatrix);
#elif defined(WFES_USE_ACCELERATE)
    return new SparseMatrixAccelerate(eigenSparseMatrix);
#elif defined(WFES_USE_SUITESPARSE)
    return new SparseMatrixSuiteSparse(eigenSparseMatrix);
#else
    return new vienna::SparseMatrixViennaCL(eigenSparseMatrix);
#endif
}
