cmake_minimum_required(VERSION 3.10)
project(wfes_single)

# wfes_single_cli executable
add_executable(wfes_single
    src/wfes_single_main.cpp
)

target_include_directories(wfes_single PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_SOURCE_DIR}/include
    ${CMAKE_SOURCE_DIR}/src  # For core/args_parser.hpp
    ${WFES_LIB_SOURCE_DIR}  # Include the original source directory
)

# Link with the wfes_shared library that uses the original source files and CLI utils
target_link_libraries(wfes_single wfes_shared ${CLI_UTILS})

# Set output directory
set_target_properties(wfes_single PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
)