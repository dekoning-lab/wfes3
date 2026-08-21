# WFES-SWITCHING binary
add_executable(wfes_switching src/wfes_switching_main.cpp)

# Link against shared libraries
target_link_libraries(wfes_switching wfes_shared cli_utils)

# Set target properties
set_target_properties(wfes_switching PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin
)