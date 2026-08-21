# PHASE-TYPE-DIST binary
add_executable(phase_type_dist src/phase_type_dist_main.cpp)

# Link against shared libraries
target_link_libraries(phase_type_dist wfes_shared cli_utils)

# Set target properties
set_target_properties(phase_type_dist PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin
)