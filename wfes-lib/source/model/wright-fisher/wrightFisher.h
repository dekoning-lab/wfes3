#ifndef WRIGHTFISHER_H
#define WRIGHTFISHER_H

#include "backend_config.h"

// Include backend-specific headers based on platform
#ifdef WFES_USE_MKL
    #include "model/solver/pardiso/solverPardiso.h"
    #include <model/sparse-matrix/pardiso/sparseMatrixPardiso.h>
    #include <mkl.h>
#endif

#ifdef WFES_USE_ACCELERATE
    #include "model/solver/accelerate/solverAccelerate.h"
    #include <model/sparse-matrix/accelerate/sparseMatrixAccelerate.h>
#endif

#include "model/solver/solver.h"
#include "model/solver/solverFactory.h"

#include "model/sparse-matrix/sparseMatrix.h"
#include <model/sparse-matrix/sparseMatrixFactory.h>

#include "utils/types.h"

#include "rdist.h"

// (Qt-era ConfigWfesSingle include removed: nothing in this header or in
// wrightFisher.cpp referenced it. It was the only thing tying the core
// Wright-Fisher model to the Qt GUI's configuration singleton.)

namespace wfes{
    namespace wrightfisher {

        /**
         * @enum absorption_type
         * @brief Enumeration containing possible absorption types for Wright-Fisher models
         * 
         * Defines how boundaries (extinction at 0 copies, fixation at 2N copies) are treated
         * in the Wright-Fisher model calculations.
         */
        enum absorption_type { 
            NON_ABSORBING = 0,     ///< Neither boundary is absorbing
            EXTINCTION_ONLY,       ///< Only extinction (0 copies) is absorbing
            FIXATION_ONLY,         ///< Only fixation (2N copies) is absorbing
            BOTH_ABSORBING         ///< Both boundaries are absorbing
        };

        /**
         * @brief Get number of absorbing boundaries for given absorption type
         * @param a_t Absorption type
         * @return Number of absorbing boundaries (0, 1, or 2)
         */
        inline int n_absorbing(absorption_type a_t) {
            switch (a_t) {
            case NON_ABSORBING:
                return 0;
            case EXTINCTION_ONLY:
                return 1;
            case FIXATION_ONLY:
                return 1;
            case BOTH_ABSORBING:
                return 2;
            default:
                // This error should never be thrown since the possible options of the switch are from an enum. If in the future new elements are
                // added to the enum, and those values are not added to this switch statement, this exception could be thrown.
                throw std::runtime_error("Wright Fisher Error: Unknown absorption type.");
            }
        }

        /**
         * @brief Get description of each absorption type.
         * @param a_t Absorption type
         * @return String description of the absorption type
         */
        inline std::string absorption_type_desc(absorption_type a_t) {
            switch (a_t) {
            case NON_ABSORBING:
                return "No absorbing boundaries";
            case EXTINCTION_ONLY:
                return "Only extinction boundary is absorbing";
            case FIXATION_ONLY:
                return "Only fixation boundary is absorbing";
            case BOTH_ABSORBING:
                return "Both extinction and fixation boundaries are absorbing";
            default:
                // This error should never be thrown since the possible options of the switch are from an enum. If in the future new elements are
                // added to the enum, and those values are not added to this switch statement, this exception could be thrown.
                throw std::runtime_error("Wright Fisher Error: Unknown absorption type.");
            }
        }

        /**
         * @class Row
         * @brief Represents a row of the Wright-Fisher transition matrix
         * 
         * This class encapsulates a single row of the transition matrix, including
         * the range of non-zero elements and their values. Used for efficient
         * sparse matrix construction.
         */
        class Row {
          protected:
            mutable bool valid = true;  ///< Internal validity flag for move semantics

          public:
            int start;      ///< Starting index of non-zero elements
            int end;        ///< Ending index of non-zero elements (inclusive)
            int size;       ///< Number of non-zero elements
            double weight;  ///< Row weight (typically 1.0)
            dvec Q;         ///< Vector of transition probabilities

            /**
             * @brief Construct a row with specified range
             * @param start Starting index of non-zero elements
             * @param end Ending index of non-zero elements (inclusive)
             */
            Row(int start, int end)
                : start(start), end(end), size(end - start + 1), weight(1), Q(end - start + 1) {}
            
            /**
             * @brief Default constructor for empty row
             */
            Row() : start(0), end(0), size(0), weight(0), Q(0) {}

            /**
             * @brief Copy constructor with move semantics
             * @param r Row to copy from
             * @note Invalidates the source row after copying
             */
            Row(const Row &r) : start(r.start), end(r.end), size(r.size), weight(r.weight), Q(r.Q) {
                r.valid = false;
            }
        };

        /**
         * @struct Matrix
         * @brief Container for Wright-Fisher transition and absorption matrices
         * 
         * This structure holds both the transient transition matrix Q and the
         * absorption matrix R for Wright-Fisher models with absorbing states.
         */
        struct Matrix {
          protected:
            mutable bool valid = true;  ///< Internal validity flag for move semantics

          public:
            int n_row;  ///< Number of rows in Q matrix
            int n_col;  ///< Number of columns in Q matrix
            int n_abs;  ///< Number of absorbing states
            smat *Q;    ///< Sparse transition matrix (transient states)
            dmat R;     ///< Dense absorption matrix (transient to absorbing)

            /**
             * @brief Construct a Wright-Fisher matrix with specified dimensions
             * @param library Backend library to use (Pardiso, Accelerate, etc.)
             * @param n_row Number of transient states (rows)
             * @param n_col Number of transient states (columns)
             * @param n_abs Number of absorbing states
             */
            Matrix(std::string library, int n_row, int n_col, int n_abs)
                : n_row(n_row), n_col(n_col), n_abs(n_abs), R(n_row, n_abs) {
                Q = wfes::sparsematrix::SparseMatrixFactory::createSparseMatrix(library, n_row, n_col);
                R.setZero();
            }

            /**
             * @brief Copy constructor with destructive-move semantics
             * @param m Matrix to copy from
             * @note Invalidates the source matrix after transferring ownership of Q
             *
             * This shallow-copies the owning pointer Q and marks the source
             * invalid. That is only safe because the destructor now honours
             * `valid`; it previously did not, so any Matrix that was actually
             * copied had its Q deleted twice.
             *
             * Nothing prevented that from happening: every Matrix-returning
             * function in wrightFisher.cpp (Single, Switching, Truncated,
             * EquilibriumSolvingMatrix, ...) builds a NAMED local and returns
             * it, and NRVO is optional -- a compiler that declines it calls
             * this constructor, and before the destructor fix the source's
             * destructor then freed the Q the caller was about to use.
             * The whole family was one optimisation decision away from a
             * use-after-free.
             */
            Matrix(const Matrix &m) : n_row(m.n_row), n_col(m.n_col), n_abs(m.n_abs), Q(m.Q), R(m.R) {
                m.valid = false;
            }

            /**
             * @brief Move constructor
             *
             * Declared so that `return W;` moves rather than falling back to
             * the destructive copy above. Same ownership transfer, but stated
             * in the language the reader and the compiler both expect.
             */
            Matrix(Matrix &&m) noexcept
                : n_row(m.n_row), n_col(m.n_col), n_abs(m.n_abs), Q(m.Q), R(std::move(m.R)) {
                m.valid = false;
                m.Q = nullptr;
            }

            /**
             * @brief Destructor - deallocates the sparse matrix exactly once
             */
            ~Matrix(){
                // Honour `valid`. The flag existed and was set by the copy
                // constructor, but nothing ever read it, so ownership was
                // "transferred" and then freed by both parties.
                if (!valid) return;

                // Plain delete on the base pointer. SparseMatrix declares a
                // virtual destructor (sparseMatrix.h:79), so this dispatches
                // correctly for every backend.
                //
                // This used to be, under WFES_USE_MKL:
                //     delete dynamic_cast<SparseMatrixPardiso*>(Q);
                // which is not just redundant -- on an MKL build it LEAKS the
                // entire matrix whenever Q is not a Pardiso matrix, because the
                // dynamic_cast then yields nullptr and `delete nullptr` is a
                // no-op. That is exactly what `--library SuiteSparse` on Linux
                // produces.
                delete Q;
            }
        };

        /**
         * @brief Calculate transition probability for diploid Wright-Fisher model
         * 
         * Computes the probability that an allele at frequency i/2N in one generation
         * will have a given frequency in the next generation, incorporating selection,
         * dominance, and mutation.
         * 
         * @param i Number of copies of the allele (0 to 2N)
         * @param N Population size (number of diploid individuals)
         * @param s Selection coefficient (positive for beneficial allele)
         * @param h Dominance coefficient (0.5 for additive, 0 for recessive, 1 for dominant)
         * @param u Forward mutation rate (wild-type to mutant)
         * @param v Backward mutation rate (mutant to wild-type)
         * @return double Transition probability
         */
        double psi_diploid(const int i, const int N, const double s = 0, const double h = 0.5,
                           const double u = 1e-9, const double v = 1e-9);
        /**
         * @brief Generate a row of binomial transition probabilities
         * 
         * Creates a sparse row representing binomial sampling with probability p,
         * truncating small probabilities below the threshold alpha.
         * 
         * @param size Total number of trials (2N for diploid population)
         * @param p Success probability for each trial
         * @param alpha Truncation threshold for small probabilities
         * @return Row Sparse row with non-zero transition probabilities
         */
        Row binom_row(const int size, const double p, const double alpha = 1e-20);

        /**
         * @brief Create matrix for solving equilibrium distribution
         * 
         * Constructs a modified Wright-Fisher matrix suitable for finding the
         * stationary distribution. Uses the Harrod method where the last column
         * is replaced with ones to ensure uniqueness of the solution.
         * 
         * @param N Population size
         * @param s Selection coefficient
         * @param h Dominance coefficient
         * @param u Forward mutation rate
         * @param v Backward mutation rate
         * @param alpha Truncation threshold
         * @param verbose Enable verbose output
         * @param block_size Block size for matrix construction
         * @param library Backend library (Pardiso, Accelerate, etc.)
         * @return Matrix Modified matrix for equilibrium calculation
         */
        Matrix EquilibriumSolvingMatrix(const int N, const double s = 0, const double h = 0.5,
                                        const double u = 1e-9, const double v = 1e-9,
                                        const double alpha = 1e-20, const bool verbose = false,
                                        const int block_size = 100, std::string library = "Pardiso");
        /**
         * @brief Calculate equilibrium distribution directly
         * 
         * Convenience function that creates the equilibrium matrix and solves
         * for the stationary distribution in one step.
         * 
         * @param N Population size
         * @param s Selection coefficient
         * @param h Dominance coefficient
         * @param u Forward mutation rate
         * @param v Backward mutation rate
         * @param alpha Truncation threshold
         * @param verbose Enable verbose output
         * @param library Backend library
         * @return dmat Equilibrium distribution vector
         */
        dmat Equilibrium(int N, double s = 0, double h = 0.5, double u = 1e-9, double v = 1e-9,
                         double alpha = 1e-20, bool verbose = false, std::string library = "Pardiso");

        /**
         * @brief Create single Wright-Fisher matrix with specified absorption
         * 
         * Constructs a transition matrix for a Wright-Fisher model with the
         * specified absorption boundary conditions. This is the main function
         * for single-population analyses.
         * 
         * @param Nx Current population size
         * @param Ny Next generation population size (usually same as Nx)
         * @param a_t Absorption type (NON_ABSORBING, EXTINCTION_ONLY, FIXATION_ONLY, BOTH_ABSORBING)
         * @param s Selection coefficient
         * @param h Dominance coefficient
         * @param u Forward mutation rate
         * @param v Backward mutation rate
         * @param recurrent_mutation Whether mutations continue after fixation/loss
         * @param alpha Truncation threshold
         * @param verbose Enable verbose output
         * @param block_size Block size for matrix construction
         * @param library Backend library
         * @return Matrix Transition and absorption matrices
         */
        Matrix Single(const int Nx, const int Ny, const absorption_type a_t, const double s = 0,
                      const double h = 0.5, const double u = 1e-9, const double v = 1e-9,
                      const bool recurrent_mutation = true, const double alpha = 1e-20,
                      const bool verbose = false, const int block_size = 100, std::string library = "Pardiso");

        /**
         * @brief Create Wright-Fisher matrix for allele frequency spectrum
         * 
         * Special version of Single matrix for Wright-Fisher allele frequency
         * spectrum (WFAFS) calculations, supporting variable population sizes.
         * 
         * @param Nx Computational population size
         * @param Ny Next generation computational size
         * @param realNx Actual current population size
         * @param realNy Actual next generation size
         * @param abs_t Absorption type
         * @param s Selection coefficient
         * @param h Dominance coefficient
         * @param u Forward mutation rate
         * @param v Backward mutation rate
         * @param recurrent_mutation Whether mutations continue after fixation/loss
         * @param alpha Truncation threshold
         * @param verbose Enable verbose output
         * @param block_size Block size for matrix construction
         * @param library Backend library
         * @return Matrix Transition and absorption matrices
         */
        Matrix SingleWfafs(const int Nx, const int Ny, const int realNx, const int realNy, const absorption_type abs_t, const double s = 0,
                      const double h = 0.5, const double u = 1e-9, const double v = 1e-9,
                      const bool recurrent_mutation = true, const double alpha = 1e-20,
                      const bool verbose = false, const int block_size = 100, std::string library = "Pardiso");

        /**
         * @brief Create matrix with bounce-back from extinction
         * 
         * Constructs a Wright-Fisher matrix where extinction (0 copies) is not
         * absorbing due to recurrent mutation. The allele can "bounce back"
         * from extinction through new mutations.
         * 
         * @param Nx Current population size
         * @param Ny Next generation population size
         * @param s Selection coefficient
         * @param h Dominance coefficient
         * @param u Forward mutation rate
         * @param v Backward mutation rate
         * @param recurrent_mutation Must be true for bounce behavior
         * @param alpha Truncation threshold
         * @param verbose Enable verbose output
         * @param block_size Block size for matrix construction
         * @param library Backend library
         * @return Matrix Transition and absorption matrices
         */
        Matrix Bounce(const int Nx, const int Ny, const double s = 0, const double h = 0.5,
                      const double u = 1e-9, const double v = 1e-9, const bool recurrent_mutation = true,
                      const double alpha = 1e-20, const bool verbose = false, const int block_size = 100, std::string library = "Pardiso");

        /**
         * @brief Create matrix for dual mutation model
         * 
         * In this model, extinction (0 copies) only becomes absorbing after
         * the first mutation has occurred. Used for studying waiting times
         * until the first mutation and subsequent dynamics.
         * 
         * @param Nx Current population size
         * @param Ny Next generation population size
         * @param s Selection coefficient
         * @param h Dominance coefficient
         * @param u Forward mutation rate
         * @param v Backward mutation rate
         * @param recurrent_mutation Whether mutations continue
         * @param alpha Truncation threshold
         * @param verbose Enable verbose output
         * @param block_size Block size for matrix construction
         * @param library Backend library
         * @return Matrix Transition and absorption matrices
         */
        Matrix DualMutation(const int Nx, const int Ny, const double s = 0, const double h = 0.5,
                            const double u = 1e-9, const double v = 1e-9,
                            const bool recurrent_mutation = true, const double alpha = 1e-20,
                            const bool verbose = false, const int block_size = 100, std::string library = "Pardiso");

        /**
         * @brief Create truncated Wright-Fisher matrix
         * 
         * Similar to Single matrix but with states above threshold t collapsed
         * into the fixation state. Used for establishment probability calculations
         * where we define establishment as reaching a certain frequency.
         * 
         * @param Nx Current population size
         * @param Ny Next generation population size
         * @param t Truncation threshold (number of copies)
         * @param s Selection coefficient
         * @param h Dominance coefficient
         * @param u Forward mutation rate
         * @param v Backward mutation rate
         * @param recurrent_mutation Whether mutations continue
         * @param alpha Truncation threshold for probabilities
         * @param verbose Enable verbose output
         * @param block_size Block size for matrix construction
         * @param library Backend library
         * @return Matrix Transition and absorption matrices
         */
        Matrix Truncated(const int Nx, const int Ny, const int t, const double s, const double h,
                         const double u, const double v, bool recurrent_mutation = true,
                         const double alpha = 1e-20, const bool verbose = false,
                         const int block_size = 100, std::string library = "Pardiso");

        /**
         * @brief Create matrix for switching population parameters
         * 
         * Constructs a compound Wright-Fisher matrix where population parameters
         * (size, selection, etc.) switch stochastically between different regimes.
         * All sub-models must have the same absorption type.
         * 
         * @param N Vector of population sizes for each regime
         * @param a_t Absorption type (same for all regimes)
         * @param s Vector of selection coefficients
         * @param h Vector of dominance coefficients
         * @param u Vector of forward mutation rates
         * @param v Vector of backward mutation rates
         * @param switching Transition matrix between regimes
         * @param alpha Truncation threshold
         * @param verbose Enable verbose output
         * @param block_size Block size for matrix construction
         * @param library Backend library
         * @return Matrix Combined transition and absorption matrices
         */
        Matrix Switching(const lvec &N, const absorption_type a_t, const dvec &s, const dvec &h,
                         const dvec &u, const dvec &v, const dmat &switching, const double alpha = 1e-20,
                         const bool verbose = false, const int block_size = 100, std::string library = "Pardiso");

        /**
         * @brief Create matrix for switching between non-absorbing and fixation-only
         * 
         * Special case of switching model with two regimes: regime A has no
         * absorbing states, regime B has fixation as the only absorbing state.
         * Used for models where absorption behavior changes over time.
         * 
         * @param N Population size (same for both regimes)
         * @param s Vector of selection coefficients (length 2)
         * @param h Vector of dominance coefficients (length 2)
         * @param u Vector of forward mutation rates (length 2)
         * @param v Vector of backward mutation rates (length 2)
         * @param switching 2x2 transition matrix between regimes
         * @param alpha Truncation threshold
         * @param verbose Enable verbose output
         * @param block_size Block size for matrix construction
         * @param library Backend library
         * @return Matrix Combined transition and absorption matrices
         */
        Matrix NonAbsorbingToFixationOnly(const int N, const dvec &s, const dvec &h, const dvec &u,
                                          const dvec &v, const dmat &switching, const double alpha = 1e-20,
                                          const bool verbose = false, const int block_size = 100, std::string library = "Pardiso");

        /**
         * @brief Create matrix for switching between non-absorbing and both-absorbing
         * 
         * Special case of switching model with two regimes: regime A has no
         * absorbing states, regime B has both extinction and fixation as
         * absorbing states. Models scenarios where absorption can be triggered.
         * 
         * @param N Population size (same for both regimes)
         * @param s Vector of selection coefficients (length 2)
         * @param h Vector of dominance coefficients (length 2)
         * @param u Vector of forward mutation rates (length 2)
         * @param v Vector of backward mutation rates (length 2)
         * @param switching 2x2 transition matrix between regimes
         * @param alpha Truncation threshold
         * @param verbose Enable verbose output
         * @param block_size Block size for matrix construction
         * @param library Backend library
         * @return Matrix Combined transition and absorption matrices
         */
        Matrix NonAbsorbingToBothAbsorbing(const int N, const dvec &s, const dvec &h, const dvec &u,
                                           const dvec &v, const dmat &switching, const double alpha = 1e-20,
                                           const bool verbose = false, const int block_size = 100, std::string library = "Pardiso");

    }
}

#endif // WRIGHTFISHER_H
