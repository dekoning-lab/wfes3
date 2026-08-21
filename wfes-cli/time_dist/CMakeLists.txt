# TIME-DIST binary
add_executable(time_dist src/time_dist_main.cpp)

# Link against shared libraries
target_link_libraries(time_dist wfes_shared cli_utils)

# Set target properties
set_target_properties(time_dist PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin
)