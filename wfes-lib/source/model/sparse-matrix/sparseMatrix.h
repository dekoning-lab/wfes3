#ifndef SPARSEMATRIX_H
#define SPARSEMATRIX_H

#include "utils/types.h"

#include <Eigen/SparseCore>

/**
 * @file sparseMatrix.h
 * @brief Abstract base class for sparse matrix implementations
 * 
 * This file defines the interface that all WFES sparse matrix backends must
 * implement. Sparse matrices are used to efficiently represent Wright-Fisher
 * transition matrices which are typically very sparse (most entries are zero).
 */

namespace wfes {
    namespace sparsematrix{

        /**
         * @class SparseMatrix
         * @brief Abstract base class for sparse matrix storage and operations
         * 
         * Provides a unified interface for different sparse matrix backends
         * including Pardiso (MKL), Accelerate (macOS), ViennaCL, SuiteSparse,
         * and ParU. Supports efficient row-by-row construction and basic
         * matrix operations required for Wright-Fisher calculations.
         */
        class SparseMatrix {
            public: // Parameters
                /**
                 * @brief Number of non-zero elements in the matrix
                 * 
                 * Used for memory allocation and performance optimization.
                 * Updated during matrix construction.
                 */
                int num_non_zeros;
                
                /**
                 * @brief Number of rows in the matrix
                 * 
                 * For Wright-Fisher matrices, typically 2N-1 or 2N+1 depending
                 * on the absorption type, where N is the population size.
                 */
                int num_rows;
                
                /**
                 * @brief Number of columns in the matrix
                 * 
                 * Usually equal to num_rows for square transition matrices.
                 */
                int num_cols;

            public: // Constructors and destructors.
                /**
                 * @brief Construct an empty sparse matrix with given dimensions
                 * @param num_rows Number of rows in the matrix
                 * @param num_cols Number of columns in the matrix
                 */
                SparseMatrix(int num_rows, int num_cols);

                /**
                 * @brief Create a sparse diagonal matrix with left padding
                 * 
                 * Used for constructing special matrices in Wright-Fisher calculations.
                 * Creates a matrix with diagonal elements of value x, shifted right
                 * by padLeft positions.
                 * 
                 * @param dim Dimension of the square matrix
                 * @param x Value for diagonal elements
                 * @param padLeft Number of zero columns before the diagonal starts
                 * @return SparseMatrix* New sparse matrix instance
                 */
                virtual SparseMatrix* LeftPaddedDiagonal(int dim, double x, int padLeft) = 0;

                /**
                 * @brief Virtual destructor for proper cleanup
                 */
                virtual ~SparseMatrix() {};

            public: // Append functions.

                /**
                 * @brief Append a sparse row to the matrix
                 * 
                 * Used during row-by-row matrix construction. Appends non-zero
                 * elements from the given vector starting at col_start.
                 * 
                 * @param row Vector containing the row values
                 * @param col_start Starting column index for non-zero elements
                 * @param size Number of non-zero elements in the row
                 */
                virtual void appendRow(dvec& row, int col_start, int size) = 0;

                /**
                 * @brief Append a chunk of values to the current matrix row
                 * 
                 * Used for block-wise matrix construction in switching models.
                 * Copies a portion of the input vector to specific positions
                 * in the matrix.
                 * 
                 * @param row Vector containing the chunk values
                 * @param m0 Starting column position in the matrix
                 * @param r0 Starting position in the input vector
                 * @param size Number of elements to copy
                 * @param rowSize Total size of the matrix row (for bounds checking)
                 */
                virtual void appendChunk(dvec& row, int m0, int r0, int size, int rowSize) = 0;

                /**
                 * @brief Append a single value to the current row
                 * 
                 * Adds a non-zero element at the specified column in the
                 * current row being constructed.
                 * 
                 * @param value Non-zero value to append
                 * @param j Column index for the value
                 */
                virtual void appendValue(double value, int j) = 0;

                /**
                 * @brief Resize internal storage vectors if needed
                 * 
                 * Called when the number of non-zeros exceeds initial estimates.
                 * Implementations should efficiently resize their storage.
                 */
                virtual void resizeVectors() = 0;

            public: // Auxiliary functions.

                /**
                 * @brief Move to the next row during matrix construction
                 * 
                 * Updates internal pointers and indices to prepare for
                 * appending elements to the next row.
                 */
                virtual void nextRow() = 0;

                /**
                 * @brief Print internal matrix storage for debugging
                 * 
                 * Outputs the compressed sparse row (CSR) or similar format
                 * data structures to help debug matrix construction.
                 */
                virtual void debugPrint() = 0;

                /**
                 * @brief Test approximate equality with another matrix
                 * 
                 * Used for validating numerical results across different backends.
                 * Compares element-wise with given tolerance.
                 * 
                 * @param rhs Matrix to compare against
                 * @param tol Tolerance for floating-point comparison
                 * @param verbose If true, print differences found
                 * @return bool True if matrices are approximately equal
                 */
                virtual bool approxEquals(const SparseMatrix& rhs, double tol = 1e-10, bool verbose = false) = 0;

            public: // Convert data

                /**
                 * @brief Convert sparse matrix to dense format
                 * 
                 * WARNING: Only use for small matrices or debugging.
                 * Large Wright-Fisher matrices will consume excessive memory.
                 * 
                 * @return dmat Dense Eigen matrix representation
                 */
                virtual dmat dense() = 0;

                /**
                 * @brief Extract diagonal elements as a vector
                 * 
                 * Used for eigenvalue calculations and matrix analysis.
                 * 
                 * @return dvec Vector containing diagonal elements
                 */
                virtual dvec getDiagCopy() = 0;

                /**
                 * @brief Extract a column as a dense vector
                 * 
                 * Used in allele age calculations and other analyses that
                 * need specific transition probabilities.
                 * 
                 * @param j Column index (0-based)
                 * @return dvec Dense vector containing column j
                 */
                virtual dvec getColCopy(int j) = 0;

                /**
                 * @brief Extract a row as a dense vector
                 * 
                 * Retrieves transition probabilities from state i.
                 * 
                 * @param i Row index (0-based)
                 * @return dvec Dense vector containing row i
                 */
                virtual dvec getRowCopy(int i) = 0;

            public: //Operators

                /**
                 * @brief Sparse matrix-vector multiplication
                 * 
                 * Computes y = Ax or y = A^T x efficiently using the
                 * sparse storage format.
                 * 
                 * @param x Input vector
                 * @param transpose If true, compute A^T x instead of Ax
                 * @return dvec Result vector y
                 */
                virtual dvec multiply(dvec& x, bool transpose = false) = 0;

                /**
                 * @brief Repeated in-place matrix-vector multiplication
                 * 
                 * Computes x = A^n x by repeated multiplication, overwriting
                 * the input vector. Used for power method calculations.
                 * 
                 * @param x Input/output vector (modified in place)
                 * @param times Number of multiplications to perform
                 * @param transpose If true, use A^T instead of A
                 */
                virtual void multiplyInPlaceRep(dvec& x, int times, bool transpose = false) = 0;

                /**
                 * @brief Sparse matrix-matrix multiplication
                 * 
                 * Computes C = AB or C = A^T B. Result is also sparse.
                 * 
                 * @param B Right-hand side matrix
                 * @param transpose If true, compute A^T B instead of AB
                 * @return SparseMatrix* New sparse matrix containing the result
                 * @note Caller is responsible for deleting the returned matrix
                 */
                virtual SparseMatrix* multiply(SparseMatrix& B, bool transpose = false) = 0;

                /**
                 * @brief Subtract this matrix from identity in-place
                 * 
                 * Modifies the matrix to become (I - Q). This operation is
                 * required before solving linear systems in Wright-Fisher
                 * calculations. Only affects diagonal elements.
                 * 
                 * @note This operation modifies the matrix in place
                 */
                virtual void subtractIdentity() = 0;

                /**
                 * @brief Get a single matrix element
                 * 
                 * Returns 0 if the element is not stored (sparse).
                 * This operation may be slow for sparse formats.
                 * 
                 * @param i Row index (0-based)
                 * @param j Column index (0-based)
                 * @return double Value at position (i,j)
                 */
                virtual double search(int i, int j) = 0;

                /**
                 * @brief Set a single matrix element
                 * 
                 * WARNING: This operation may be very slow for sparse formats
                 * and should be avoided in performance-critical code.
                 * Use append methods during construction instead.
                 * 
                 * @param x Value to set
                 * @param i Row index (0-based)
                 * @param j Column index (0-based)
                 */
                virtual void setValue(double x, int i, int j) = 0;
            public: // I/O operators.

                /**
                 * @brief Save matrix in Matrix Market format
                 * 
                 * Writes the sparse matrix as CSV coordinate triples: a
                 * `row,col,value` header followed by one stored entry per
                 * line, with 1-based indices.
                 *
                 * Coordinate rather than a dense grid because these matrices
                 * are banded and the band narrows as N grows -- a dense export
                 * is O(N^2) and mostly zeros (12% density at N = 2000, where a
                 * dense CSV would be ~400 MB against 64 MB here, and worse
                 * above that). Entries absent from the file are zero.
                 *
                 * This replaced Matrix Market format, whose header had to
                 * declare a non-zero count up front; that count was read from
                 * different members by the two backends and could be stale
                 * when a matrix was exported before finalizeConstruction(),
                 * producing headers that strict readers rejected. A CSV header
                 * row states no count, so there is none to get wrong.
                 *
                 * @param path Output file path
                 * @throws std::runtime_error if file cannot be written
                 */
                virtual void saveSparseCsv(std::string path) = 0;

        };

    }
}

/**
 * @typedef smat
 * @brief Convenience alias for SparseMatrix
 */
typedef wfes::sparsematrix::SparseMatrix smat;

#endif // SPARSEMATRIX_H
