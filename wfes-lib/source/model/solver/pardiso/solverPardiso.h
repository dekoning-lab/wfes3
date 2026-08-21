#ifndef SOLVERPARDISO_H
#define SOLVERPARDISO_H

#include <string>
#include "model/sparse-matrix/pardiso/sparseMatrixPardiso.h"
#include "model/solver/solver.h"
#include "utils/types.h"
#include "MKL_Consts.h"

namespace wfes{
    namespace pardiso {

        /**
         * @brief The PardisoSolver class implements a matrix system solver using Pardiso MKL.
         */
        class PardisoSolver : public solver::Solver {

                /**
                 * @brief Size of the matrix (number of rows or columns since it is squared.)
                 */
                llong size;

                /**
                 * @brief Number of right-hand sides that need to be solved for. (From MKL Pardiso documentation).
                 */
                llong n_right_hand_sides;

                /**
                 * @brief Maximum number of factors with identical sparsity structure that must be kept in memory at the same time.
                 * In most applications this value is equal to 1. (From MKL Pardiso documentation).
                 */
                llong max_factors;

                /**
                 * @brief Defines the matrix type, which influences the pivoting method. (From MKL Pardiso documentation).
                 * The possible values can be seen in MKL_Consts.h.
                 */
                llong matrix_type;

                /**
                 * @brief Indicates the actual matrix for the solution phase. With this scalar you can define which matrix to factorize. The value must be: 1 ≤mnum≤maxfct.
                 * In most applications this value is 1. (From MKL Pardiso documentation).
                 */
                llong matrix_number;

                /**
                 * @brief Error indicator. More information in MKL pardiso documentation (pardiso method).
                 */
                llong error;

                /**
                 * @brief Message level information. 0 for no information and 1 for verbose. (From MKL Pardiso documentation).
                 */
                llong message_level;

                /**
                 * @brief Controls the execution of the solver. (From MKL Pardiso documentation). More information in MKL pardiso documentation (pardiso method).
                 */
                llong phase;

                /**
                 * @brief Array with control values (configuration of the solver).
                 */
                lvec control;

                /**
                 * @brief Handle to internal data structure. The entries must be set to zero prior to the first call to pardiso. Unique for factorization.
                 * (From MKL Pardiso documentation).
                 */
                lvec internal;

                /**
                 * @brief Array containing the solution.
                 */
                dvec workspace;

            public:

                /**
                 * @brief Constructor of class PardisoSolver.
                 * @param A Sparse matrix to solve.
                 * @param matrix_type Defines the matrix type, which influences the pivoting method. (From MKL Pardiso documentation). The possible values can be seen in MKL_Consts.h.
                 * @param message_level Message level information. 0 for no information and 1 for verbose. (From MKL Pardiso documentation).
                 * @param n_rhs Number of right-hand sides that need to be solved for. (From MKL Pardiso documentation).
                 */
                PardisoSolver(SparseMatrixPardiso& A, llong matrix_type, llong message_level, llong n_rhs = 1);

                /**
                 * Constructor of class PardisoSolver.
                 */
                ~PardisoSolver();

                /**
                 * @brief Preprocess steps over the matrix before solving.
                 */
                void preprocess() override;

                /**
                 * @brief Solve the matrix for one right hand side.
                 * @param b Right hand side of the matrix.
                 * @param transpose True if the matrix needs to be transposed.
                 * @return Solution of the equation (Ax+b).
                 */
                dvec solve(dvec& b, bool transpose = false) override;

                /**
                 * @brief Solve the matrix for multiple right hand sides.
                 * @param b Right hand sides of the matrix.
                 * @param transpose True if the matrix needs to be transposed.
                 * @return Solution of the equation (AX=B).
                 */
                dmat solve_multiple(dmat& b, bool transpose = false) override;

                /// @copydoc Solver::backendName
                std::string backendName() const override { return "Intel MKL Pardiso"; }

                /**
                 * @brief Get diagonal of the matrix.
                 * @return Diagonal of the matrix as a vector.
                 */
                dvec get_diagonal();

                /**
                 * @brief Get error message from code. Codes and descriptions extracted from Intel MKL Pardiso Documentation: https://software.intel.com/content/www/us/en/develop/articles/description-of-pardiso-errors-and-messages.html
                 * @param code Pardiso error code.
                 * @return Description of the error.
                 */
                std::string errorMessage(long long code);
        };
    }
}

#endif // SOLVERPARDISO_H
