#ifndef SPARSEMATRIXPARDISO_H
#define SPARSEMATRIXPARDISO_H

#include <iostream>

#include <mkl.h>
#include "model/sparse-matrix/sparseMatrix.h"
#include "utils/utils.h"

#include <boost/math/special_functions/fpclassify.hpp>

#ifndef WFES_CLI
#include <qstandardpaths.h>
#include <QFile>
#include <QDir>
#endif

using namespace wfes::sparsematrix;

namespace wfes{
    namespace pardiso{

        /**
         * @brief The SparseMatrixPardiso class defines a sparse matrix to be used by Pardiso MKL.
         */
        class SparseMatrixPardiso : public SparseMatrix
        {
            protected:
                /**
                 * @brief Current row that is being processed.
                 */
                llong current_row;
                /**
                 * @brief Matrix is full or not.
                 */
                bool full;
                /**
                 * @brief Index where the current row starts.
                 */
                llong row_index_start;
                /**
                 * @brief Current size of data array.
                 */
                llong current_size_data;
                /**
                 * @brief Current size of cols array.
                 */
                llong current_size_cols;
            public:
                /**
                 * @brief Non-zero values of the matrix, ordered by row/column.
                 */
                double* data;
                /**
                 * @brief Column index of each element in the array data.
                 */
                llong* cols;
                /**
                 * @brief Indicate which elements of data start a new row.
                 */
                llong* row_index;
                /**
                 * @brief Handler for the matrix data in Pardiso.
                 */
                sparse_matrix_t handler;

            public:
                /**
                 * @brief Default constructor of a Sparse Matrix.
                 */
                SparseMatrixPardiso();
                /**
                 * @brief Empty constructor of a Sparse Matrix.
                 * @param numRows Number of rows in the matrix.
                 * @param numCols Number of columns in the matrix.
                 */
                SparseMatrixPardiso(llong num_rows, llong num_cols);

                /**
                 * @brief Copy constructor of a Sparse Matrix using an Eigen Dense Matrix.
                 * @param eigenDenseMatrix An Eigen Dense Matrix.
                 */
                SparseMatrixPardiso(dmat& eigenDenseMatrix);

                /**
                 * @brief Create a Sparse Matrix containing only a padded diagonal.
                 * @param dim Number of rows in the matrix.
                 * @param x Value of the elements in the diagonal.
                 * @param padLeft Number of positions padded in the left.
                 * @return
                 */
                SparseMatrix* LeftPaddedDiagonal(int dim, double x, int padLeft) override;

                /**
                 * @brief Destructor of a Sparse Matrix.
                 */
                ~SparseMatrixPardiso();

        public: // Append functions.

                /**
                 * @brief Append a row to a matrix from a vector specifying where a row starts in the vector and the size of the row.
                 * @param row Vector containing the row.
                 * @param col_start Position in the vector where the row starts.
                 * @param size Number of elements in the row.
                 */
                void appendRow(dvec& row, int col_start, int size) override;

                /**
                 * @brief Append a chunk of a row to a matrix from a vector specifying where the row starts in the vector and where it has to be copied in the matrix.
                 * @param row Vector containing the chunk of the row.
                 * @param m0 Position in the matrix where the chunk has to be copied.
                 * @param r0 Position in the vector where the chunk starts.
                 * @param size Number of elements in the chunk.
                 * @param rowSize Size of a row in the matrix.
                 */
                void appendChunk(dvec& row, int m0, int r0, int size, int rowSize) override;

                /**
                 * @brief Append a value to the matrix in the column j.
                 * @param value Value appended to the matrix.
                 * @param j Column of the appended element.
                 */
                void appendValue(double value, int j) override;

            public: // Auxiliary functions.

                /**
                 * @brief Update currentRow and rowIndexStart for the next row.
                 */
                void nextRow() override;

                /**
                 * @brief Print vectors rowIndex, data and cols.
                 */
                void debugPrint() override;

                /**
                 * @brief Test if the matrix is approximatelly equal to another matrix using a tolerance value.
                 * @param rhs Another matrix.
                 * @param tol Tolerance value when comparing elements of the matrixes.
                 * @param verbose Show verbose information.
                 * @return
                 */
                bool approxEquals(const SparseMatrix& rhs, double tol = 1e-10, bool verbose = false) override;

            public: // Convert data

                /**
                 * @brief Return the dense version of the matrix as an Eigen matrix.
                 * @return Matrix in dense form.
                 */
                dmat dense() override;

                /**
                 * @brief Get a copy of the diagonal of the matrix inside a vector.
                 * @return Copy of the diagonal of the matrix.
                 */
                dvec getDiagCopy() override;

                /**
                 * @brief Get a copy of a column of the matrix inside a vector.
                 * @param j Column that we want to copy.
                 * @return Copy of the column j.
                 */
                dvec getColCopy(int j) override;

                /**
                 * @brief Get a copy of a row of the matrix inside a vector.
                 * @param i Row that we want to copy.
                 * @return Copy of the row i.
                 */
                dvec getRowCopy(int i) override;

            public: //Operators

                /**
                 * @brief Multiply the matrix by a vector.
                 * @param x Vector to multiply by.
                 * @param transpose Convert the matrix to transpose.
                 * @return Vector resulting of calculating M*b.
                 */
                dvec multiply(dvec& x, bool transpose = false) override;

                /**
                 * @brief Multiply the matrix by a vector a determined number of times. The result overwrites the vector.
                 * @param x Vector to multiply by.
                 * @param times Number of times that the multiplication is done.
                 * @param transpose Convert the matrix to transpose.
                 */
                void multiplyInPlaceRep(dvec& x, int times, bool transpose = false) override;

                /**
                 * @brief Multiply matrix by another matrix.
                 * @param B Matrix to multiply by.
                 * @param transpose Convert the matrix to transpose.
                 * @return Matrix resulting of calculating M*B.
                 */
                SparseMatrix* multiply(SparseMatrix& B, bool transpose = false) override;

                /**
                 * @brief Substract the matrix (Q) from an identity matrix (I) of same dimensions. (I - Q).
                 */
                void subtractIdentity() override;

                /**
                 * @brief Get the element in the position i, j.
                 * @param i Row in which the element is.
                 * @param j Column in which the element is.
                 */
                double search(int i, int j) override;

                /**
                 * @brief Set a value in the position (i, j).
                 * @param x Value to set in the matrix.
                 * @param i Position i of the matrix.
                 * @param j Position j of the matrix.
                 */
                void setValue(double x, int i, int j) override;

                /**
                 * @brief If vector size is higher than expected, resize.
                 */
                void resizeVectors() override;

            public: // I/O operators.

                /**
                 * @brief Save matrix into a file.
                 * @param name Name of the file.
                 */
                void saveMarket(std::string name) override;
        };

    }
}
#endif // SPARSEMATRIXVIENNACL_H
