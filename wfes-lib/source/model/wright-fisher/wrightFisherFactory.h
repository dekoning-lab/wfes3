#ifndef WRIGHTFISHER_H
#define WRIGHTFISHER_H

namespace wfes{
    namespace wrightfisher {

    /**
     * @brief Instantiate a Sparse Matrix using a given library.
     */
    class SparseMatrixFactory{
        public:

            /**
             * @brief Create an empty Sparse Matrix in the requested format. Return instances of Sparse Matrix in a format compatible with Pardiso or ViennaCL.
             * @param library String with the name of the used library.
             * @param numRows Number of rows for the matrix.
             * @param numCols Number of columns for the matrix.
             * @return A pointer to the instantiated Sparse Matrix.
             */
            static SparseMatrix* createSparseMatrix(std::string library, llong numRows, llong numCols);

            /**
             * @brief Create a Sparse Matrix in the requested format from an Eigen Sparse Matrix. Return instances of Sparse Matrix in a format compatible with Pardiso or ViennaCL.
             * @param library String with the name of the used library.
             * @param eigenSparseMatrix A Sparse Matrix stored in Eigen format.
             * @return A pointer to the instantiated Sparse Matrix.
             */
            static SparseMatrix* createSparseMatrix(std::string library, dmat eigenSparseMatrix);

    };

    }
}

#endif // WRIGHTFISHER_H
