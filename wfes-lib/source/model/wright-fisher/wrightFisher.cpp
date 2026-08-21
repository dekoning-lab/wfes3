#include "wrightFisher.h"
#include <cmath>  // For std::exp
#include <sstream>
#include <stdexcept>
#include <string>

using namespace wfes::wrightfisher;
// (Qt-era `using namespace wfes::config;` removed alongside the
//  configWfesSingle.h include in wrightFisher.h -- nothing in this file
//  referenced that namespace.)

namespace {

// Every validation check in this file is an explicit `throw`, never an
// assert(). wfes-cli now builds Release (-DNDEBUG) by default, which deletes
// assert() bodies outright; a guard that vanishes from the shipped binary is
// not a guard. See the "Default build type" block in wfes-cli/CMakeLists.txt.
//
// Values are formatted through a stream rather than std::to_string, which
// would print every mutation rate in these messages as "0.000000".
std::string fmt_param(double x) {
    std::ostringstream os;
    os << x;
    return os.str();
}

}  // namespace

double wfes::wrightfisher::psi_diploid(const int i, const int N, const double s, const double h,
                                 const double u, const double v) {

    int j = (2 * N) - i;
    double w_11 = fmax(1 + s, 1e-30);
    double w_12 = fmax(1 + (s * h), 1e-30);
    double w_22 = 1;
    double a = w_11 * i * i;
    double b = w_12 * i * j;
    double c = w_22 * j * j;
    double w_bar = a + (2 * b) + c;
    return (((a + b) * (1 - u)) + ((b + c) * v)) / w_bar;
}

wfes::wrightfisher::Row wfes::wrightfisher::binom_row(const int size, const double p, const double alpha) {

    int start = 0;
    int end = size;
    if (alpha != 0) {
        // start and end quantiles for covering 1 - alpha weight of the probability mass
        start = (int)binom_tail_cover(alpha / 2, size, p, true);
        end = (int)binom_tail_cover(alpha / 2, size, p, false);
    }
    // patch
    if (start < 0)
        start = 0;
    if (end <= 0)
        end = size;

    // make sure we didn't mess up
    // #ifndef NDEBUG
    // std::cout << start << " " << end << " " << p << std::endl;
    // #endif // NDEBUG
    if (!((start < end) && (start >= 0) && (end > 0))) {
        throw std::invalid_argument(
            "binom_row: the tail-truncation quantile range is empty or negative "
            "(start=" + std::to_string(start) + ", end=" + std::to_string(end) +
            "). Check --alpha (tail truncation weight, given " + fmt_param(alpha) +
            ") against the population size.");
    }

    // Initialize row
    Row r(start, end);

    // Start iterative binomial calculation (WFES supplementary, eq 18,19)
    double d = ld_binom(start, size, p);
    double lc = log(p) - log(1 - p);
    r.Q(0) = d;

    // Iterative binomial (in log)
    for (int j = start + 1; j <= end; j++) {
        d += log(size - j + 1) - log(j) + lc;
        r.Q(j - start) = d;
    }

    // Exponentiate
#ifdef WFES_USE_MKL
    vdExp(r.Q.size(), r.Q.data(), r.Q.data());
#else
    // Standard C++ implementation for non-MKL platforms
    for (int i = 0; i < r.Q.size(); i++) {
        r.Q(i) = std::exp(r.Q(i));
    }
#endif
    // Re-weigh to sum to 1
    r.weight = r.Q.sum();
    r.Q /= r.weight;

    return r;
}

wfes::wrightfisher::Matrix wfes::wrightfisher::EquilibriumSolvingMatrix(const int N, const double s,
                                                            const double h, const double u,
                                                            const double v, const double alpha,
                                                            const bool verbose,
                                                            const int block_size, std::string library) {
    time_point t_start, t_end;
    if (verbose)
        t_start = std::chrono::system_clock::now();
    int N2 = 2 * N;
    int size = N2 + 1;
    wfes::wrightfisher::Matrix W(library, size, size, n_absorbing(wfes::wrightfisher::NON_ABSORBING));
    for (int block_row = 0; block_row < size; block_row += block_size) {
        int block_length = (block_row + block_size) < size ? block_size : size - block_row;
        std::deque<Row> buffer(block_length);

#pragma omp parallel for
        for (int b = 0; b < block_length; b++) {
            int i = b + block_row;
            buffer[b] = binom_row(2 * N, psi_diploid(i, N, s, h, u, v), alpha);
            Row &r = buffer[b];
            // I - Q
            for (int j = 0; j < r.Q.size(); j++)
                r.Q(j) = -r.Q(j);
            // r.Q = -r.Q;
            // diagonal is set in the sequential block - since it may require a structural change to
            // the matrix
            // r.Q(i - r.start) += 1;
        }

        for (int b = 0; b < block_length; b++) {
            Row &r = buffer[b];
            int i = b + block_row;

            // diagnoal is left of chunk - insert new entry before chunk
            if (i < r.start)
                W.Q->appendValue(1, i);
            // diagonal overlaps chunk - increment element
            if (i >= r.start && i <= r.end)
                r.Q(i - r.start) += 1;
            // update chunk if it contains last column
            if (r.end == N2)
                r.Q(r.size - 1) = 1;
            // append large chunk
            W.Q->appendChunk(r.Q, r.start, 0, r.size, size);
            // diagonal is right of chunk - insert new entry after chunk
            if (i > r.end)
                W.Q->appendValue(1, i);
            // add a column of 1s on the end
            if (r.end != N2)
                W.Q->appendValue(1, N2);

            W.Q->nextRow();
        }
    }
    if (verbose) {
        t_end = std::chrono::system_clock::now();
        time_diff dt = t_end - t_start;
        std::cout << "Time to build matrix: " << dt.count() << " s" << std::endl;
    }

    W.Q->resizeVectors();

    return W;
}

dmat wfes::wrightfisher::Equilibrium(int N, double s, double h, double u, double v, double alpha,
                               bool verbose, std::string library) {
    // Forward the caller's backend choice. This previously omitted `library`,
    // so EquilibriumSolvingMatrix fell back to its default parameter value
    // "Pardiso" no matter what the user asked for. On a build without MKL that
    // throws ("Pardiso sparse matrix not available on this platform"), which
    // made every code path that needs an equilibrium initial distribution fail
    // outright on Apple Silicon even with --library Accelerate. Note the
    // block_size parameter sits before `library` in the signature, so the
    // default must be passed explicitly to reach the right argument.
    Matrix wf_eq = EquilibriumSolvingMatrix(N, s, h, u, v, alpha, verbose, 100, library);

    // Platform-agnostic constants (matching mkl_constants.h values)
    const long long MSG_QUIET = 0;
    const long long MSG_VERBOSE = 1;
    const long long MATRIX_TYPE_REAL_UNSYMMETRIC = 11;

    int msg_level = verbose ? MSG_VERBOSE : MSG_QUIET;

    wfes::solver::Solver* solver = wfes::solver::SolverFactory::createSolver(library, (*wf_eq.Q), MATRIX_TYPE_REAL_UNSYMMETRIC, msg_level);

    solver->preprocess();

    dvec id = dvec::Zero(wf_eq.Q->num_rows);
    id(wf_eq.Q->num_rows - 1) = 1;

    dvec eq = solver->solve(id, true);
    eq = eq.array().abs();
    eq /= eq.sum();

    return eq.matrix();
}

wfes::wrightfisher::Matrix wfes::wrightfisher::Single(const int Nx, const int Ny,
                                          const absorption_type abs_t, const double s,
                                          const double h, const double u, const double v,
                                          bool recurrent_mutation, const double alpha,
                                          const bool verbose, const int block_size, std::string library) {
    time_point t_start, t_end;
    if (verbose)
        t_start = std::chrono::system_clock::now();
    bool verify_diagonal = (Nx == Ny);
    int Nx2 = 2 * Nx;
    int Ny2 = 2 * Ny;
    int size = Nx2 + 1;

    //Calculate sizes and use it in append chunk

    int n_abs = n_absorbing(abs_t);

    Matrix *W = new Matrix(library, Nx2 + 1 - n_abs, Ny2 + 1 - n_abs, n_abs);

    for (int block_row = 0; block_row <= Nx2; block_row += block_size) {
        int block_length = (block_row + block_size) < size ? block_size : size - block_row;
        std::deque<Row> buffer(block_length);

#pragma omp parallel for
        for (int b = 0; b < block_length; b++) {
            int i = b + block_row;
            if (!recurrent_mutation && i != 0) {
                buffer[b] = binom_row(2 * Ny, psi_diploid(i, Nx, s, h, 0, 0), alpha);
            } else {
                buffer[b] = binom_row(2 * Ny, psi_diploid(i, Nx, s, h, u, v), alpha);
            }
        }

        for (int b = 0; b < block_length; b++) {
            Row &r = buffer[b];
            int i = b + block_row;
            int r_last = r.size - 1;

            // diagonal is left of inserted chunk
            if (verify_diagonal && (i < r.start))
                W->Q->appendValue(0, i);

            switch (abs_t) {
            case NON_ABSORBING:
                // Include full row
                W->Q->appendChunk(r.Q, r.start, 0, r.size, size);
                // diagonal on the right
                if (verify_diagonal && (i > r.end))
                    W->Q->appendValue(0, i);
                W->Q->nextRow();
                break;

            case EXTINCTION_ONLY:
                // Do not include 0th row and column
                if (i == 0)
                    continue;
                else {
                    if (r.start == 0) {
                        W->Q->appendChunk(r.Q, 0, 1, r.size - 1, size);
                        W->R(i - 1, 0) = r.Q(0);
                    } else {
                        W->Q->appendChunk(r.Q, r.start - 1, 0, r.size, size);
                    }
                    // diagonal on the right
                    if (verify_diagonal && (i > r.end))
                        W->Q->appendValue(0, i);
                    W->Q->nextRow();
                }
                break;

            case FIXATION_ONLY:
                // Do not include Nx2th row and column
                if (i == Nx2)
                    continue;
                else {
                    if (r.end == Ny2) {
                        W->Q->appendChunk(r.Q, r.start, 0, r.size - 1, size);
                        W->R(i, 0) = r.Q(r_last);
                    } else {
                        W->Q->appendChunk(r.Q, r.start, 0, r.size, size);
                    }
                    // diagonal on the right
                    if (verify_diagonal && (i > r.end))
                        W->Q->appendValue(0, i);
                    W->Q->nextRow();
                }
                break;

            case BOTH_ABSORBING:
                // Do not include 0th and Nx2th row and column
                if (i == 0 || i == Nx2)
                    continue;
                else {
                    if (r.start == 0 && r.end == Ny2) {
                        W->Q->appendChunk(r.Q, 0, 1, r.size - 2, size);
                        W->R(i - 1, 0) = r.Q(0);
                        W->R(i - 1, 1) = r.Q(r_last);
                    } else if (r.start == 0) {
                        W->Q->appendChunk(r.Q, 0, 1, r.size - 1, size);
                        W->R(i - 1, 0) = r.Q(0);
                    } else if (r.end == Ny2) {
                        W->Q->appendChunk(r.Q, r.start - 1, 0, r.size - 1, size);
                        W->R(i - 1, 1) = r.Q(r_last);
                    } else {
                        W->Q->appendChunk(r.Q, r.start - 1, 0, r.size, size);
                    }
                    // diagonal on the right
                    if (verify_diagonal && (i > r.end))
                        W->Q->appendValue(0, i);
                    W->Q->nextRow();
                }
                break;
            }
        }
    }

    if (verbose) {
        t_end = std::chrono::system_clock::now();
        time_diff dt = t_end - t_start;
        std::cout << "Time to build matrix: " << dt.count() << " s" << std::endl;
    }

    W->Q->resizeVectors();

    return *W;
}


wfes::wrightfisher::Matrix wfes::wrightfisher::SingleWfafs(const int Nx, const int Ny, const int realNx, const int realNy, const absorption_type abs_t, const double s, const double h, const double u, const double v, const bool recurrent_mutation, const double alpha, const bool verbose, const int block_size, std::string library)
{
    time_point t_start, t_end;
    if (verbose)
        t_start = std::chrono::system_clock::now();
    bool verify_diagonal = (Nx == Ny);
    int Nx2 = 2 * Nx;
    int Ny2 = 2 * Ny;
    int size = Nx2 + 1;
    int realSize = realNx * 2 + 1;

    //Calculate sizes and use it in append chunk

    int n_abs = n_absorbing(abs_t);

    Matrix *W = new Matrix(library, Nx2 + 1 - n_abs, Ny2 + 1 - n_abs, n_abs);

    for (int block_row = 0; block_row <= Nx2; block_row += block_size) {
        int block_length = (block_row + block_size) < size ? block_size : size - block_row;
        std::deque<Row> buffer(block_length);

#pragma omp parallel for
        for (int b = 0; b < block_length; b++) {
            int i = b + block_row;
            if (!recurrent_mutation && i != 0) {
                buffer[b] = binom_row(2 * Ny, psi_diploid(i, Nx, s, h, 0, 0), alpha);
            } else {
                buffer[b] = binom_row(2 * Ny, psi_diploid(i, Nx, s, h, u, v), alpha);
            }
        }

        for (int b = 0; b < block_length; b++) {
            Row &r = buffer[b];
            int i = b + block_row;
            int r_last = r.size - 1;

            // diagonal is left of inserted chunk
            if (verify_diagonal && (i < r.start))
                W->Q->appendValue(0, i);

            switch (abs_t) {
            case NON_ABSORBING:
                // Include full row
                W->Q->appendChunk(r.Q, r.start, 0, r.size, realSize);
                // diagonal on the right
                if (verify_diagonal && (i > r.end))
                    W->Q->appendValue(0, i);
                W->Q->nextRow();
                break;

            case EXTINCTION_ONLY:
                // Do not include 0th row and column
                if (i == 0)
                    continue;
                else {
                    if (r.start == 0) {
                        W->Q->appendChunk(r.Q, 0, 1, r.size - 1, realSize);
                        W->R(i - 1, 0) = r.Q(0);
                    } else {
                        W->Q->appendChunk(r.Q, r.start - 1, 0, r.size, realSize);
                    }
                    // diagonal on the right
                    if (verify_diagonal && (i > r.end))
                        W->Q->appendValue(0, i);
                    W->Q->nextRow();
                }
                break;

            case FIXATION_ONLY:
                // Do not include Nx2th row and column
                if (i == Nx2)
                    continue;
                else {
                    if (r.end == Ny2) {
                        W->Q->appendChunk(r.Q, r.start, 0, r.size - 1, realSize);
                        W->R(i, 0) = r.Q(r_last);
                    } else {
                        W->Q->appendChunk(r.Q, r.start, 0, r.size, realSize);
                    }
                    // diagonal on the right
                    if (verify_diagonal && (i > r.end))
                        W->Q->appendValue(0, i);
                    W->Q->nextRow();
                }
                break;

            case BOTH_ABSORBING:
                // Do not include 0th and Nx2th row and column
                if (i == 0 || i == Nx2)
                    continue;
                else {
                    if (r.start == 0 && r.end == Ny2) {
                        W->Q->appendChunk(r.Q, 0, 1, r.size - 2, realSize);
                        W->R(i - 1, 0) = r.Q(0);
                        W->R(i - 1, 1) = r.Q(r_last);
                    } else if (r.start == 0) {
                        W->Q->appendChunk(r.Q, 0, 1, r.size - 1, realSize);
                        W->R(i - 1, 0) = r.Q(0);
                    } else if (r.end == Ny2) {
                        W->Q->appendChunk(r.Q, r.start - 1, 0, r.size - 1, realSize);
                        W->R(i - 1, 1) = r.Q(r_last);
                    } else {
                        W->Q->appendChunk(r.Q, r.start - 1, 0, r.size, realSize);
                    }
                    // diagonal on the right
                    if (verify_diagonal && (i > r.end))
                        W->Q->appendValue(0, i);
                    W->Q->nextRow();
                }
                break;
            }
        }
    }

    if (verbose) {
        t_end = std::chrono::system_clock::now();
        time_diff dt = t_end - t_start;
        std::cout << "Time to build matrix: " << dt.count() << " s" << std::endl;
    }

    W->Q->resizeVectors();

    return *W;
}


wfes::wrightfisher::Matrix wfes::wrightfisher::Bounce(const int Nx, const int Ny, const double s,
                                          const double h, const double u, const double v,
                                          bool recurrent_mutation, const double alpha,
                                          const bool verbose, const int block_size, std::string library) {
    time_point t_start, t_end;
    if (verbose)
        t_start = std::chrono::system_clock::now();
    bool verify_diagonal = (Nx == Ny);
    int Nx2 = 2 * Nx;
    int Ny2 = 2 * Ny;
    int size = Nx2 + 1;

    Matrix *W = new Matrix(library, Nx2 - 1, Ny2 - 1, 1);

    for (int block_row = 0; block_row <= Nx2; block_row += block_size) {
        int block_length = (block_row + block_size) < size ? block_size : size - block_row;
        std::deque<Row> buffer(block_length);

#pragma omp parallel for
        for (int b = 0; b < block_length; b++) {
            int i = b + block_row;
            if (!recurrent_mutation && i != 0) {
                buffer[b] = binom_row(2 * Ny, psi_diploid(i, Nx, s, h, 0, 0), alpha);
            } else {
                buffer[b] = binom_row(2 * Ny, psi_diploid(i, Nx, s, h, u, v), alpha);
            }
        }

        for (int b = 0; b < block_length; b++) {
            Row &r = buffer[b];
            int i = b + block_row;
            int r_last = r.size - 1;

            // diagonal is left of inserted chunk
            if (verify_diagonal && (i < r.start))
                W->Q->appendValue(0, i);

            // Do not include 0th and Nx2th row and column
            if (i == 0 || i == Nx2)
                continue;
            else {
                if (r.start == 0 && r.end == Ny2) {
                    r.Q(1) += r.Q(0);
                    W->Q->appendChunk(r.Q, 0, 1, r.size - 2, size);
                    W->R(i - 1, 0) = r.Q(r_last);
                } else if (r.start == 0) {
                    r.Q(1) += r.Q(0);
                    W->Q->appendChunk(r.Q, 0, 1, r.size - 1, size);
                } else if (r.end == Ny2) {
                    W->Q->appendChunk(r.Q, r.start - 1, 0, r.size - 1, size);
                    W->R(i - 1, 0) = r.Q(r_last);
                } else {
                    W->Q->appendChunk(r.Q, r.start - 1, 0, r.size, size);
                }
                // diagonal on the right
                if (verify_diagonal && (i > r.end))
                    W->Q->appendValue(0, i);
                W->Q->nextRow();
            }
        }
    }

    if (verbose) {
        t_end = std::chrono::system_clock::now();
        time_diff dt = t_end - t_start;
        std::cout << "Time to build matrix: " << dt.count() << " s" << std::endl;
    }

    W->Q->resizeVectors();

    return *W;
}

wfes::wrightfisher::Matrix wfes::wrightfisher::DualMutation(const int Nx, const int Ny, const double s,
                                                const double h, const double u, const double v,
                                                bool recurrent_mutation, const double alpha,
                                                const bool verbose, const int block_size, std::string library) {
    time_point t_start, t_end;
    if (verbose)
        t_start = std::chrono::system_clock::now();
    bool verify_diagonal = (Nx == Ny);
    int Nx2 = 2 * Nx;
    int Ny2 = 2 * Ny;
    int size = Nx2 + 1;

    Matrix *W = new Matrix(library, Nx2, Ny2, 2);

    for (int block_row = 0; block_row <= Nx2; block_row += block_size) {
        int block_length = (block_row + block_size) < size ? block_size : size - block_row;
        std::deque<Row> buffer(block_length);

#pragma omp parallel for
        for (int b = 0; b < block_length; b++) {
            int i = b + block_row;
            if (!recurrent_mutation && i != 0) {
                buffer[b] = binom_row(2 * Ny, psi_diploid(i, Nx, s, h, 0, 0), alpha);
            } else {
                buffer[b] = binom_row(2 * Ny, psi_diploid(i, Nx, s, h, u, v), alpha);
            }
        }

        for (int b = 0; b < block_length; b++) {
            Row &r = buffer[b];
            int i = b + block_row;
            int r_last = r.size - 1;

            // diagonal is left of inserted chunk
            if (verify_diagonal && (i < r.start))
                W->Q->appendValue(0, i);

            // Do not include Nx2th row
            if (i == Nx2)
                continue;
            else {
                if (i == 0) {
                    W->Q->appendChunk(r.Q, r.start, 0, r.size, size);
                } else if (r.start == 0 && r.end == Ny2) {
                    W->Q->appendChunk(r.Q, 1, 1, r.size - 2, size);
                    W->R(i, 0) = r.Q(0);
                    W->R(i, 1) = r.Q(r_last);
                } else if (r.start == 0) {
                    W->Q->appendChunk(r.Q, 1, 1, r.size - 1, size);
                    W->R(i, 0) = r.Q(0);
                } else if (r.end == Ny2) {
                    W->Q->appendChunk(r.Q, r.start, 0, r.size - 1, size);
                    W->R(i, 1) = r.Q(r_last);
                } else {
                    W->Q->appendChunk(r.Q, r.start, 0, r.size, size);
                }
                // diagonal on the right
                if (verify_diagonal && (i > r.end))
                    W->Q->appendValue(0, i);
                W->Q->nextRow();
            }
        }
    }

    if (verbose) {
        t_end = std::chrono::system_clock::now();
        time_diff dt = t_end - t_start;
        std::cout << "Time to build matrix: " << dt.count() << " s" << std::endl;
    }

    W->Q->resizeVectors();

    return *W;
}

wfes::wrightfisher::Matrix wfes::wrightfisher::Truncated(const int Nx, const int Ny, const int t,
                                             const double s, const double h, const double u,
                                             const double v, bool recurrent_mutation,
                                             const double alpha, const bool verbose,
                                             const int block_size, std::string library) {
    time_point t_start, t_end;
    if (verbose)
        t_start = std::chrono::system_clock::now();
    bool verify_diagonal = (Nx == Ny);
    int Nx2 = 2 * Nx;
    // int Ny2 = 2 * Ny;
    int size = Nx2 + 1;

    Matrix *W = new Matrix(library, t - 1, t - 1, 2);

    for (int block_row = 0; block_row <= t; block_row += block_size) {
        int block_length = (block_row + block_size) < t ? block_size : t - block_row;
        std::deque<Row> buffer(block_length);

#pragma omp parallel for
        for (int b = 0; b < block_length; b++) {
            int i = b + block_row;
            if (!recurrent_mutation && i != 0) {
                buffer[b] = binom_row(2 * Ny, psi_diploid(i, Nx, s, h, 0, 0), alpha);
            } else {
                buffer[b] = binom_row(2 * Ny, psi_diploid(i, Nx, s, h, u, v), alpha);
            }
        }

        for (int b = 0; b < block_length; b++) {
            Row &r = buffer[b];
            int i = b + block_row;
            // int r_last = r.size - 1;
            int t_off = t - r.start;

            // diagonal is left of inserted chunk
            if (verify_diagonal && (i < r.start))
                W->Q->appendValue(0, i);
            // Do not include 0th and t-th row and column
            if (i == 0 || i == t)
                continue;
            else {

                if (r.start == 0 && r.end >= t) {
                    W->Q->appendChunk(r.Q, 0, 1, t - 1, size);
                    W->R(i - 1, 0) = r.Q(0);
                    // Length r.end - t + 1, not r.end - t: Row::end is INCLUSIVE
                    // (see wrightFisher.h), and t_off = t - r.start maps state t
                    // to r.Q[t_off], so the collapsed above-threshold column must
                    // cover states t..r.end inclusive. The previous length
                    // omitted state r.end -- with alpha = 0 that is state 2N, so
                    // the probability of jumping straight to fixation was dropped
                    // and rows of the truncated system did not sum to 1
                    // (measured deficits up to 1.4e-4 at N=5, s=0.1, k=1.5).
                    //
                    // This is equivalent to the residual form the thesis gives,
                    // R_2i = 1 - R_1i - sum_j Q_ij (establishment.tex:274),
                    // whenever tail truncation is negligible, and is preferred
                    // over the literal residual because a row whose support ends
                    // below the establishment boundary must contribute no
                    // establishment mass -- the residual would misassign the
                    // discarded tail there.
                    double rest = r.Q.segment(t_off, r.end - t + 1).sum();
                    W->R(i - 1, 1) = rest;
                } else if (r.start == 0) {
                    W->Q->appendChunk(r.Q, 0, 1, r.size - 1, size);
                    W->R(i - 1, 0) = r.Q(0);
                } else if (r.end >= t) {
                    W->Q->appendChunk(r.Q, r.start - 1, 0, t - r.start, Nx);
                    // Length r.end - t + 1, not r.end - t: Row::end is INCLUSIVE
                    // (see wrightFisher.h), and t_off = t - r.start maps state t
                    // to r.Q[t_off], so the collapsed above-threshold column must
                    // cover states t..r.end inclusive. The previous length
                    // omitted state r.end -- with alpha = 0 that is state 2N, so
                    // the probability of jumping straight to fixation was dropped
                    // and rows of the truncated system did not sum to 1
                    // (measured deficits up to 1.4e-4 at N=5, s=0.1, k=1.5).
                    //
                    // This is equivalent to the residual form the thesis gives,
                    // R_2i = 1 - R_1i - sum_j Q_ij (establishment.tex:274),
                    // whenever tail truncation is negligible, and is preferred
                    // over the literal residual because a row whose support ends
                    // below the establishment boundary must contribute no
                    // establishment mass -- the residual would misassign the
                    // discarded tail there.
                    double rest = r.Q.segment(t_off, r.end - t + 1).sum();
                    W->R(i - 1, 1) = rest;
                } else {
                    W->Q->appendChunk(r.Q, r.start - 1, 0, r.size, size);
                }
                // diagonal on the right
                if (verify_diagonal && (i > r.end))
                    W->Q->appendValue(0, i);
                W->Q->nextRow();
            }
        }
    }

    if (verbose) {
        t_end = std::chrono::system_clock::now();
        time_diff dt = t_end - t_start;
        std::cout << "Time to build matrix: " << dt.count() << " s" << std::endl;
    }

    W->Q->resizeVectors();

    return *W;
}

std::deque<std::pair<int, int>> submatrix_indeces(const lvec &sizes) {
    int i = 0;
    int j = 0;

    int size = sizes.sum();

    std::deque<std::pair<int, int>> idx(size);

    for (int r = 0; r < size; r++) {
        if (j == sizes(i)) {
            j = 0;
            i++;
        }
        idx[r].first = i;
        idx[r].second = j;
        j++;
    }
    return idx;
}

wfes::wrightfisher::Matrix wfes::wrightfisher::Switching(const lvec &N, const absorption_type abs_t,
                                             const dvec &s, const dvec &h, const dvec &u,
                                             const dvec &v, const dmat &switching, double alpha,
                                             const bool verbose, const int block_size, std::string library) {
    time_point t_start, t_end;
    if (verbose)
        t_start = std::chrono::system_clock::now();

    int k = N.size();

    if (abs_t == EXTINCTION_ONLY) {
        // backward mutation rate should be above 0
        for (int i = 0; i < k; i++) {
            if (!(u(i) > 0)) {
                throw std::invalid_argument(
                    "Switching (extinction-only model): --backward-mu (-u) entry " +
                    std::to_string(i) + " must be greater than 0, got " +
                    fmt_param(u(i)) + ".");
            }
        }
    } else if (abs_t == FIXATION_ONLY) {
        // forward mutation rate should be above 0
        for (int i = 0; i < k; i++) {
            if (!(v(i) > 0)) {
                throw std::invalid_argument(
                    "Switching (fixation-only model): --forward-mu (-v) entry " +
                    std::to_string(i) + " must be greater than 0, got " +
                    fmt_param(v(i)) + ".");
            }
        }
    }

    int n_abs_total = n_absorbing(abs_t) * k;
    lvec sizes = 2 * N + lvec::Ones(k);
    int size = sizes.sum();

    Matrix *W = new Matrix(library, size - n_abs_total, size - n_abs_total, n_abs_total);
    std::deque<std::pair<int, int>> index = submatrix_indeces(sizes);

    for (int block_row = 0; block_row <= size; block_row += block_size) {
        int block_length = (block_row + block_size) < size ? block_size : size - block_row;
        std::deque<std::deque<Row>> buffer(block_length);
        for (int b = 0; b < block_length; b++)
            buffer[b] = std::deque<Row>(k);

#pragma omp parallel for
        for (int b = 0; b < block_length; b++) {
            int row = b + block_row;
            int i = index[row].first;   // model index
            int im = index[row].second; // current index within model i

            for (int j = 0; j < k; j++) {
                double p = psi_diploid(im, N(i), s(j), h(j), u(j), v(j));
                buffer[b][j] = binom_row(2 * N(j), p, alpha);
                buffer[b][j].Q *= switching(i, j);
            }
        }

        for (int b = 0; b < block_length; b++) {
            int row = b + block_row;
            int i = index[row].first;   // model index
            int im = index[row].second; // current index within model i
            int offset = 0;             // coordinate of the submodel start

            // BEGIN ITERATOR ROW
            for (int j = 0; j < k; j++) {
                Row &r = buffer[b][j];
                bool row_complete = (j == (k - 1));
                int m_start = r.start + offset;
                // int m_end          = r.end + offset;
                int r_last = r.size - 1;
                bool verify_diagonal = (i == j);

                if (verify_diagonal && (im < r.start))
                    W->Q->appendValue(0, im + offset);

                switch (abs_t) {
                case NON_ABSORBING:
                    W->Q->appendChunk(r.Q, m_start, 0, r.size, size);
                    break;

                case EXTINCTION_ONLY:
                    if (im == 0)
                        continue;
                    else {
                        if (r.start == 0) {
                            W->Q->appendChunk(r.Q, m_start, 1, r.size - 1, size);
                            W->R(row - (i + 1), j) = r.Q(0);
                        } else {
                            W->Q->appendChunk(r.Q, m_start - 1, 0, r.size, size);
                        }
                    }
                    break;

                case FIXATION_ONLY:
                    if (im == N(i) * 2)
                        continue;
                    else {
                        if (r.end == N(j) * 2) {
                            W->Q->appendChunk(r.Q, m_start, 0, r.size - 1, size);
                            W->R(row - i, j) = r.Q(r_last);
                        } else {
                            W->Q->appendChunk(r.Q, m_start, 0, r.size, size);
                        }
                    }
                    break;

                case BOTH_ABSORBING:
                    if (im == 0 || im == N(i) * 2)
                        continue;
                    else {
                        if (r.start == 0 && r.end == N(j) * 2) {
                            W->Q->appendChunk(r.Q, m_start, 1, r.size - 2, size);
                            // TODO: why is this not `row` ?
                            W->R(row - i - i - 1, 2 * j) = r.Q(0);
                            W->R(row - i - i - 1, (2 * j) + 1) = r.Q(r_last);
                        } else if (r.start == 0) {
                            W->Q->appendChunk(r.Q, m_start, 1, r.size - 1, size);
                            W->R(row - i - i - 1, 2 * j) = r.Q(0);
                        } else if (r.end == N(j) * 2) {
                            W->Q->appendChunk(r.Q, m_start - 1, 0, r.size - 1, size);
                            W->R(row - i - i - 1, (2 * j) + 1) = r.Q(r_last);
                        } else {
                            W->Q->appendChunk(r.Q, m_start - 1, 0, r.size, size);
                        }
                    }
                    break;
                }
                if (verify_diagonal && (im > r.end))
                    W->Q->appendValue(0, im + offset);
                // Increment row offset
                offset += (sizes(j) - n_absorbing(abs_t));
                // This needs to be inside in case block_sizes are unbalanced
                if (row_complete)
                    W->Q->nextRow();
            } // END ROW
        }
    }

    if (verbose) {
        t_end = std::chrono::system_clock::now();
        time_diff dt = t_end - t_start;
        std::cout << "Time to build matrix: " << dt.count() << " s" << std::endl;
    }

    W->Q->resizeVectors();

    return *W;
}

wfes::wrightfisher::Matrix wfes::wrightfisher::NonAbsorbingToFixationOnly(const int N, const dvec &s, const dvec &h, const dvec &u,
                                         const dvec &v, const dmat &switching, const double alpha,
                                         const bool verbose, const int block_size, std::string library) {
    time_point t_start, t_end;
    if (verbose)
        t_start = std::chrono::system_clock::now();

    if (s.size() != 2) {
        throw std::invalid_argument(
            "NonAbsorbingToFixationOnly: --selection (-s) must have exactly 2 entries "
            "(one per regime: pre-sweep, sweep), got " + std::to_string(s.size()) + ".");
    }
    // forward mutation rate should be above 0
    for (int i = 0; i < 2; i++) {
        if (!(v(i) > 0)) {
            throw std::invalid_argument(
                "NonAbsorbingToFixationOnly (fixation-only model): --forward-mu (-v) "
                "entry " + std::to_string(i) + " must be greater than 0, got " +
                fmt_param(v(i)) + ".");
        }
    }

    lvec sizes(2);
    sizes << (2 * N) + 1, 2 * N;
    int size = sizes.sum();

    Matrix *W = new Matrix(library, size, size, 1);
    std::deque<std::pair<int, int>> index = submatrix_indeces(sizes);

    for (int block_row = 0; block_row < size; block_row += block_size) {
        int block_length = (block_row + block_size) < size ? block_size : size - block_row;
        std::deque<Row> b_1(block_length);
        std::deque<Row> b_2(block_length);

#pragma omp parallel for
        for (int b = 0; b < block_length; b++) {
            int row = block_row + b;
            int i = index[row].first;   // model index
            int im = index[row].second; // current index within model i

            Row r_1 = binom_row(2 * N, psi_diploid(im, N, s(0), h(0), u(0), v(0)), alpha);
            r_1.Q *= switching(i, 0);
            b_1[b] = r_1;

            Row r_2 = binom_row(2 * N, psi_diploid(im, N, s(1), h(1), u(1), v(1)), alpha);
            r_2.Q *= switching(i, 1);
            b_2[b] = r_2;
        }

        for (int b = 0; b < block_length; b++) {
            int row = block_row + b;
            int offset = (2 * N) + 1;

            W->Q->appendChunk(b_1[b].Q, b_1[b].start, 0, b_1[b].size, size);

            if (b_2[b].end == N * 2) {
                W->Q->appendChunk(b_2[b].Q, b_2[b].start + offset, 0, b_2[b].size - 1, size);
                W->R(row, 0) = b_2[b].Q(b_2[b].size - 1);
            } else {
                W->Q->appendChunk(b_2[b].Q, b_2[b].start + offset, 0, b_2[b].size, size);
            }
            W->Q->nextRow();
        }
    }

    if (verbose) {
        t_end = std::chrono::system_clock::now();
        time_diff dt = t_end - t_start;
        std::cout << "Time to build matrix: " << dt.count() << " s" << std::endl;
    }

    W->Q->resizeVectors();

    return *W;
}

wfes::wrightfisher::Matrix wfes::wrightfisher::NonAbsorbingToBothAbsorbing(
    const int N, const dvec &s, const dvec &h, const dvec &u, const dvec &v,
    const dmat &switching, const double alpha, const bool verbose, const int block_size, std::string library) {
    time_point t_start, t_end;
    if (verbose)
        t_start = std::chrono::system_clock::now();

    if (s.size() != 2) {
        throw std::invalid_argument(
            "NonAbsorbingToBothAbsorbing: --selection (-s) must have exactly 2 entries "
            "(one per regime: pre-sweep, sweep), got " + std::to_string(s.size()) + ".");
    }
    // forward mutation rate should be above 0
    for (int i = 0; i < 2; i++) {
        if (!(v(i) > 0)) {
            throw std::invalid_argument(
                "NonAbsorbingToBothAbsorbing: --forward-mu (-v) entry " +
                std::to_string(i) + " must be greater than 0, got " +
                fmt_param(v(i)) + ".");
        }
    }

    lvec sizes(2);
    sizes << (2 * N) + 1, (2 * N) - 1;
    int size = sizes.sum();

    Matrix *W = new Matrix(library, size, size, 2);
    std::deque<std::pair<int, int>> index = submatrix_indeces(sizes);

    for (int block_row = 0; block_row < size; block_row += block_size) {
        int block_length = (block_row + block_size) < size ? block_size : size - block_row;
        std::deque<Row> buffer_1(block_length);
        std::deque<Row> buffer_2(block_length);

#pragma omp parallel for
        for (int b = 0; b < block_length; b++) {
            int row = block_row + b;
            int i = index[row].first; // model index
            int im =
                index[row].second +
                i; // current index within model i, correct for non-absorbing starting state - ugly

            Row r_1 = binom_row(2 * N, psi_diploid(im, N, s(0), h(0), u(0), v(0)), alpha);
            r_1.Q *= switching(i, 0);
            buffer_1[b] = r_1;

            Row r_2 = binom_row(2 * N, psi_diploid(im, N, s(1), h(1), u(1), v(1)), alpha);
            r_2.Q *= switching(i, 1);
            buffer_2[b] = r_2;
        }

        for (int b = 0; b < block_length; b++) {
            int row = block_row + b;
            int offset = (2 * N) + 1;

            W->Q->appendChunk(buffer_1[b].Q, buffer_1[b].start, 0, buffer_1[b].size, size);

            if (buffer_2[b].start == 0 && buffer_2[b].end == 2 * N) {
                W->R(row, 0) = buffer_2[b].Q(0);
                W->R(row, 1) = buffer_2[b].Q(buffer_2[b].size - 1);
                W->Q->appendChunk(buffer_2[b].Q, 0 + offset, 1, buffer_2[b].size - 2, size);
            } else if (buffer_2[b].start == 0) {
                W->Q->appendChunk(buffer_2[b].Q, 0 + offset, 1, buffer_2[b].size - 1, size);
                W->R(row, 0) = buffer_2[b].Q(0);
            } else if (buffer_2[b].end == N * 2) {
                W->Q->appendChunk(buffer_2[b].Q, buffer_2[b].start + offset - 1, 0,
                                 buffer_2[b].size - 1, size);
                W->R(row, 1) = buffer_2[b].Q(buffer_2[b].size - 1);
            } else {
                W->Q->appendChunk(buffer_2[b].Q, buffer_2[b].start + offset - 1, 0,
                                 buffer_2[b].size, size);
            }
            W->Q->nextRow();
        }
    }

    if (verbose) {
        t_end = std::chrono::system_clock::now();
        time_diff dt = t_end - t_start;
        std::cout << "Time to build matrix: " << dt.count() << " s" << std::endl;
    }

    W->Q->resizeVectors();

    return *W;
}
