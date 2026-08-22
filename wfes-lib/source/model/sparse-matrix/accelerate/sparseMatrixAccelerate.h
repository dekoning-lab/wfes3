#ifndef SPARSEMATRIXACCELERATE_H
#define SPARSEMATRIXACCELERATE_H

#include "../sparseMatrix.h"
#include "backend_config.h"
#include "backend_types.h"

#ifdef WFES_USE_ACCELERATE

namespace wfes {
namespace sparsematrix {

/**
 * @brief Apple Accelerate implementation of the SparseMatrix interface
 * 
 * This class provides a wrapper around Apple's Accelerate framework
 * sparse matrix functionality, implementing the same interface as
 * the MKL/Pardiso version for seamless backend switching.
 */
class SparseMatrixAccelerate : public SparseMatrix {
public:
    /**
     * @brief Constructor from CSR format data
     * @param rows Number of rows
     * @param cols Number of columns  
     * @param nnz Number of non-zero elements
     * @param vals Array of non-zero values
     * @param col_indices Column indices for each non-zero value
     * @param row_pointers Row pointer array (size rows+1)
     */
    SparseMatrixAccelerate(llong rows, llong cols, llong nnz,
                          double* vals, llong* col_indices, llong* row_pointers);
    
    /**
     * @brief Constructor for empty matrix (for incremental construction)
     * @param rows Number of rows
     * @param cols Number of columns
     */
    SparseMatrixAccelerate(llong rows, llong cols);
    
    /**
     * @brief Constructor from dense matrix
     * @param dense Dense matrix in column-major format
     */
    SparseMatrixAccelerate(const dmat& dense);
    
    /**
     * @brief Destructor - clean up Accelerate resources
     */
    virtual ~SparseMatrixAccelerate();
    
    // Required virtual function implementations from base SparseMatrix class
    virtual SparseMatrix* LeftPaddedDiagonal(int dim, double x, int padLeft) override;
    virtual void appendRow(dvec& row, int col_start, int size) override;
    virtual void appendChunk(dvec& row, int m0, int r0, int size, int rowSize) override;
    virtual void appendValue(double value, int j) override;
    virtual void resizeVectors() override;
    virtual void nextRow() override;
    virtual void debugPrint() override;
    virtual bool approxEquals(const SparseMatrix& rhs, double tol = 1e-10, bool verbose = false) override;
    virtual dmat dense() override;
    virtual dvec getDiagCopy() override;
    virtual dvec getColCopy(int j) override;
    virtual dvec getRowCopy(int i) override;
    virtual dvec multiply(dvec& x, bool transpose = false) override;
    virtual void multiplyInPlaceRep(dvec& x, int times, bool transpose = false) override;
    virtual SparseMatrix* multiply(SparseMatrix& B, bool transpose = false) override;
    virtual void subtractIdentity() override;
    virtual double search(int i, int j) override;
    virtual void setValue(double x, int i, int j) override;
    virtual void saveSparseCsv(std::string path) override;
    
    // Additional helper methods for Accelerate-specific operations
    SparseMatrix_Double getAccelerateMatrix() const { return matrix; }
    void finalizeConstruction();
    
    // Method to convert CSR to CSC format for SuiteSparse without going through dense
    void convertToCSC(std::vector<int>& col_pointers_out, 
                     std::vector<int>& row_indices_out, 
                     std::vector<double>& values_out) const;
    
private:
    // Accelerate sparse matrix handle
    SparseMatrix_Double matrix;
    
    // Matrix attributes
    SparseAttributes_t attributes;
    
    // Matrix dimensions
    llong rows;
    llong cols;
    llong nnz;
    
    // Storage for CSR data (Accelerate may reference these)
    std::vector<double> values;
    std::vector<int> column_indices;  // Accelerate uses int, not long
    std::vector<long> row_pointers;
    
    // Construction state
    bool matrix_finalized;
    int current_row;
    
    // Helper methods
    void createAccelerateMatrix(double* vals, int* col_idx, long* row_ptr);
    void convertIndices(llong* col_indices_in, llong nnz);
};

} // namespace sparsematrix
} // namespace wfes

#endif // WFES_USE_ACCELERATE

#endif // SPARSEMATRIXACCELERATE_H