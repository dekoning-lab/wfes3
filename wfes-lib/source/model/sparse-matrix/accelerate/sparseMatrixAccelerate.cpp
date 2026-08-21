#include "sparseMatrixAccelerate.h"

#ifdef WFES_USE_ACCELERATE

#include <stdexcept>
#include <fstream>
#include <iomanip>

#ifdef __APPLE__
#include <Accelerate/Accelerate.h>
#endif

namespace wfes {
namespace sparsematrix {

SparseMatrixAccelerate::SparseMatrixAccelerate(llong rows, llong cols, llong nnz,
                                               double* vals, llong* col_indices_in, llong* row_pointers_in)
    : SparseMatrix(rows, cols), rows(rows), cols(cols), nnz(nnz), matrix_finalized(false), current_row(0) {
    
    // Accelerate uses int for column indices, so we need to convert
    column_indices.resize(nnz);
    for (llong i = 0; i < nnz; ++i) {
        if (col_indices_in[i] > INT_MAX) {
            throw std::runtime_error("Column index exceeds Accelerate's int limit");
        }
        column_indices[i] = static_cast<int>(col_indices_in[i]);
    }
    
    // Copy values
    values.assign(vals, vals + nnz);
    
    // Copy row pointers
    row_pointers.assign(row_pointers_in, row_pointers_in + rows + 1);
    
    // Create the Accelerate sparse matrix
    createAccelerateMatrix(values.data(), column_indices.data(), row_pointers.data());
    matrix_finalized = true;
}

SparseMatrixAccelerate::SparseMatrixAccelerate(llong rows, llong cols)
    : SparseMatrix(rows, cols), rows(rows), cols(cols), nnz(0), matrix_finalized(false) {
    
    // Initialize empty storage for incremental construction
    values.clear();
    column_indices.clear();
    row_pointers.clear();
    
    // Initialize row pointers - start with first row
    row_pointers.push_back(0);
    current_row = 0;
    
    // Don't create the Accelerate matrix yet - it will be created when finalized
    // For now, just set up the attributes
    attributes.transpose = false;
    attributes.triangle = SparseUpperTriangle;
    attributes.kind = SparseOrdinary;
    attributes._reserved = 0;
}

SparseMatrixAccelerate::SparseMatrixAccelerate(const dmat& dense) 
    : SparseMatrix(dense.rows(), dense.cols()), rows(dense.rows()), cols(dense.cols()), matrix_finalized(false), current_row(0) {
    
    // Count non-zeros
    nnz = 0;
    for (llong i = 0; i < rows; ++i) {
        for (llong j = 0; j < cols; ++j) {
            if (std::abs(dense(i, j)) > 1e-15) {
                nnz++;
            }
        }
    }
    
    // Allocate storage
    values.reserve(nnz);
    column_indices.reserve(nnz);
    row_pointers.resize(rows + 1);
    
    // Convert to CSR format
    llong idx = 0;
    for (llong i = 0; i < rows; ++i) {
        row_pointers[i] = idx;
        for (llong j = 0; j < cols; ++j) {
            if (std::abs(dense(i, j)) > 1e-15) {
                values.push_back(dense(i, j));
                column_indices.push_back(static_cast<int>(j));
                idx++;
            }
        }
    }
    row_pointers[rows] = idx;
    
    // Create the Accelerate sparse matrix
    createAccelerateMatrix(values.data(), column_indices.data(), row_pointers.data());
    matrix_finalized = true;
}

void SparseMatrixAccelerate::finalizeConstruction() {
    if (!matrix_finalized && !values.empty()) {
        // Update nnz to match actual number of elements
        nnz = values.size();
        
        // Finalizing construction silently
        
        // Create the Accelerate sparse matrix
        createAccelerateMatrix(values.data(), column_indices.data(), row_pointers.data());
        matrix_finalized = true;
        
        // Matrix finalized successfully
    }
}

SparseMatrixAccelerate::~SparseMatrixAccelerate() {
    // Accelerate uses automatic reference counting, so cleanup is automatic
    // when the SparseMatrix_Double goes out of scope
}

void SparseMatrixAccelerate::createAccelerateMatrix(double* vals, int* col_idx, long* row_ptr) {
    // Set up attributes for a general sparse matrix
    attributes.transpose = false;
    attributes.triangle = SparseUpperTriangle;  // Use upper triangle for QR factorization
    attributes.kind = SparseOrdinary;
    attributes._reserved = 0;
    
    #ifdef __APPLE__
    // Creating matrix silently
    
    // Convert CSR format to coordinate format for Accelerate
    // Accelerate prefers coordinate format for matrix creation
    std::vector<int> row_indices;
    std::vector<int> col_indices_coord;
    std::vector<double> values_coord;
    
    // Convert from CSR to coordinate format
    for (int i = 0; i < rows; ++i) {
        for (long j = row_ptr[i]; j < row_ptr[i + 1]; ++j) {
            row_indices.push_back(i);
            col_indices_coord.push_back(col_idx[j]);
            values_coord.push_back(vals[j]);
            
            // Convert entries silently
        }
    }
    
    // Converted to coordinate format silently
    
    // Create Accelerate sparse matrix using coordinate format
    matrix = SparseConvertFromCoordinate(
        static_cast<int>(rows),
        static_cast<int>(cols),
        static_cast<long>(row_indices.size()),
        1,  // blockSize = 1 for scalar elements
        attributes,
        row_indices.data(),
        col_indices_coord.data(),
        values_coord.data()
    );
    
    // Accelerate matrix created successfully
    #else
    throw std::runtime_error("Accelerate backend is only available on macOS");
    #endif
}

dvec SparseMatrixAccelerate::multiply(dvec& x, bool transpose) {
    #ifdef __APPLE__
    // Ensure matrix is finalized before operations
    if (!matrix_finalized) {
        finalizeConstruction();
    }
    
    
    dvec result(transpose ? cols : rows);
    
    // Create dense matrix structures for Accelerate
    // Use DenseVector_Double instead of DenseMatrix_Double for vectors
    DenseVector_Double x_vec = {
        .count = static_cast<int>(x.size()),
        .data = x.data()
    };
    
    DenseVector_Double result_vec = {
        .count = static_cast<int>(result.size()),
        .data = result.data()
    };
    
    // Perform sparse matrix-vector multiplication
    if (transpose) {
        // y = A^T * x
        // Create a transposed view of the matrix
        SparseMatrix_Double matrix_T = matrix;
        matrix_T.structure.attributes.transpose = true;
        SparseMultiply(matrix_T, x_vec, result_vec);
    } else {
        // y = A * x
        SparseMultiply(matrix, x_vec, result_vec);
    }
    
    return result;
    #else
    throw std::runtime_error("Accelerate backend is only available on macOS");
    #endif
}

void SparseMatrixAccelerate::multiplyInPlaceRep(dvec& x, int times, bool transpose) {
    #ifdef __APPLE__
    for (int i = 0; i < times; ++i) {
        dvec temp = multiply(x, transpose);
        x = temp;
    }
    #else
    throw std::runtime_error("Accelerate backend is only available on macOS");
    #endif
}

SparseMatrix* SparseMatrixAccelerate::multiply(SparseMatrix& B, bool transpose) {
    #ifdef __APPLE__
    // Get the Accelerate matrix from B (assuming it's also SparseMatrixAccelerate)
    SparseMatrixAccelerate* B_accel = dynamic_cast<SparseMatrixAccelerate*>(&B);
    if (!B_accel) {
        throw std::runtime_error("Cannot multiply with non-Accelerate sparse matrix");
    }
    
    // For sparse matrix-matrix multiplication with Accelerate, we have a few options:
    // 1. Use dense intermediate representation (simpler but less efficient)
    // 2. Convert to dense, multiply, convert back to sparse
    // Let's implement option 2 for now
    
    dmat A_dense = this->dense();
    dmat B_dense = B.dense();
    dmat C_dense;
    
    if (transpose) {
        C_dense = A_dense.transpose() * B_dense;
    } else {
        C_dense = A_dense * B_dense;
    }
    
    // Convert result back to sparse matrix
    return new SparseMatrixAccelerate(C_dense);
    #else
    throw std::runtime_error("Accelerate backend is only available on macOS");
    #endif
}

void SparseMatrixAccelerate::saveMarket(std::string filename) {
    std::ofstream file(filename);
    if (!file.is_open()) {
        throw std::runtime_error("Cannot open file for writing: " + filename);
    }
    
    // Write Matrix Market header.
    // Use values.size() rather than the nnz member: matrices are commonly
    // exported (--output-Q/--output-R) before the solver calls
    // finalizeConstruction(), which is where nnz was historically first set.
    // Emitting a stale nnz produced headers declaring 0 non-zeros above
    // thousands of coordinate entries, which strict readers such as
    // scipy.io.mmread reject outright.
    file << "%%MatrixMarket matrix coordinate real general\n";
    file << rows << " " << cols << " " << values.size() << "\n";
    
    // Write matrix entries
    for (llong i = 0; i < rows; ++i) {
        for (llong j = row_pointers[i]; j < row_pointers[i + 1]; ++j) {
            file << (i + 1) << " " << (column_indices[j] + 1) << " " 
                 << std::scientific << std::setprecision(16) << values[j] << "\n";
        }
    }
    
    file.close();
}

void SparseMatrixAccelerate::convertToCSC(std::vector<int>& col_pointers_out, 
                                         std::vector<int>& row_indices_out, 
                                         std::vector<double>& values_out) const {
    // Ensure matrix is finalized before conversion
    if (!matrix_finalized) {
        throw std::runtime_error("Cannot convert to CSC: matrix not finalized");
    }
    
    // Clear output vectors
    col_pointers_out.clear();
    row_indices_out.clear();
    values_out.clear();
    
    // Verify row_pointers size
    if (row_pointers.size() != rows + 1) {
        throw std::runtime_error("Invalid row_pointers size: " + std::to_string(row_pointers.size()) + 
                                " expected " + std::to_string(rows + 1));
    }
    
    // Count non-zeros per column
    std::vector<int> col_counts(cols, 0);
    for (int i = 0; i < rows; ++i) {
        if (row_pointers[i] < 0 || row_pointers[i + 1] > values.size()) {
            throw std::runtime_error("Invalid row pointer range");
        }
        for (long j = row_pointers[i]; j < row_pointers[i + 1]; ++j) {
            if (column_indices[j] < 0 || column_indices[j] >= cols) {
                throw std::runtime_error("Invalid column index: " + std::to_string(column_indices[j]));
            }
            col_counts[column_indices[j]]++;
        }
    }
    
    // Build column pointers
    col_pointers_out.resize(cols + 1);
    col_pointers_out[0] = 0;
    for (int j = 0; j < cols; ++j) {
        col_pointers_out[j + 1] = col_pointers_out[j] + col_counts[j];
    }
    
    // Reserve space
    row_indices_out.resize(nnz);
    values_out.resize(nnz);
    
    // Reset column counts to use as insertion positions
    col_counts.assign(cols, 0);
    
    // Fill CSC arrays
    for (int i = 0; i < rows; ++i) {
        for (long j = row_pointers[i]; j < row_pointers[i + 1]; ++j) {
            int col = column_indices[j];
            int dest = col_pointers_out[col] + col_counts[col];
            row_indices_out[dest] = i;
            values_out[dest] = values[j];
            col_counts[col]++;
        }
    }
}

SparseMatrix* SparseMatrixAccelerate::LeftPaddedDiagonal(int dim, double x, int padLeft) {
    // Create a diagonal matrix with padding
    // Calculate number of non-zeros
    int nnz_count = dim - padLeft;
    
    // Allocate arrays
    std::vector<double> vals(nnz_count, x);
    std::vector<llong> col_idx(nnz_count);
    std::vector<llong> row_ptr(dim + 1, 0);
    
    // Fill column indices and row pointers
    for (int i = 0; i < padLeft; ++i) {
        row_ptr[i] = 0;  // Empty rows
    }
    
    for (int i = padLeft; i < dim; ++i) {
        col_idx[i - padLeft] = i;
        row_ptr[i] = i - padLeft;
    }
    row_ptr[dim] = nnz_count;
    
    // Create and return the matrix
    return new SparseMatrixAccelerate(dim, dim, nnz_count, 
                                      vals.data(), col_idx.data(), row_ptr.data());
}

// IMPORTANT: these three functions must store EVERY value handed to them,
// including exact zeros. Do not reintroduce a magnitude filter.
//
// They previously skipped |x| <= 1e-15, which corrupted the matrix in two ways:
//
//  1. wrightFisher.cpp deliberately calls appendValue(0, i) to reserve a
//     structural slot for the diagonal when tail truncation moves the diagonal
//     outside a row's binomial support (wrightFisher.cpp:201-202, 209-210).
//     subtractIdentity() only rewrites entries that are already STORED, so a
//     dropped placeholder leaves a structurally-zero diagonal in (I - Q).
//  2. Under strong selection genuine P(i,i) values fall below 1e-15 and were
//     dropped outright, with the same consequence.
//
// The result was a singular (I - Q) and silently wrong output: at N=1000,
// h=0.5, u=v=1e-9, p=1, --fixation returned T_fix=inf for s=0.91 with
// alpha=1e-10 (true value 905714, obtained at alpha=0) and NaN for s=1.5 even
// at alpha=0 -- in both cases with exit status 0 and no diagnostic. The
// reference SparseMatrixPardiso::appendValue stores unconditionally, which is
// the contract wrightFisher.cpp is written against.
//
// Filtering is also unnecessary: the Wright-Fisher assembly already bounds each
// row's support via the alpha tail-truncation parameter, which is the intended,
// user-controlled mechanism for discarding negligible transitions.
void SparseMatrixAccelerate::appendRow(dvec& row, int col_start, int size) {
    // This is used during matrix construction
    // For Accelerate, we'll build the matrix data directly
    for (int i = 0; i < size; ++i) {
        values.push_back(row[col_start + i]);
        column_indices.push_back(i);
        nnz++;
    }
}

void SparseMatrixAccelerate::appendChunk(dvec& row, int m0, int r0, int size, int rowSize) {
    // Append a chunk of a row
    for (int i = 0; i < size; ++i) {
        values.push_back(row[r0 + i]);
        column_indices.push_back(m0 + i);
        nnz++;
    }
}

void SparseMatrixAccelerate::appendValue(double value, int j) {
    values.push_back(value);
    column_indices.push_back(j);
    nnz++;
}

void SparseMatrixAccelerate::resizeVectors() {
    // Resize storage vectors if needed
    values.shrink_to_fit();
    column_indices.shrink_to_fit();
}

void SparseMatrixAccelerate::nextRow() {
    // Mark the end of current row
    row_pointers.push_back(values.size());
}

void SparseMatrixAccelerate::debugPrint() {
    std::cout << "SparseMatrixAccelerate (" << rows << "x" << cols << ") with " << nnz << " non-zeros:\n";
    for (int i = 0; i < rows && i < 10; ++i) {  // Print first 10 rows
        std::cout << "Row " << i << ": ";
        for (long j = row_pointers[i]; j < row_pointers[i + 1]; ++j) {
            std::cout << "(" << column_indices[j] << "," << values[j] << ") ";
        }
        std::cout << "\n";
    }
}

bool SparseMatrixAccelerate::approxEquals(const SparseMatrix& rhs, double tol, bool verbose) {
    const SparseMatrixAccelerate* other = dynamic_cast<const SparseMatrixAccelerate*>(&rhs);
    if (!other) return false;
    
    if (rows != other->rows || cols != other->cols || nnz != other->nnz) {
        if (verbose) {
            std::cout << "Dimension mismatch: (" << rows << "x" << cols << "," << nnz 
                      << ") vs (" << other->rows << "x" << other->cols << "," << other->nnz << ")\n";
        }
        return false;
    }
    
    // Compare values
    for (llong i = 0; i < nnz; ++i) {
        if (std::abs(values[i] - other->values[i]) > tol) {
            if (verbose) {
                std::cout << "Value mismatch at index " << i << ": " 
                          << values[i] << " vs " << other->values[i] << "\n";
            }
            return false;
        }
    }
    
    return true;
}

dmat SparseMatrixAccelerate::dense() {
    dmat result = dmat::Zero(rows, cols);
    
    for (int i = 0; i < rows; ++i) {
        for (long j = row_pointers[i]; j < row_pointers[i + 1]; ++j) {
            result(i, column_indices[j]) = values[j];
        }
    }
    
    return result;
}

dvec SparseMatrixAccelerate::getDiagCopy() {
    dvec diag(std::min(rows, cols));
    diag.setZero();
    
    for (int i = 0; i < rows; ++i) {
        for (long j = row_pointers[i]; j < row_pointers[i + 1]; ++j) {
            if (column_indices[j] == i) {
                diag[i] = values[j];
                break;
            }
        }
    }
    
    return diag;
}

dvec SparseMatrixAccelerate::getColCopy(int col) {
    dvec result(rows);
    result.setZero();
    
    for (int i = 0; i < rows; ++i) {
        for (long j = row_pointers[i]; j < row_pointers[i + 1]; ++j) {
            if (column_indices[j] == col) {
                result[i] = values[j];
                break;
            }
        }
    }
    
    return result;
}

dvec SparseMatrixAccelerate::getRowCopy(int row) {
    dvec result(cols);
    result.setZero();
    
    if (row >= 0 && row < rows) {
        for (long j = row_pointers[row]; j < row_pointers[row + 1]; ++j) {
            result[column_indices[j]] = values[j];
        }
    }
    
    return result;
}

void SparseMatrixAccelerate::subtractIdentity() {
    // Calculate I - Q (identity minus matrix) to match Pardiso implementation
    // This is different from the original comment which said A - I
    
    // First, negate all off-diagonal elements
    for (int i = 0; i < rows; ++i) {
        for (long j = row_pointers[i]; j < row_pointers[i + 1]; ++j) {
            if (column_indices[j] == i) {
                // Diagonal element: compute 1 - value
                values[j] = 1.0 - values[j];
            } else {
                // Off-diagonal element: negate
                values[j] = -values[j];
            }
        }
    }
}

double SparseMatrixAccelerate::search(int i, int j) {
    if (i >= 0 && i < rows) {
        for (long k = row_pointers[i]; k < row_pointers[i + 1]; ++k) {
            if (column_indices[k] == j) {
                return values[k];
            }
        }
    }
    return 0.0;  // Element not found, return zero
}

void SparseMatrixAccelerate::setValue(double x, int i, int j) {
    if (i >= 0 && i < rows && j >= 0 && j < cols) {
        for (long k = row_pointers[i]; k < row_pointers[i + 1]; ++k) {
            if (column_indices[k] == j) {
                values[k] = x;
                return;
            }
        }
        // Element doesn't exist, would need to insert it
        // This is complex for CSR format after construction
        throw std::runtime_error("Cannot set value for non-existent matrix element in CSR format");
    }
}


} // namespace sparsematrix
} // namespace wfes

#endif // WFES_USE_ACCELERATE