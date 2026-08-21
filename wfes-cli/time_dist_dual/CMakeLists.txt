# TIME-DIST-DUAL binary
add_executable(time_dist_dual src/time_dist_dual_main.cpp)

# Link against shared libraries
target_link_libraries(time_dist_dual wfes_shared cli_utils)

# Set target properties
set_target_properties(time_dist_dual PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin
)