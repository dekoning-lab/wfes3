#ifndef BACKEND_TYPES_H
#define BACKEND_TYPES_H

#include "backend_config.h"
#include <string>
#include <memory>

// Abstract types that map to backend-specific implementations
// This allows us to write backend-agnostic code in the core algorithms

namespace wfes {
namespace backend {

// Status codes abstraction
#ifdef WFES_USE_MKL
    typedef sparse_status_t backend_status_t;
    constexpr auto BACKEND_STATUS_SUCCESS = SPARSE_STATUS_SUCCESS;
    constexpr auto BACKEND_STATUS_NOT_INITIALIZED = SPARSE_STATUS_NOT_INITIALIZED;
    constexpr auto BACKEND_STATUS_ALLOC_FAILED = SPARSE_STATUS_ALLOC_FAILED;
    constexpr auto BACKEND_STATUS_INVALID_VALUE = SPARSE_STATUS_INVALID_VALUE;
    constexpr auto BACKEND_STATUS_EXECUTION_FAILED = SPARSE_STATUS_EXECUTION_FAILED;
    constexpr auto BACKEND_STATUS_INTERNAL_ERROR = SPARSE_STATUS_INTERNAL_ERROR;
    constexpr auto BACKEND_STATUS_NOT_SUPPORTED = SPARSE_STATUS_NOT_SUPPORTED;
    
#elif defined(WFES_USE_ACCELERATE)
    typedef SparseStatus_t backend_status_t;
    constexpr auto BACKEND_STATUS_SUCCESS = SparseStatusOK;
    constexpr auto BACKEND_STATUS_NOT_INITIALIZED = -10;  // Custom value
    constexpr auto BACKEND_STATUS_ALLOC_FAILED = -11;     // Custom value
    constexpr auto BACKEND_STATUS_INVALID_VALUE = SparseParameterError;
    constexpr auto BACKEND_STATUS_EXECUTION_FAILED = SparseFactorizationFailed;
    constexpr auto BACKEND_STATUS_INTERNAL_ERROR = SparseInternalError;
    constexpr auto BACKEND_STATUS_NOT_SUPPORTED = -12;    // Custom value
#endif

// Sparse matrix handle abstraction
#ifdef WFES_USE_MKL
    typedef sparse_matrix_t backend_sparse_matrix_handle_t;
    typedef struct matrix_descr backend_matrix_descr_t;
    typedef sparse_operation_t backend_operation_t;
    
    constexpr auto BACKEND_OPERATION_NON_TRANSPOSE = SPARSE_OPERATION_NON_TRANSPOSE;
    constexpr auto BACKEND_OPERATION_TRANSPOSE = SPARSE_OPERATION_TRANSPOSE;
    
#elif defined(WFES_USE_ACCELERATE)
    // For Accelerate, we'll need to wrap the sparse matrix types
    struct AccelerateMatrixWrapper {
        SparseMatrix_Double matrix;
        SparseAttributes_t attributes;
        int rows;
        int cols;
        long nnz;
    };
    typedef std::shared_ptr<AccelerateMatrixWrapper> backend_sparse_matrix_handle_t;
    
    // Accelerate doesn't have a direct matrix descriptor equivalent
    struct backend_matrix_descr_t {
        bool symmetric;
        bool triangular;
        bool unit_diagonal;
    };
    
    // Operation types
    enum backend_operation_t {
        BACKEND_OPERATION_NON_TRANSPOSE = 0,
        BACKEND_OPERATION_TRANSPOSE = 1
    };
#endif

// Solver configuration abstraction
struct BackendSolverConfig {
    int max_iterations = 1000;
    double tolerance = 1e-10;
    bool verbose = false;
    int num_threads = 1;
    
    // Backend-specific parameters can be added via subclassing
#ifdef WFES_USE_MKL
    long long iparm[64];  // Pardiso parameters
    long long maxfct = 1;
    long long mnum = 1;
    long long phase = 13;
    long long msglvl = 0;
#elif defined(WFES_USE_ACCELERATE)
    SparseFactorization_t factorization_type = SparseFactorizationQR;
    SparseOrder_t ordering = SparseOrderDefault;
    bool use_iterative_refinement = true;
#endif
};

// Helper functions for backend name resolution
inline std::string getDefaultBackend() {
    return WFES_DEFAULT_BACKEND;
}

inline std::string getAvailableBackends() {
    return WFES_AVAILABLE_BACKENDS;
}

inline bool isBackendAvailable(const std::string& backend) {
#ifdef WFES_USE_MKL
    if (backend == "Pardiso") return true;
#endif
#ifdef WFES_USE_ACCELERATE
    if (backend == "Accelerate") return true;
#endif
#ifdef WFES_USE_VIENNACL
    if (backend == "ViennaCL") return true;
#endif
#ifdef WFES_USE_SUITESPARSE
    if (backend == "SuiteSparse") return true;
#endif
#ifdef WFES_USE_PARU
    if (backend == "ParU") return true;
#endif
    return false;
}

// Error handling
inline std::string getStatusString(backend_status_t status) {
#ifdef WFES_USE_MKL
    switch(status) {
        case BACKEND_STATUS_SUCCESS:
            return "Success";
        case BACKEND_STATUS_NOT_INITIALIZED:
            return "Not initialized";
        case BACKEND_STATUS_ALLOC_FAILED:
            return "Memory allocation failed";
        case BACKEND_STATUS_INVALID_VALUE:
            return "Invalid parameter value";
        case BACKEND_STATUS_EXECUTION_FAILED:
            return "Execution failed";
        case BACKEND_STATUS_INTERNAL_ERROR:
            return "Internal error";
        case BACKEND_STATUS_NOT_SUPPORTED:
            return "Operation not supported";
        default:
            return "Unknown error";
    }
#elif defined(WFES_USE_ACCELERATE)
    // For Accelerate, handle both enum values and custom values
    if (status == BACKEND_STATUS_SUCCESS) return "Success";
    if (status == BACKEND_STATUS_NOT_INITIALIZED) return "Not initialized";
    if (status == BACKEND_STATUS_ALLOC_FAILED) return "Memory allocation failed";
    if (status == BACKEND_STATUS_NOT_SUPPORTED) return "Operation not supported";
    
    switch(status) {
        case SparseParameterError:
            return "Invalid parameter value";
        case SparseFactorizationFailed:
            return "Execution failed";
        case SparseInternalError:
            return "Internal error";
        default:
            return "Unknown error";
    }
#else
    return "Backend not configured";
#endif
}

} // namespace backend
} // namespace wfes

#endif // BACKEND_TYPES_H