#ifndef PARSING_NO_QT_H
#define PARSING_NO_QT_H

#include <string>
#include <fstream>
#include <stdexcept>
#include <vector>
#include <sstream>
#include "types.h"

// A non-Qt version of key parsing functions needed for CLI tools
namespace wfes {
namespace parsing {

// Load a column vector from a CSV file
inline dvec load_csv_col_vector(const std::string& filename, llong rows = -1) {
    std::ifstream file(filename);
    if (!file.is_open()) {
        throw std::runtime_error("Could not open file: " + filename);
    }
    
    std::vector<double> values;
    std::string line;
    
    while (std::getline(file, line) && (rows == -1 || values.size() < static_cast<size_t>(rows))) {
        values.push_back(std::stod(line));
    }
    
    dvec result(values.size());
    for (size_t i = 0; i < values.size(); i++) {
        result(i) = values[i];
    }
    
    return result;
}

// Load a row vector from a CSV file
inline dvec load_csv_row_vector(const std::string& filename, llong cols = -1) {
    std::ifstream file(filename);
    if (!file.is_open()) {
        throw std::runtime_error("Could not open file: " + filename);
    }
    
    std::string line;
    std::getline(file, line);
    
    std::vector<double> values;
    std::stringstream ss(line);
    std::string value;
    
    while (std::getline(ss, value, ',') && (cols == -1 || values.size() < static_cast<size_t>(cols))) {
        values.push_back(std::stod(value));
    }
    
    dvec result(values.size());
    for (size_t i = 0; i < values.size(); i++) {
        result(i) = values[i];
    }
    
    return result;
}

// Load a matrix from a CSV file
inline dmat load_csv_matrix(const std::string& filename, llong rows = -1, llong cols = -1) {
    std::ifstream file(filename);
    if (!file.is_open()) {
        throw std::runtime_error("Could not open file: " + filename);
    }
    
    std::vector<std::vector<double>> values;
    std::string line;
    
    while (std::getline(file, line) && (rows == -1 || values.size() < static_cast<size_t>(rows))) {
        std::vector<double> row_values;
        std::stringstream ss(line);
        std::string value;
        
        while (std::getline(ss, value, ',') && (cols == -1 || row_values.size() < static_cast<size_t>(cols))) {
            row_values.push_back(std::stod(value));
        }
        
        values.push_back(row_values);
    }
    
    if (values.empty()) {
        return dmat(0, 0);
    }
    
    llong matrix_rows = values.size();
    llong matrix_cols = values[0].size();
    
    dmat result(matrix_rows, matrix_cols);
    for (llong i = 0; i < matrix_rows; i++) {
        for (llong j = 0; j < matrix_cols; j++) {
            result(i, j) = values[i][j];
        }
    }
    
    return result;
}

} // namespace parsing
} // namespace wfes

#endif // PARSING_NO_QT_H