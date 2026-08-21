#ifndef BACKEND_CONFIG_H
#define BACKEND_CONFIG_H

// Platform and backend detection configuration for WFES
// This file handles the mutual exclusion between MKL and Apple Accelerate

// Detect platform and set backend flags
#ifdef __APPLE__
    // On macOS the backend is Accelerate, optionally with SuiteSparse.
    // MKL is not supported on Apple Silicon
    #define WFES_PLATFORM_MACOS
    
    // Check if we're on Apple Silicon
    #if defined(__aarch64__) || defined(__arm64__)
        #define WFES_APPLE_SILICON
    #endif
    
    // Check for SuiteSparse availability
    #ifdef __has_include
        #if __has_include(<suitesparse/umfpack.h>)
            #define WFES_HAS_SUITESPARSE
        #endif
    #endif
    
    // Default to Accelerate on macOS unless explicitly disabled
    #if !defined(WFES_DISABLE_ACCELERATE) && !defined(WFES_USE_ACCELERATE)
        #define WFES_USE_ACCELERATE
    #endif
    
    #ifdef WFES_USE_ACCELERATE
        #include <Accelerate/Accelerate.h>
    #endif
    
    // Enable SuiteSparse if available and requested
    #ifdef WFES_ENABLE_SUITESPARSE
        #ifdef WFES_HAS_SUITESPARSE
            #define WFES_USE_SUITESPARSE
        #endif
    #endif
    
    // ParU backend detection (part of SuiteSparse)
    #if defined(WFES_USE_SUITESPARSE) && !defined(WFES_DISABLE_PARU)
        #define WFES_USE_PARU
        // Don't include ParU.h globally - let individual files include it as needed
    #endif
    
    // MKL is only available on Intel Macs, and even then it's deprecated
    #ifdef WFES_FORCE_MKL
        #ifndef WFES_APPLE_SILICON
            #define WFES_USE_MKL
            #include <mkl.h>
        #else
            #error "MKL is not supported on Apple Silicon"
        #endif
    #endif
    
#else
    // On non-Apple platforms (Linux, Windows), use MKL by default
    #define WFES_PLATFORM_LINUX
    
    // Check for SuiteSparse availability
    #ifdef __has_include
        #if __has_include(<suitesparse/umfpack.h>)
            #define WFES_HAS_SUITESPARSE
        #endif
    #endif
    
    #ifndef WFES_DISABLE_MKL
        #define WFES_USE_MKL
        #include <mkl.h>
    #endif
    
    // Enable SuiteSparse if available and requested
    #ifdef WFES_ENABLE_SUITESPARSE
        #ifdef WFES_HAS_SUITESPARSE
            #define WFES_USE_SUITESPARSE
        #endif
    #endif
    
    // ParU backend detection (part of SuiteSparse)
    #if defined(WFES_USE_SUITESPARSE) && !defined(WFES_DISABLE_PARU)
        #define WFES_USE_PARU
        // Don't include ParU.h globally - let individual files include it as needed
    #endif
#endif

// (The ViennaCL block that used to sit here defined VIENNACL_WITH_OPENCL when
//  WFES_USE_VIENNACL was set. The ViennaCL sparse-matrix and solver classes were
//  deleted -- they compiled into every binary and were reachable from none --
//  so nothing can satisfy that macro any more. Everything below must therefore
//  stop counting ViennaCL as a backend: it would let the "at least one backend"
//  guard pass with no backend at all, and it advertised a backend the binary
//  does not contain.)

// Validate that we have at least one backend enabled
#if !defined(WFES_USE_MKL) && !defined(WFES_USE_ACCELERATE) && !defined(WFES_USE_SUITESPARSE)
    #error "No linear algebra backend enabled. Enable MKL, Accelerate, or SuiteSparse."
#endif

// Ensure MKL and Accelerate are mutually exclusive
#if defined(WFES_USE_MKL) && defined(WFES_USE_ACCELERATE)
    #error "MKL and Apple Accelerate cannot be used simultaneously. Choose one backend."
#endif

// Backend identification strings
#ifdef WFES_USE_MKL
    #define WFES_DEFAULT_BACKEND "Pardiso"
    #ifdef WFES_USE_SUITESPARSE
        #define WFES_AVAILABLE_BACKENDS "Pardiso, SuiteSparse"
    #else
        #define WFES_AVAILABLE_BACKENDS "Pardiso"
    #endif
#elif defined(WFES_USE_ACCELERATE)
    #define WFES_DEFAULT_BACKEND "Accelerate"
    #ifdef WFES_USE_SUITESPARSE
        #define WFES_AVAILABLE_BACKENDS "Accelerate, SuiteSparse"
    #else
        #define WFES_AVAILABLE_BACKENDS "Accelerate"
    #endif
#else  // WFES_USE_SUITESPARSE -- the only remaining possibility, per the guard above
    #define WFES_DEFAULT_BACKEND "SuiteSparse"
    #define WFES_AVAILABLE_BACKENDS "SuiteSparse"
#endif

// Platform-specific constants
#ifdef WFES_USE_MKL
    // MKL uses 64-bit integers for large matrices
    #define MKL_ILP64
#endif

#endif // BACKEND_CONFIG_H