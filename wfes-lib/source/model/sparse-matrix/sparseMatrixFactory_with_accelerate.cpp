#include "sparseMatrixFactory.h"
#include "backend_config.h"

// Include backend-specific headers based on platform
#ifdef WFES_USE_MKL
    #include "pardiso/sparseMatrixPardiso.h"
#endif

#ifdef WFES_USE_ACCELERATE
    #include "accelerate/sparseMatrixAccelerate.h"
#endif

#ifdef WFES_USE_VIENNACL
    #include "viennacl/sparseMatrixViennacl.h"
#endif


using namespace wfes::sparsematrix;

SparseMatrix* SparseMatrixFactory::createSparseMatrix(std::string library, llong numRows, llong numCols) {
    // Handle Pardiso request
    if(library.compare("Pardiso") == 0) {
        #ifdef WFES_USE_MKL
            using namespace wfes::pardiso;
            return new SparseMatrixPardiso(numRows, numCols);
        #else
            throw std::runtime_error("Pardiso sparse matrix not available on this platform. Use Accelerate or ViennaCL instead.");
        #endif
    }
    // Handle Accelerate request
    else if(library.compare("Accelerate") == 0) {
        #ifdef WFES_USE_ACCELERATE
            using namespace wfes::sparsematrix;
            return new SparseMatrixAccelerate(numRows, numCols);
        #else
            throw std::runtime_error("Accelerate sparse matrix not available on this platform. Use Pardiso or ViennaCL instead.");
        #endif
    }
    // Handle ViennaCL request
    else if(library.compare("ViennaCL") == 0) {
        #ifdef WFES_USE_VIENNACL
            using namespace wfes::vienna;
            return new SparseMatrixViennaCL(numRows, numCols);
        #else
            throw std::runtime_error("ViennaCL sparse matrix not available. OpenCL support required.");
        #endif
    }
    // Handle SuiteSparse request (use Accelerate matrices on macOS for best compatibility)
    else if(library.compare("SuiteSparse") == 0) {
        #ifdef WFES_USE_ACCELERATE
            using namespace wfes::sparsematrix;
            return new SparseMatrixAccelerate(numRows, numCols);
        #elif defined(WFES_USE_VIENNACL)
            using namespace wfes::vienna;
            return new SparseMatrixViennaCL(numRows, numCols);
        #else
            throw std::runtime_error("SuiteSparse matrices not available. Need Accelerate or ViennaCL support.");
        #endif
    }
    // Handle ParU request (use same matrices as SuiteSparse)
    else if(library.compare("ParU") == 0) {
        #ifdef WFES_USE_ACCELERATE
            using namespace wfes::sparsematrix;
            return new SparseMatrixAccelerate(numRows, numCols);
        #elif defined(WFES_USE_VIENNACL)
            using namespace wfes::vienna;
            return new SparseMatrixViennaCL(numRows, numCols);
        #else
            throw std::runtime_error("ParU matrices not available. Need Accelerate or ViennaCL support.");
        #endif
    }
    // Default based on platform
    else {
        #ifdef WFES_USE_ACCELERATE
            // On macOS, we can't easily create empty sparse matrices with Accelerate
            // Default to ViennaCL if available
            #ifdef WFES_USE_VIENNACL
                using namespace wfes::vienna;
                return new SparseMatrixViennaCL(numRows, numCols);
            #else
                throw std::runtime_error("Cannot create empty sparse matrix with Accelerate. Use from dense matrix instead.");
            #endif
        #elif defined(WFES_USE_MKL)
            // On Linux/Windows, default to Pardiso
            using namespace wfes::pardiso;
            return new SparseMatrixPardiso(numRows, numCols);
        #elif defined(WFES_USE_VIENNACL)
            // If only ViennaCL is available
            using namespace wfes::vienna;
            return new SparseMatrixViennaCL(numRows, numCols);
        #else
            throw std::runtime_error("No sparse matrix backend available!");
        #endif
    }
}

SparseMatrix* SparseMatrixFactory::createSparseMatrix(std::string library, dmat eigenSparseMatrix) {
    // Handle Pardiso request
    if(library.compare("Pardiso") == 0) {
        #ifdef WFES_USE_MKL
            using namespace wfes::pardiso;
            return new SparseMatrixPardiso(eigenSparseMatrix);
        #else
            throw std::runtime_error("Pardiso sparse matrix not available on this platform. Use Accelerate or ViennaCL instead.");
        #endif
    }
    // Handle Accelerate request
    else if(library.compare("Accelerate") == 0) {
        #ifdef WFES_USE_ACCELERATE
            using namespace wfes::sparsematrix;
            return new SparseMatrixAccelerate(eigenSparseMatrix);
        #else
            throw std::runtime_error("Accelerate sparse matrix not available on this platform. Use Pardiso or ViennaCL instead.");
        #endif
    }
    // Handle ViennaCL request
    else if(library.compare("ViennaCL") == 0) {
        #ifdef WFES_USE_VIENNACL
            using namespace wfes::vienna;
            return new SparseMatrixViennaCL(eigenSparseMatrix);
        #else
            throw std::runtime_error("ViennaCL sparse matrix not available. OpenCL support required.");
        #endif
    }
    // Handle SuiteSparse request (use Accelerate matrices on macOS for best compatibility)
    else if(library.compare("SuiteSparse") == 0) {
        #ifdef WFES_USE_ACCELERATE
            using namespace wfes::sparsematrix;
            return new SparseMatrixAccelerate(eigenSparseMatrix);
        #elif defined(WFES_USE_VIENNACL)
            using namespace wfes::vienna;
            return new SparseMatrixViennaCL(eigenSparseMatrix);
        #else
            throw std::runtime_error("SuiteSparse matrices not available. Need Accelerate or ViennaCL support.");
        #endif
    }
    // Handle ParU request (use same matrices as SuiteSparse)
    else if(library.compare("ParU") == 0) {
        #ifdef WFES_USE_ACCELERATE
            using namespace wfes::sparsematrix;
            return new SparseMatrixAccelerate(eigenSparseMatrix);
        #elif defined(WFES_USE_VIENNACL)
            using namespace wfes::vienna;
            return new SparseMatrixViennaCL(eigenSparseMatrix);
        #else
            throw std::runtime_error("ParU matrices not available. Need Accelerate or ViennaCL support.");
        #endif
    }
    // Default based on platform
    else {
        #ifdef WFES_USE_ACCELERATE
            // On macOS, default to Accelerate
            using namespace wfes::sparsematrix;
            return new SparseMatrixAccelerate(eigenSparseMatrix);
        #elif defined(WFES_USE_MKL)
            // On Linux/Windows, default to Pardiso
            using namespace wfes::pardiso;
            return new SparseMatrixPardiso(eigenSparseMatrix);
        #elif defined(WFES_USE_VIENNACL)
            // If only ViennaCL is available
            using namespace wfes::vienna;
            return new SparseMatrixViennaCL(eigenSparseMatrix);
        #else
            throw std::runtime_error("No sparse matrix backend available!");
        #endif
    }
}