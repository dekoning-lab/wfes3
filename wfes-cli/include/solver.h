#ifndef WFES_SOLVER_H
#define WFES_SOLVER_H

#include "types.h"
#include "sparse_matrix.h"
#include "model/solver/solver.h"
#include "model/solver/solverFactory.h"

// This header serves as a re-export of the solver components from the core library.
// We directly use the original implementation without additional abstraction layers.

// MKL Pardiso constants for use in the CLI tools
#define MKL_PARDISO_MATRIX_TYPE_REAL_UNSYMMETRIC 11
#define MKL_PARDISO_MSG_QUIET 0
#define MKL_PARDISO_MSG_VERBOSE 1

#endif // WFES_SOLVER_H