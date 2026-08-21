#!/bin/bash
# Build SuiteSparse with C++17 to avoid C++23 symbol conflicts

set -e

# Check if running on macOS
if [[ "$OSTYPE" != "darwin"* ]]; then
    echo "This script is for macOS only"
    exit 1
fi

# Create build directory
BUILD_DIR="$HOME/suitesparse-build"
INSTALL_PREFIX="/usr/local"

echo "Building SuiteSparse with C++17..."
echo "Build directory: $BUILD_DIR"
echo "Install prefix: $INSTALL_PREFIX"

# Clean previous build if exists
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

# Clone SuiteSparse
echo "Cloning SuiteSparse..."
git clone --depth 1 --branch v7.8.3 https://github.com/DrTimothyAldenDavis/SuiteSparse.git
cd SuiteSparse

# Configure build to use system Apple Clang and C++17
export CC=/usr/bin/clang
export CXX=/usr/bin/clang++
export CXXFLAGS="-std=c++17 -stdlib=libc++"

# Build only the components we need
echo "Building AMD (Approximate Minimum Degree ordering)..."
cd AMD && make library && cd ..

echo "Building SuiteSparse_config..."
cd SuiteSparse_config && make library && cd ..

echo "Building UMFPACK..."
cd UMFPACK && make library && cd ..

# Install
echo "Installing to $INSTALL_PREFIX..."
echo "Note: You may need to run with sudo for the install step"

# Create installation directories
sudo mkdir -p "$INSTALL_PREFIX/lib"
sudo mkdir -p "$INSTALL_PREFIX/include/suitesparse"

# Copy libraries
sudo cp lib/*.dylib "$INSTALL_PREFIX/lib/"

# Copy headers
sudo cp AMD/Include/*.h "$INSTALL_PREFIX/include/suitesparse/"
sudo cp SuiteSparse_config/*.h "$INSTALL_PREFIX/include/suitesparse/"
sudo cp UMFPACK/Include/*.h "$INSTALL_PREFIX/include/suitesparse/"

echo "SuiteSparse built and installed successfully!"
echo ""
echo "To use this version instead of Homebrew's:"
echo "1. Update your CMakeLists.txt to look in /usr/local first"
echo "2. Or temporarily unlink Homebrew's version: brew unlink suite-sparse"
echo ""
echo "Build directory preserved at: $BUILD_DIR"