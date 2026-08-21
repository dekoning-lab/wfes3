cmake_minimum_required(VERSION 3.16)

# Add the executable
add_executable(wfafs_deterministic
    src/wfafs_deterministic_main.cpp
)

# Link with shared libraries
target_link_libraries(wfafs_deterministic
    wfes_shared
    cli_utils
)

# Set target properties
set_target_properties(wfafs_deterministic PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
)