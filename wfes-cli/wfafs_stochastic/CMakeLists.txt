cmake_minimum_required(VERSION 3.16)

# Add the executable
add_executable(wfafs_stochastic
    src/wfafs_stochastic_main.cpp
)

# Link with shared libraries
target_link_libraries(wfafs_stochastic
    wfes_shared
    cli_utils
)

# Set target properties
set_target_properties(wfafs_stochastic PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
)