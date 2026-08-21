#ifndef UTILS_NO_QT_H
#define UTILS_NO_QT_H

#include <iostream>
#include <fstream>
#include <iomanip>
#include <string>
#include <vector>
#include <chrono>
#include <cmath>
#include <limits>

#include "types.h"

// A non-Qt version of key utility functions needed for CLI tools
namespace wfes {
namespace utils {

// Debug print function that replaces QDebug functionality
template<typename T>
void debugPrint(const T& value) {
    std::cerr << value << std::endl;
}

// File operations
inline bool fileExists(const std::string& filename) {
    std::ifstream file(filename);
    return file.good();
}

inline std::string readFileAsString(const std::string& filename) {
    std::ifstream file(filename);
    if (!file.is_open()) {
        throw std::runtime_error("Could not open file: " + filename);
    }
    return std::string((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
}

// Write vector to file (replacement for the Qt-based version)
inline void writeVectorToFile(const dvec& v, const std::string& filename) {
    std::ofstream file(filename);
    if (!file.is_open()) {
        throw std::runtime_error("Could not open file for writing: " + filename);
    }
    
    file << std::scientific << std::setprecision(16);
    for (int i = 0; i < v.size(); i++) {
        file << v(i) << "\n";
    }
    file.close();
}

// Write matrix to file (replacement for the Qt-based version)
inline void writeMatrixToFile(const dmat& m, const std::string& filename) {
    std::ofstream file(filename);
    if (!file.is_open()) {
        throw std::runtime_error("Could not open file for writing: " + filename);
    }
    
    file << std::scientific << std::setprecision(16);
    for (int i = 0; i < m.rows(); i++) {
        for (int j = 0; j < m.cols(); j++) {
            file << m(i, j);
            if (j < m.cols() - 1) {
                file << ",";
            }
        }
        file << "\n";
    }
    file.close();
}

} // namespace utils
} // namespace wfes

#endif // UTILS_NO_QT_H