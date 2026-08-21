# phase_type_moments executable
add_executable(phase_type_moments
    src/phase_type_moments_main.cpp
)

target_include_directories(phase_type_moments PRIVATE
    ${CMAKE_SOURCE_DIR}/include
    ${CMAKE_SOURCE_DIR}/../wfes-lib/source
    ${EIGEN3_INCLUDE_DIR}
    ${Boost_INCLUDE_DIRS}
    ${SUITESPARSE_INCLUDE_DIRS}
)

target_link_libraries(phase_type_moments 
    wfes_shared
    cli_utils
    ${SYSTEM_LIBS}
)

# OpenMP support is inherited from wfes_shared. Do NOT link OpenMP::OpenMP_CXX
# (or ${OpenMP_CXX_LIBRARIES}) here: on macOS that imported target points at
# LLVM's own libomp, which would be loaded ALONGSIDE the standalone libomp that
# wfes_shared/SuiteSparse use, aborting at startup with "OMP: Error #15".

# Platform-specific libraries
if(APPLE)
    target_link_libraries(phase_type_moments "-framework Accelerate")
elseif(UNIX AND NOT APPLE)
    if(MKL_FOUND)
        target_link_libraries(phase_type_moments ${MKL_LIBRARIES})
    endif()
endif()

# ViennaCL/OpenCL
if(OpenCL_FOUND)
    target_link_libraries(phase_type_moments ${OpenCL_LIBRARY})
endif()

# Set runtime output directory
set_target_properties(phase_type_moments PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
)