cmake_minimum_required(VERSION 3.10)

# ---------------------------------------------------------------------------
# Toolchain selection
#
# The macOS build pins the Homebrew LLVM toolchain and its libc++, because the
# Apple system libc++ does not provide everything -std=c++23 needs here and
# because SuiteSparse's Homebrew bottle is built against that stack.
#
# This block used to run unconditionally, which made the project impossible to
# even CONFIGURE on Linux: `brew` is absent, so the FATAL_ERROR below fired
# before the Linux branches were ever reached. Linux now uses the system
# compiler (or whatever CC/CXX the caller exports).
# ---------------------------------------------------------------------------
if(APPLE)
    # Detect Homebrew LLVM installation properly (Apple Silicon vs Intel)
    execute_process(COMMAND brew --prefix llvm
                    OUTPUT_VARIABLE LLVM_ROOT
                    OUTPUT_STRIP_TRAILING_WHITESPACE
                    RESULT_VARIABLE _err)
    if(NOT _err EQUAL 0)
        message(FATAL_ERROR "Homebrew LLVM not found. Please install with: brew install llvm")
    endif()

    # Use Homebrew Clang toolchain
    set(CMAKE_C_COMPILER   "${LLVM_ROOT}/bin/clang")
    set(CMAKE_CXX_COMPILER "${LLVM_ROOT}/bin/clang++")

    # Define Homebrew libc++ location
    set(LLVM_CXX_LIBDIR "${LLVM_ROOT}/lib/c++")
endif()

project(WFES_CMD VERSION 1.0)

if(APPLE)
    # Global compile options - ensure complete Homebrew C++ stack
    add_compile_options(
        -std=c++23
        -nostdinc++
        -isystem ${LLVM_ROOT}/include/c++/v1
        -D_LIBCPP_ENABLE_CXX17_REMOVED_UNARY_BINARY_FUNCTION
        -Wno-fortify-source  # Suppress harmless warnings from Boost library
    )

    # Global link options - force Homebrew libc++ runtime
    add_link_options(
        -L${LLVM_CXX_LIBDIR}
        -Wl,-rpath,${LLVM_CXX_LIBDIR}
        -lc++
        -lc++abi
    )

    # Ensure shared libraries also get the correct rpath
    set(CMAKE_INSTALL_RPATH "${LLVM_CXX_LIBDIR}")
    set(CMAKE_SHARED_LINKER_FLAGS "${CMAKE_SHARED_LINKER_FLAGS} -L${LLVM_CXX_LIBDIR} -Wl,-rpath,${LLVM_CXX_LIBDIR}")
    set(CMAKE_MODULE_LINKER_FLAGS "${CMAKE_MODULE_LINKER_FLAGS} -L${LLVM_CXX_LIBDIR} -Wl,-rpath,${LLVM_CXX_LIBDIR}")
else()
    # Let CMake pick the right -std spelling for whichever compiler is in use
    # (GCC < 13 wants -std=c++2b, GCC >= 13 and Clang accept -std=c++23).
    set(CMAKE_CXX_STANDARD 23)
    set(CMAKE_CXX_STANDARD_REQUIRED ON)
    set(CMAKE_CXX_EXTENSIONS OFF)
endif()

# Define WFES_CLI for all targets to enable conditional compilation
add_compile_definitions(WFES_CLI)

# Enable OpenMP if available.
#
# CAREFUL: on macOS there are TWO OpenMP runtimes in a Homebrew install --
# LLVM's own ${LLVM_ROOT}/lib/libomp.dylib, and the standalone `libomp`
# formula at $(brew --prefix libomp)/lib/libomp.dylib. They have different
# install names, so dyld loads BOTH as separate images if both get linked,
# and the second runtime to initialize aborts the process with:
#
#   OMP: Error #15: Initializing libomp.dylib, but found libomp.dylib
#   already initialized.
#
# Homebrew's suite-sparse bottle (libcholmod, libparu, libsuitesparseconfig)
# links the STANDALONE libomp. Since SuiteSparse is a hard runtime dependency
# of the Accelerate backend, we must link the same standalone libomp rather
# than the one clang's -fopenmp driver would pick by default. Do NOT replace
# this with a bare find_package(OpenMP)/-fopenmp -- that reintroduces Error #15.
find_package(OpenMP)
if(OpenMP_CXX_FOUND)
    if(APPLE)
        execute_process(COMMAND brew --prefix libomp
                        OUTPUT_VARIABLE LIBOMP_ROOT
                        OUTPUT_STRIP_TRAILING_WHITESPACE
                        RESULT_VARIABLE _libomp_err)
        if(NOT _libomp_err EQUAL 0)
            message(FATAL_ERROR
                "Homebrew libomp not found. Install with: brew install libomp")
        endif()
        if(NOT EXISTS "${LIBOMP_ROOT}/lib/libomp.dylib")
            message(FATAL_ERROR
                "Expected ${LIBOMP_ROOT}/lib/libomp.dylib but it is missing.")
        endif()
        # Enable the pragmas without letting the driver auto-link its own
        # libomp, then link the standalone runtime by absolute path so exactly
        # one OpenMP image is loaded (the same one SuiteSparse pulls in).
        add_compile_options(-Xpreprocessor -fopenmp -I${LIBOMP_ROOT}/include)
        set(WFES_OPENMP_LIBRARY "${LIBOMP_ROOT}/lib/libomp.dylib")
        add_link_options(-Wl,-rpath,${LIBOMP_ROOT}/lib)
        message(STATUS "OpenMP: using standalone Homebrew libomp at ${LIBOMP_ROOT}")
    else()
        set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} ${OpenMP_CXX_FLAGS}")
    endif()
    add_compile_definitions(OMP)
endif()

# Platform-specific settings
if(APPLE)
    # macOS settings
    # Disable OpenMP in Eigen since it's not available on macOS by default
    add_compile_definitions(EIGEN_DONT_PARALLELIZE)
    include_directories(/usr/local/include)
    
    # We're on Apple Silicon - use Accelerate framework
    add_compile_definitions(WFES_USE_ACCELERATE)
elseif(UNIX AND NOT APPLE)
    # Linux settings. backend_config.h turns on WFES_USE_MKL for every
    # non-Apple platform, so Pardiso is the default backend here.
    #
    # MKL_ILP64 selects the 64-bit-integer interface, which must match the
    # libmkl_intel_ilp64 chosen in the link block below. wfes-lib calls
    # pardiso_64 and passes llong (int64) index arrays, so ILP64 is mandatory
    # -- linking the LP64 interface instead compiles and links cleanly and then
    # silently misreads every index array.
    set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -fopenmp -DMKL_ILP64 -m64")

    # Statically link the GCC runtime (libstdc++, libgcc). Binaries built with
    # a modules/toolchain GCC otherwise carry GLIBCXX version needs the system
    # libstdc++ cannot satisfy -- on ARC every tool died with "GLIBCXX_3.4.26
    # not found" the moment the gcc module was not loaded, and a packaged app
    # on a user's machine is exactly that situation. libgomp has no static
    # -l option here; it is bundled by bundle-bin-linux.sh instead (its
    # non-system path shows up in ldd when built with a toolchain GCC).
    set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -static-libgcc -static-libstdc++")

    # OpenMP runtime selection for MKL. This is the Linux twin of the macOS
    # duplicate-libomp problem handled near the top of this file: MKL's
    # "intel_thread" layer pulls in libiomp5, while -fopenmp under GCC links
    # libgomp. Loading both OpenMP runtimes in one process is unsupported and
    # produces either an abort or silent oversubscription.
    #
    #   gnu        - libmkl_gnu_thread + libgomp   (correct for GCC; default)
    #   intel      - libmkl_intel_thread + libiomp5 (correct for icc/clang when
    #                the compiler is NOT also linking libgomp)
    #   sequential - libmkl_sequential, no MKL-internal threading at all
    #                (slowest, but the safest thing to compare results against)
    set(WFES_MKL_THREADING "gnu" CACHE STRING
        "MKL threading layer: gnu | intel | sequential")
    set_property(CACHE WFES_MKL_THREADING PROPERTY STRINGS gnu intel sequential)
elseif(WIN32)
    # Windows settings (not a current priority but included for completeness)
    set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -openmp -arch:AVX2 -fp:fast -GL -Oi")
endif()

# Set directories for source code and dependencies
set(WFES_ROOT_DIR ${CMAKE_CURRENT_SOURCE_DIR}/..)
set(DEPENDENCIES_DIR ${WFES_ROOT_DIR}/dependencies)
set(WFES_LIB_SOURCE_DIR ${WFES_ROOT_DIR}/wfes-lib/source)

# Include directories - IMPORTANT: These include the existing source code from wfes-lib
include_directories(
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${WFES_LIB_SOURCE_DIR}
)

# Platform-specific include directories
if(APPLE)
    # Use Eigen 3.5 (development branch) to fix std::unary_function issues
    include_directories(${DEPENDENCIES_DIR}/eigen3.5/mac)
    include_directories(${DEPENDENCIES_DIR}/mac)
    # Don't include MKL headers on macOS - we'll use Accelerate instead
    # The backend_config.h will handle including the right headers
elseif(UNIX AND NOT APPLE)
    # Eigen selection.
    #
    # dependencies/unix ships Eigen 3.3.7 (2018); the validated macOS build uses
    # Eigen 3.4.90 from dependencies/eigen3.5. Default Linux to the SAME headers
    # as macOS: Eigen is header-only and expression-template heavy, so a
    # different version can reorder floating-point operations and move results
    # in the last few digits. Keeping the two platforms on one Eigen means a
    # cross-platform disagreement points at a real bug rather than at Eigen.
    #
    # Set -DWFES_EIGEN=vendored to fall back to the 3.3.7 tree (e.g. if 3.4.90
    # will not compile with an older GCC). Whichever root is chosen must come
    # first on the include path, since dependencies/unix also contains an Eigen/.
    set(WFES_EIGEN "shared" CACHE STRING
        "Eigen headers on Linux: shared (3.4.90, same as macOS) | vendored (3.3.7)")
    set_property(CACHE WFES_EIGEN PROPERTY STRINGS shared vendored)
    if(WFES_EIGEN STREQUAL "shared")
        include_directories(BEFORE ${DEPENDENCIES_DIR}/eigen3.5/eigen)
        message(STATUS "Eigen: 3.4.90 from dependencies/eigen3.5/eigen (matches macOS build)")
    else()
        message(STATUS "Eigen: 3.3.7 vendored in dependencies/unix")
    endif()

    include_directories(${DEPENDENCIES_DIR}/unix)
    include_directories(${DEPENDENCIES_DIR}/unix/intel/mkl/include)
    include_directories(${DEPENDENCIES_DIR}/unix/CL)
elseif(WIN32)
    include_directories(${DEPENDENCIES_DIR}/windows)
    include_directories(${DEPENDENCIES_DIR}/windows/intel/mkl/include)
    include_directories(${DEPENDENCIES_DIR}/windows/CL)
endif()

# Define sources that are shared with the GUI version
# IMPORTANT: We reference the original source files directly to ensure 
# both GUI and CLI versions use exactly the same implementation
set(SHARED_SOURCES
    # Core Wright-Fisher model
    ${WFES_LIB_SOURCE_DIR}/model/wright-fisher/rdist.cpp
    ${WFES_LIB_SOURCE_DIR}/model/wright-fisher/wrightFisher.cpp
    
    # Sparse matrix implementation
    ${WFES_LIB_SOURCE_DIR}/model/sparse-matrix/sparseMatrix.cpp
    ${WFES_LIB_SOURCE_DIR}/model/sparse-matrix/sparseMatrixFactory_with_accelerate.cpp

    # Solver implementation
    ${WFES_LIB_SOURCE_DIR}/model/solver/solver.cpp
    ${WFES_LIB_SOURCE_DIR}/model/solver/solverFactory_with_accelerate.cpp

    # (The ViennaCL sparse matrix and solver used to be listed here. They were
    #  compiled into every one of the 11 binaries and reachable from none of
    #  them: WFES_USE_VIENNACL is never defined anywhere in the tree, so both
    #  factories took the "ViennaCL not available" throw instead. Both classes
    #  also carried live defects behind that wall -- an empty resizeVectors()
    #  overriding a pure virtual nine Wright-Fisher builders call, and a solve()
    #  that returned an uninitialised vector for any unrecognised solver name.
    #  Deleted rather than left as a trap for whoever turns the macro on.)

    # Utility functions
    ${WFES_LIB_SOURCE_DIR}/utils/parsing.cpp
    # Note: utils.cpp contains Qt-specific code, so we'll need a CLI version
    
    # (The Qt-era ConfigWfesSingle shim used to be listed here. It existed only
    #  to define statics for a class nothing on the CLI path referenced; the
    #  three includes of its header were all dead. Removed with the Qt lineage.)
)

# Check for SuiteSparse.
#
# WFES_WITH_SUITESPARSE=OFF builds without it deliberately. That configuration
# is not just a convenience: on macOS the solver factory routes BOTH
# "--library Accelerate" and "--library SuiteSparse" to SuiteSparseSolver
# whenever SuiteSparse is present, so the pure-Accelerate backend
# (solverAccelerate.cpp) is compiled but never reachable in a normal build.
# Turning this off is the only way to exercise that code -- which matters,
# because it is what a future "reduce the dependency footprint" change would
# switch everyone onto.
option(WFES_WITH_SUITESPARSE "Use SuiteSparse/UMFPACK when available" ON)

find_path(SUITESPARSE_INCLUDE_DIR NAMES suitesparse/umfpack.h
          PATHS /opt/homebrew/include /usr/local/include /usr/include)
find_library(UMFPACK_LIBRARY NAMES umfpack 
             PATHS /opt/homebrew/lib /usr/local/lib /usr/lib)
find_library(AMD_LIBRARY NAMES amd 
             PATHS /opt/homebrew/lib /usr/local/lib /usr/lib)
find_library(SUITESPARSE_CONFIG_LIBRARY NAMES suitesparseconfig 
             PATHS /opt/homebrew/lib /usr/local/lib /usr/lib)

# Check for ParU (part of SuiteSparse)
find_library(PARU_LIBRARY NAMES paru 
             PATHS /opt/homebrew/lib /usr/local/lib /usr/lib)
find_library(CHOLMOD_LIBRARY NAMES cholmod 
             PATHS /opt/homebrew/lib /usr/local/lib /usr/lib)

if(NOT WFES_WITH_SUITESPARSE)
    message(STATUS "SuiteSparse disabled by WFES_WITH_SUITESPARSE=OFF")
elseif(SUITESPARSE_INCLUDE_DIR AND UMFPACK_LIBRARY AND AMD_LIBRARY AND SUITESPARSE_CONFIG_LIBRARY)
    set(SUITESPARSE_FOUND TRUE)
    message(STATUS "SuiteSparse found")
    include_directories(${SUITESPARSE_INCLUDE_DIR})
    add_definitions(-DWFES_ENABLE_SUITESPARSE)
    
    # Check for ParU availability
    if(PARU_LIBRARY AND CHOLMOD_LIBRARY)
        set(PARU_FOUND TRUE)
        add_definitions(-DWFES_USE_PARU)
        message(STATUS "ParU found")
    else()
        message(STATUS "ParU not found - will be disabled")
    endif()
endif()

# Platform-specific sources
if(APPLE)
    # On macOS, include Accelerate backend
    set(SHARED_SOURCES ${SHARED_SOURCES}
        ${WFES_LIB_SOURCE_DIR}/model/sparse-matrix/accelerate/sparseMatrixAccelerate.cpp
        ${WFES_LIB_SOURCE_DIR}/model/solver/accelerate/solverAccelerate.cpp
    )
    
    # Include SuiteSparse if available.
    #
    # Only the SOLVER half. sparseMatrixSuiteSparse.cpp used to be listed here
    # too, but that class overrode none of SparseMatrix's 17 pure virtuals, so
    # it was abstract and could never be constructed -- the only `new
    # SparseMatrixSuiteSparse` sites were in the superseded sparseMatrixFactory.cpp
    # that was never compiled. SuiteSparse solves against the platform's own
    # sparse-matrix class (Accelerate here, Pardiso below).
    if(SUITESPARSE_FOUND)
        set(SHARED_SOURCES ${SHARED_SOURCES}
            ${WFES_LIB_SOURCE_DIR}/model/solver/suitesparse/solverSuiteSparse.cpp
        )

        # Add ParU solver if available
        if(PARU_FOUND)
            set(SHARED_SOURCES ${SHARED_SOURCES}
                ${WFES_LIB_SOURCE_DIR}/model/solver/paru/solverParU.cpp
            )
        endif()
    endif()
else()
    # On other platforms, include Pardiso backend
    set(SHARED_SOURCES ${SHARED_SOURCES}
        ${WFES_LIB_SOURCE_DIR}/model/sparse-matrix/pardiso/sparseMatrixPardiso.cpp
        ${WFES_LIB_SOURCE_DIR}/model/solver/pardiso/solverPardiso.cpp
    )
    
    # Include SuiteSparse if available (solver only -- see the note above).
    if(SUITESPARSE_FOUND)
        set(SHARED_SOURCES ${SHARED_SOURCES}
            ${WFES_LIB_SOURCE_DIR}/model/solver/suitesparse/solverSuiteSparse.cpp
        )

        # Add ParU solver if available
        if(PARU_FOUND)
            set(SHARED_SOURCES ${SHARED_SOURCES}
                ${WFES_LIB_SOURCE_DIR}/model/solver/paru/solverParU.cpp
            )
        endif()
    endif()
endif()

# Command-line interface specific code (not shared with GUI)
set(CLI_SOURCES
    ${CMAKE_CURRENT_SOURCE_DIR}/src/core/args_parser.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/src/core/output_formatter.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/src/core/utils_cli.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/src/core/parsing_cli.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/src/core/banner.cpp
)

# Create a static library from CLI utilities to avoid recompilation
add_library(cli_utils STATIC ${CLI_SOURCES})

# Store CLI_UTILS in parent scope for subdirectories
set(CLI_UTILS cli_utils CACHE INTERNAL "CLI utilities library")

# Add subdirectories for each executable
add_subdirectory(wfes_single)
add_subdirectory(wfes_sweep)
add_subdirectory(wfes_switching)
add_subdirectory(wfes_sequential)
add_subdirectory(time_dist)
add_subdirectory(time_dist_dual)
add_subdirectory(time_dist_sgv)
add_subdirectory(phase_type_dist)
add_subdirectory(phase_type_moments)
add_subdirectory(wfafs_deterministic)
add_subdirectory(wfafs_stochastic)

# Create the shared library using the original source files
add_library(wfes_shared STATIC ${SHARED_SOURCES})

# Link platform-specific libraries
if(APPLE)
    # On macOS, use Accelerate framework instead of MKL
    target_link_libraries(wfes_shared
        "-framework Accelerate"
        "-framework OpenCL"
    )
elseif(UNIX AND NOT APPLE)
    # MKL link line. The interface layer must be ilp64 to match the -DMKL_ILP64
    # set above and the pardiso_64 calls in wfes-lib.
    set(_mkl_libdir ${DEPENDENCIES_DIR}/unix/intel/mkl/lib/intel64)

    if(WFES_MKL_THREADING STREQUAL "sequential")
        set(_mkl_threading_libs ${_mkl_libdir}/libmkl_sequential.so)
    elseif(WFES_MKL_THREADING STREQUAL "intel")
        set(_mkl_threading_libs
            ${_mkl_libdir}/libmkl_intel_thread.so
            ${DEPENDENCIES_DIR}/unix/intel/mkl/compiler/libiomp5.so)
    else()  # gnu
        # Pairs with libgomp, which -fopenmp already links under GCC. Do NOT
        # also link libiomp5 here -- that is the Linux form of the two-OpenMP
        # -runtimes failure documented at the top of this file.
        set(_mkl_threading_libs ${_mkl_libdir}/libmkl_gnu_thread.so)
    endif()
    message(STATUS "MKL threading layer: ${WFES_MKL_THREADING}")

    foreach(_lib ${_mkl_libdir}/libmkl_intel_ilp64.so ${_mkl_threading_libs}
                 ${_mkl_libdir}/libmkl_core.so)
        if(NOT EXISTS ${_lib})
            message(FATAL_ERROR
                "Missing MKL library: ${_lib}\n"
                "The vendored MKL lives in dependencies/ (extracted from "
                "dependencies.7z). Extract it, or point the build at a system "
                "MKL install.")
        endif()
    endforeach()

    target_link_libraries(wfes_shared
        ${_mkl_libdir}/libmkl_intel_ilp64.so
        ${_mkl_threading_libs}
        ${_mkl_libdir}/libmkl_core.so
    )

    # OpenCL is only needed by the ViennaCL backend, which nothing here defines
    # WFES_USE_VIENNACL for. Linking it unconditionally made the whole build
    # fail on any machine without the vendored libOpenCL.so.
    if(EXISTS ${DEPENDENCIES_DIR}/unix/CL/lib/libOpenCL.so)
        target_link_libraries(wfes_shared ${DEPENDENCIES_DIR}/unix/CL/lib/libOpenCL.so)
    endif()
elseif(WIN32)
    target_link_libraries(wfes_shared
        ${DEPENDENCIES_DIR}/windows/intel/mkl/lib/intel64_win/mkl_core_dll.lib
        ${DEPENDENCIES_DIR}/windows/intel/mkl/lib/intel64_win/mkl_intel_ilp64_dll.lib
        ${DEPENDENCIES_DIR}/windows/intel/mkl/lib/intel64_win/mkl_intel_thread_dll.lib
        ${DEPENDENCIES_DIR}/windows/intel/mkl/compiler/libiomp5md.lib
        ${DEPENDENCIES_DIR}/windows/CL/lib/OpenCL.lib
    )
endif()

# POSIX runtime libraries. Not on Windows: MSVC has no pthread/m/dl and the
# line made the WIN32 branch unlinkable.
if(NOT WIN32)
    target_link_libraries(wfes_shared pthread m dl)
endif()

# Link the single OpenMP runtime chosen above (see the OpenMP block near the
# top of this file for why this is an absolute path on macOS).
if(WFES_OPENMP_LIBRARY)
    target_link_libraries(wfes_shared ${WFES_OPENMP_LIBRARY})
endif()

# Link SuiteSparse if found
if(SUITESPARSE_FOUND)
    target_link_libraries(wfes_shared ${UMFPACK_LIBRARY} ${AMD_LIBRARY} ${SUITESPARSE_CONFIG_LIBRARY})
    
    # Link ParU if found
    if(PARU_FOUND)
        target_link_libraries(wfes_shared ${PARU_LIBRARY} ${CHOLMOD_LIBRARY})
    endif()
endif()