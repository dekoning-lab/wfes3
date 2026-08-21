# TIME-DIST-SGV binary
add_executable(time_dist_sgv src/time_dist_sgv_main.cpp)

# Link against shared libraries
target_link_libraries(time_dist_sgv wfes_shared cli_utils)

# Set target properties
set_target_properties(time_dist_sgv PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin
)