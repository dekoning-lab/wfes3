# wfes_sweep CLI executable

add_executable(wfes_sweep
    src/wfes_sweep_main.cpp
)

# Do NOT add ${OpenMP_CXX_LIBRARIES} or OpenMP::OpenMP_CXX here: on macOS those
# point at LLVM's own libomp, which would be loaded ALONGSIDE the standalone
# libomp that wfes_shared/SuiteSparse use, aborting at startup with
# "OMP: Error #15". wfes_shared already propagates the correct OpenMP runtime.
target_link_libraries(wfes_sweep
    wfes_shared
    cli_utils
    ${MKL_LIBRARIES}
)

target_compile_definitions(wfes_sweep PRIVATE WFES_CLI)

# Set output directory
set_target_properties(wfes_sweep PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
)