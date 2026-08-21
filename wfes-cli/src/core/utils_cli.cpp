// CLI-specific utility functions
#include "utils.h"
#include <Eigen/Core>
#include <fstream>
#include <iostream>
#include <algorithm>
#include <numeric>

namespace wfes {
namespace utils {

// CLI version of write_vector_to_file
void write_vector_to_file(const Eigen::VectorXd& vec, const std::string& filename) {
    std::ofstream file(filename);
    if (!file.is_open()) {
        throw std::runtime_error("Unable to open file: " + filename);
    }
    
    file << vec.format(CSVFormat);
    file.close();
}

// CLI version of write_matrix_to_file
void write_matrix_to_file(const Eigen::MatrixXd& mat, const std::string& filename) {
    std::ofstream file(filename);
    if (!file.is_open()) {
        throw std::runtime_error("Unable to open file: " + filename);
    }
    
    file << mat.format(CSVFormat);
    file.close();
}

// Additional utility functions needed by the library
llong positiveMin(llong a, llong b) {
    if (a == 0 && b == 0) return 0;
    if (a >= 0 && b <  0) return a;
    if (a <  0 && b >= 0) return b;
    if (a <= b) return a;
    else return b;
}

lvec closedRange(llong a, llong b) {
    lvec range(b - a + 1);
    std::iota(range.data(), range.data() + range.size(), a);
    return range;
}

ivec closedRangeInt(int a, int b) {
    ivec range(b - a + 1);
    std::iota(range.data(), range.data() + range.size(), a);
    return range;
}

// Start indices for a given vector of population sizes
// Example: [100, 200] -> [0, 100]
lvec start_indices(const lvec& n) {
    lvec si = lvec::Zero(n.size());
    for (llong i = 1; i < n.size(); i++) {
        si[i] = si[i-1] + n[i-1];
    }
    return si;
}

// Like python's strided slice array[a:b:s]
lvec range_step(llong a, llong b, llong s) {
    llong size = static_cast<llong>(std::ceil((b-a)/double(s)));
    lvec r = lvec::Zero(size);
    for(llong v = a, i = 0; v < b; v += s, i++) {
        r[i] = v;
    }
    return r;
}

} // namespace utils
} // namespace wfes