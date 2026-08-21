#ifndef COMMON_H
#define COMMON_H

#include <cassert>
#include <cstdlib>
#include <cmath>
#include <cfloat>
#include <cstring>

#include <iostream>
#include <fstream>
#include <limits>

#include <deque>
#include <vector>
#include <map>
#include <sstream>
#include <chrono>
#include <stdexcept>

#include <Eigen/Core>
#include <Eigen/Sparse>

// Format for printing double numbers.
#define DPF "%.10e"
#define DPFS "%.4e"
// Format for printing llong (long long int) numbers.
#define LPF "%lld"
// Format for printing integer numbers.
#define IPF "%d"

// Definition of type long long int as llong.
typedef long long int llong;

// A measured instant of time.
typedef std::chrono::time_point<std::chrono::system_clock> time_point;
// Duration of inteval between an starting instant of time and an ending instant of time.
typedef std::chrono::duration<double> time_diff;

/**
 * @brief Print buffer in an output stream.
 * @param buffer Buffer to be printed.
 * @param size Size of the buffer.
 * @param os Output stream.
 * @param newline Print a new line after the buffer (or not).
 */
template<typename T>
void printBuffer(T* buffer, size_t size, std::ostream& os = std::cout, bool newline = true) {
    for(size_t i = 0; i < size; i++) {
        os << buffer[i] << "\t";
    }
    if (newline) std::cout << std::endl;
}

// Eigen vector of doubles.
typedef Eigen::VectorXd dvec;
// Eigen vector of long long ints.
typedef Eigen::Matrix<llong, Eigen::Dynamic, 1> lvec;
// Eigen vector of long long ints.
typedef Eigen::VectorXi ivec;
// Eigen matrix of doubles.
typedef Eigen::Matrix<double, Eigen::Dynamic, Eigen::Dynamic, Eigen::RowMajor> dmat;
// Eigen diagonal matrix of doubles.
typedef Eigen::DiagonalMatrix<double, Eigen::Dynamic> diagmat;

#endif // COMMON_H
