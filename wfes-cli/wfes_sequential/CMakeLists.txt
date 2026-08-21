# WFES-SEQUENTIAL binary
add_executable(wfes_sequential src/wfes_sequential_main.cpp)

# Link against shared libraries
target_link_libraries(wfes_sequential wfes_shared cli_utils)

# Set target properties
set_target_properties(wfes_sequential PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin
)