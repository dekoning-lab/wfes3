#ifndef UTILS_H
#define UTILS_H

#include "utils/types.h"

#include <Eigen/Core>

#include <model/sparse-matrix/sparseMatrix.h>

#include <boost/math/special_functions/fpclassify.hpp>

#include <limits>

#include <iostream>
#include <fstream>
#include <iomanip>
#include <filesystem>

namespace wfes{
    namespace utils{

        enum ExecutionStatus{
            NONE, STARTING, BUILDING_MATRICES, SOLVING_MATRICES, SAVING_DATA, DONE, EXECUTION_ERROR, ABORTED
        };

        static const char* ExecutionStatusName[] = { "None", "Starting...", "Building matrices...", "Solving matrices...", "Saving data...", "Done.", "Execution error.", "Aborted by user."};

        /**
         * @brief Get integer number representing an execution status.
         * @param status Status to be represented as integer.
         * @return Get integer number representing an execution status.
         */
        int executionStatusToInt(ExecutionStatus status);

        /**
         * @brief Format for CSV in input and output.
         */
        const static Eigen::IOFormat CSVFormat(Eigen::FullPrecision, Eigen::DontAlignCols, ", ", "\r\n");

        /**
         * @brief Format for a row of a CSV in input and output.
         */
        const static Eigen::IOFormat CSVRowFormat(Eigen::FullPrecision, Eigen::DontAlignCols, ", ", ", ");

        /**
         * @brief Write a matrix A into a file.
         * @param A Matrix to be writted.
         * @param name Name of the file.
         * @param executableName Name of the executable.
         * @param append Append to an existing file.
         */
        void writeMatrixToFile(const dmat& A, std::string name, std::string executableName, bool append = false);
        /**
         * @brief writeVectorMapToFile Write a map of vectors A into a file.
         * @param A Map of vectors to be writted.
         * @param name Name of the file.
         * @param executableName Name of the executable.
         * @param append Append to an existing file.
         */
        void writeVectorMapToFile(const std::map<llong, dvec>& A, std::string name, std::string executableName, bool append = false);
        /**
         * @brief Write a vector A into a file.
         * @param A Vector to be writted.
         * @param name Name of the file.
         * @param executableName Name of the executable.
         * @param append Append to an existing file.
         */
        void writeVectorToFile(const dvec& A, std::string name, std::string executableName, bool append = false);
        /**
         * @brief Write a sparse matrix A into a file.
         * @param A Sparse matrix to be writted.
         * @param name Name of the file.
         * @param executableName Name of the executable.
         */
        void writeSparseMatrixToFile(wfes::sparsematrix::SparseMatrix *A, std::string name, std::string executableName, bool append = false);

        /**
         * @brief Print a vector of doubles.
         * @param src Vector to be printed.
         * @param prefix Print a prefix before the vector.
         * @param postfix Print a postfix after the vector.
         * @param delim Delimiter of values.
         */
        void printVector(const dvec& src, const char* prefix = "", const char* postfix = "", const char* delim = ",");
        /**
         * @brief Print a vector of llong (long long int).
         * @param src Vector to be printed.
         * @param prefix Print a prefix before the vector.
         * @param postfix Print a postfix after the vector.
         * @param delim Delimiter of values.
         */
        void printVector(const lvec& src, const char* prefix = "", const char* postfix = "", const char* delim = ",");

        /**
         * @brief Get the minimum positive value between two llong (long long int) numbers.
         * @param a Number to be compared.
         * @param b Number to be compared.
         * @return Minimum positive between a and b.
         */
        llong positiveMin(llong a, llong b);

        /**
         * @brief Test if two vectors of doubles have approximattely the same values with a tollerance of tol.
         * @param a Vector to be compared.
         * @param b Vector to be compared.
         * @param tol Tolerance of the comparison.
         * @return True if the vectors are approximatelly equals.
         */
        bool approxEq(const dvec& a, const dvec& b, double tol = 1e-10);

        /**
         * @brief Test if two matrixes of doubles have approximattely the same values with a tollerance of tol.
         * @param a Matrix to be compared.
         * @param b Matrix to be compared.
         * @param tol Tolerance of the comparison.
         * @return True if the matrixes are approximatelly equals.
         */
        bool approxEq(const dmat& a, const dmat& b, double tol = 1e-10);

        /**
         * @brief Get the total difference between the values of two matrixes of doubles.
         * @param a Matrix to be compared.
         * @param b Matrix to be compared.
         * @return Total difference between two matrixes of doubles.
         */
        double totalDiff(const dmat& a, const dmat& b);

        /**
         * @brief Pick start indeces for a given vector of population sizes.
         * @param Population sizes.
         * @return Start indeces for a given vector of population sizes
         */
        lvec startIndeces(lvec n);

        /**
         * @brief Pick end indeces for a given vector of population sizes.
         * @param Population sizes.
         * @return End indeces for a given vector of population sizes
         */
        lvec endIndeces(lvec n);

        /**
         * @brief Get strided sliced array (Like python array[a:b:s].
         * @return Strided sliced array.
         */
        lvec rangeStep(llong a, llong b, llong s);

        /**
         * @brief Get closed range of a vector.
         * @param start Start position.
         * @param stop Stop position.
         * @return Closed range of a vector.
         */
        lvec closedRange(llong start, llong stop);

        /**
         * @brief Get closed range of a vector.
         * @param start Start position.
         * @param stop Stop position.
         * @return Closed range of a vector.
         */
        ivec closedRangeInt(int start, int stop);

        /**
         * @brief Calculate start indices for a given vector of population sizes.
         * @param n Vector of population sizes.
         * @return Vector of start indices.
         */
        lvec start_indices(const lvec& n);
        
        /**
         * @brief Generate range with step like Python's range(a, b, s).
         * @param a Start value.
         * @param b End value (exclusive).
         * @param s Step size.
         * @return Vector containing the range.
         */
        lvec range_step(llong a, llong b, llong s);
    }
}

#endif // UTILS_H
