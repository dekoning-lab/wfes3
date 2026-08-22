#include "sparseMatrixPardiso.h"

#include <stdexcept>
#include <string>

#ifdef WFES_CLI
#include <iostream>
#include <fstream>
#include <iomanip>
#endif

// NOT COMPILE-VERIFIED ON macOS: this translation unit is in the build only on
// non-Apple platforms (see the platform branch in wfes-cli/CMakeLists.txt), so
// the assert() -> throw conversion below was made mechanically and checked by
// inspection only. It must be compiled once on Linux/MKL before the next Linux
// release. The conversion matters because wfes-cli defaults to Release
// (-DNDEBUG): the four realloc() checks became NULL-pointer dereferences the
// moment assertions stopped being compiled in.

using namespace wfes::pardiso;
using namespace wfes::utils;

SparseMatrixPardiso::SparseMatrixPardiso() :
    SparseMatrix(0, 0),
    current_row(0), full(false),
    row_index_start(-1), current_size_data(0), current_size_cols(0),
    data(nullptr), cols(nullptr), row_index(nullptr) {}

SparseMatrixPardiso::SparseMatrixPardiso(llong numRows, llong numCols) :
  SparseMatrix(numRows, numCols),
  current_row(0), full(false),
  row_index_start(-1), current_size_data(0), current_size_cols(0),
  data(nullptr), cols(nullptr), row_index(nullptr)
{
  data = (double*)malloc(sizeof(double));
  cols = (llong*) malloc(sizeof(llong));
  row_index = (llong*)malloc((numRows + 1) * sizeof(llong));

  row_index[0] = 0;
}

SparseMatrixPardiso::SparseMatrixPardiso(dmat& eigenDenseMatrix) :
    SparseMatrix(eigenDenseMatrix.rows(), eigenDenseMatrix.cols()),
    current_row(0), full(true),
    row_index_start(-1),
    data(nullptr), cols(nullptr), row_index(nullptr)
{
    llong nnz = (eigenDenseMatrix.array() != 0.0).count();
    num_non_zeros = nnz;
    current_size_cols = nnz;
    current_size_data = nnz;
    data = (double*)malloc(nnz * sizeof(double));
    cols = (llong*)malloc(nnz * sizeof(llong));
    row_index = (llong*)malloc((num_rows + 1) * sizeof(llong));

    llong info = 0;
    llong* j = (llong*)malloc(6 * sizeof(llong));
    j[0] = 0; j[1] = 0; j[2] = 0;
    j[3] = 2; j[4] = num_non_zeros; j[5] = 1;

    llong num_rows_l = (llong)num_rows;
    llong num_cols_l = (llong)num_cols;

    mkl_ddnscsr(j, &(num_rows_l), &num_cols_l, eigenDenseMatrix.data(), &num_cols_l, data, cols, row_index, &info);

    free(j);

    if(info != 0) throw std::runtime_error("SparseMatrix::dense(): Error processing row " + std::to_string(info));

    mkl_sparse_d_create_csr(&handler, SPARSE_INDEX_BASE_ZERO, num_rows, num_cols, row_index, row_index + 1, cols, data);

}

SparseMatrix* SparseMatrixPardiso::LeftPaddedDiagonal(int dim, double x, int padLeft) {
    SparseMatrixPardiso* I = new SparseMatrixPardiso(dim, padLeft + dim);
    I->full = true;
    I->num_non_zeros = dim;

    // could probably use a private constructor here
    double* data_new = (double*)realloc(I->data, I->num_non_zeros* sizeof(double));
    if (!(data_new != NULL))
        throw std::runtime_error(
            "SparseMatrixPardiso::LeftPaddedDiagonal(): out of memory reallocating the "
            "data buffer to " + std::to_string(I->num_non_zeros) + " doubles");
    I->data = data_new;
    current_size_data = num_non_zeros;

    llong* cols_new = (llong*)realloc(I->cols, I->num_cols * sizeof(llong));
    if (!(cols_new != NULL))
        throw std::runtime_error(
            "SparseMatrixPardiso::LeftPaddedDiagonal(): out of memory reallocating the "
            "column-index buffer to " + std::to_string(I->num_cols) + " entries");
    I->cols = cols_new;
    current_size_cols = num_non_zeros;

    for(llong i = 0; i < I->num_non_zeros; i++) {
        I->data[i] = x;
        I->cols[i] = i + padLeft;
        I->row_index[i] = i;
    }
    I->row_index[dim] = I->num_non_zeros;
    mkl_sparse_d_create_csr(&I->handler, SPARSE_INDEX_BASE_ZERO, I->num_rows, I->num_cols, I->row_index, I->row_index + 1, I->cols, I->data);

    return I;
}

SparseMatrixPardiso::~SparseMatrixPardiso() {
    free(data);
    free(cols);
    free(row_index);
    mkl_sparse_destroy(handler);
}

void SparseMatrixPardiso::appendRow(dvec &row, int col_start, int size) {
    appendChunk(row, col_start, col_start, size, row.size());
    nextRow();
}

void SparseMatrixPardiso::appendChunk(dvec &row, int m0, int r0, int size, int rowSize) {

    // Test not full
    if (!(!full))
        throw std::runtime_error(
            "SparseMatrixPardiso::appendChunk(): the matrix already has all "
            + std::to_string(num_rows) + " rows; no further chunk can be appended");
    // Update size
    llong new_size = num_non_zeros + size;

#ifdef WFES_CLI
    if (num_rows <= 10) {
        std::cerr << "DEBUG appendChunk(): current_row=" << current_row 
                  << ", m0=" << m0 << ", size=" << size 
                  << ", num_non_zeros=" << num_non_zeros << std::endl;
    }
#endif

    // Get row index start
    llong old_row_index_start = row_index_start;
    row_index_start = positiveMin(row_index_start, num_non_zeros);
    
#ifdef WFES_CLI
    if (num_rows <= 10) {
        std::cerr << "  positiveMin(" << old_row_index_start << ", " << num_non_zeros 
                  << ") = " << row_index_start << std::endl;
    }
#endif

    // Resize columns vector. Grow-to-fit: a single doubling does NOT guarantee
    // room when one chunk is more than twice the current capacity -- rows of
    // the rectangular Nx->Ny matrices are ~2*Ny wide and overran the buffer,
    // corrupting the heap (SIGSEGV on the first Linux/MKL run, ARC job
    // 46398470; the macOS builds use the Accelerate class and never execute
    // this code). realloc from the constructor's 1-element allocation also
    // replaces a malloc here that leaked it.
    llong *cols_new = NULL;
    if (new_size > current_size_cols) {
        llong want = current_size_cols > 0 ? current_size_cols : (rowSize > 0 ? (llong)rowSize : 1);
        while (want < new_size) want *= 2;
        current_size_cols = want;
        cols_new = (llong*) realloc(cols, current_size_cols * sizeof(llong));
    }

    // Fill columns vector.
    if(cols_new != NULL) {
        cols = cols_new;
    }
    lvec col_idx = closedRange(m0, m0 + size - 1);
    memcpy(&cols[num_non_zeros], col_idx.data(), size * sizeof(llong));


    // Resize data vector; same grow-to-fit. The old line reallocated
    // current_size_data * 2 doubles while RECORDING current_size_data, which
    // hid the undersizing for data while cols still overflowed.
    double* data_new = NULL;
    if (new_size > current_size_data) {
        llong want = current_size_data > 0 ? current_size_data : (rowSize > 0 ? (llong)rowSize : 1);
        while (want < new_size) want *= 2;
        current_size_data = want;
        data_new = (double*) realloc(data, current_size_data * sizeof(double));
    }

    // Fill data vector.
    if(data_new != NULL) {
        data = data_new;
    }
    memcpy(&(data[num_non_zeros]), &(row.data()[r0]), size * sizeof(double));

    num_non_zeros += size;

}

void SparseMatrixPardiso::appendValue(double value, int j) {
    llong new_size = num_non_zeros + 1;

    row_index_start = positiveMin(row_index_start, num_non_zeros);

    // Resize columns vector. From capacity 0 the old doubling stayed at 0
    // forever and every write landed out of bounds.
    llong *cols_new = NULL;
    if (new_size > current_size_cols) {
        llong want = current_size_cols > 0 ? current_size_cols : 1;
        while (want < new_size) want *= 2;
        current_size_cols = want;
        cols_new = (llong*) realloc(cols, current_size_cols * sizeof(llong));
    }

    // Fill columns vector.
    if(cols_new != NULL) {
        cols = cols_new;
    }
    cols[new_size - 1] = j;

    // Resize data vector; same grow-to-fit, and the stray *2 in the realloc
    // size (unrecorded extra capacity) is gone.
    double* data_new = NULL;
    if (new_size > current_size_data) {
        llong want = current_size_data > 0 ? current_size_data : 1;
        while (want < new_size) want *= 2;
        current_size_data = want;
        data_new = (double*) realloc(data, current_size_data * sizeof(double));
    }

    // Fill data vector.
    if(data_new != NULL) {
        data = data_new;
    }
    data[new_size - 1] = value;

    num_non_zeros += 1;
}

void SparseMatrixPardiso::nextRow() {
    if (!(!full))
        throw std::runtime_error(
            "SparseMatrixPardiso::nextRow(): the matrix already has all "
            + std::to_string(num_rows) + " rows; no further row can be started");


#ifdef WFES_CLI
    if (num_rows <= 10) {
        std::cerr << "DEBUG nextRow(): current_row=" << current_row 
                  << ", row_index_start=" << row_index_start 
                  << ", num_non_zeros=" << num_non_zeros << std::endl;
    }
#endif

    row_index[current_row] = row_index_start;
    current_row += 1;
    row_index_start = -1; // special value - will be reset to min of row_index on next row
    if(current_row == num_rows) {
        // Matrix complete
        full = true;
        row_index[num_rows] = num_non_zeros;
        mkl_sparse_d_create_csr(&handler, SPARSE_INDEX_BASE_ZERO, num_rows, num_cols, row_index, row_index + 1, cols, data);
    }
}

void SparseMatrixPardiso::debugPrint() {
    std::cout << "data:    " << std::endl;
    printBuffer(data, (size_t)num_non_zeros);
    std::cout << "cols:   " << std::endl;
    printBuffer(cols, (size_t)num_non_zeros);
    std::cout << "row_index:  " << std::endl;
    printBuffer(row_index, (size_t)(num_rows + 1));
}

bool SparseMatrixPardiso::approxEquals(const SparseMatrix &rhs, double tol, bool verbose) {
    if(num_rows != static_cast<const SparseMatrixPardiso&>(rhs).num_rows) return false;
    if(num_cols != static_cast<const SparseMatrixPardiso&>(rhs).num_cols) return false;
    if(num_non_zeros != static_cast<const SparseMatrixPardiso&>(rhs).num_non_zeros) return false;

    for (llong i = 0; i < num_rows; ++i) {
        for (llong j = row_index[i]; j < row_index[i + 1]; ++j) {
            double diff = fabs(data[j] - static_cast<const SparseMatrixPardiso&>(rhs).data[j]);
            if(diff > tol || (boost::math::isnan)(diff)) {
                if(verbose) {
                    fprintf(stderr, DPF " != " DPF " [%lld] (" DPF ", " DPF ")\n", data[j], static_cast<const SparseMatrixPardiso&>(rhs).data[j], j, diff, tol);
                }
                return false;
            }
        }
    }
    return true;
}

dmat SparseMatrixPardiso::dense() {
    dmat dns(num_rows, num_cols);

    llong info = 0;
    llong* j = (llong*)malloc(6 * sizeof(llong));
    j[0] = 1; j[1] = 0; j[2] = 0;
    j[3] = 2; j[4] = num_non_zeros; j[5] = 1;

    llong num_rows_l = (llong)num_rows;
    llong num_cols_l = (llong)num_cols;

    mkl_ddnscsr(j, &num_rows_l, &num_cols_l, dns.data(), &num_cols_l, data, cols, row_index, &info);

    free(j);

    if(info != 0) throw std::runtime_error("SparseMatrix::dense(): Error processing row " + std::to_string(info));

    return dns;
}

dvec SparseMatrixPardiso::getDiagCopy() {
    if (!(num_rows == num_cols))
        throw std::runtime_error(
            "SparseMatrixPardiso::getDiagCopy(): matrix is not square ("
            + std::to_string(num_rows) + "x" + std::to_string(num_cols) + ")");

    dvec diag(num_rows);
    for (llong i = 0; i < num_rows; ++i) {
        bool diag_found = false;
        for (llong j = row_index[i]; j < row_index[i + 1]; ++j) {
            if (cols[j] == i) {
                diag[i] = data[j];
                diag_found = true;
            }
        }
        if (!diag_found) throw std::runtime_error("Diagonal entry uninitialized " + std::to_string(i));
    }

    return diag;
}

dvec SparseMatrixPardiso::getColCopy(int c) {
    dvec column = dvec::Zero(num_rows);
    for(llong i = 0; i < num_rows; i++) {
        for(llong j = row_index[i]; j < row_index[i + 1]; j++) {
            if (cols[j] == c) {
                column[i] = data[j];
                break;
            }
        }
    }
    return column;
}

dvec SparseMatrixPardiso::getRowCopy(int i) {
    //TODO Implementation (Not used).
    (void)i;
    return dvec();
}

dvec SparseMatrixPardiso::multiply(dvec &x, bool transpose) {
    llong v_size = transpose ? num_cols : num_rows;
    // Was `transpose ? assert(...) : assert(...)`, which is not expressible as a
    // ternary once each branch becomes a statement; the tested condition is
    // unchanged.
    if (x.size() != (transpose ? num_rows : num_cols))
        throw std::runtime_error(
            "SparseMatrixPardiso::multiply(): input vector has " +
            std::to_string(x.size()) + " entries but the " +
            std::string(transpose ? "transposed " : "") + "matrix expects " +
            std::to_string(transpose ? num_rows : num_cols));
    dvec y(v_size);

    struct matrix_descr descr;
    descr.type = SPARSE_MATRIX_TYPE_GENERAL;
    sparse_operation_t op = transpose ? SPARSE_OPERATION_TRANSPOSE : SPARSE_OPERATION_NON_TRANSPOSE;

    mkl_sparse_d_mv(op, 1, handler, descr, x.data(), 0, y.data());

    return y;
}

void SparseMatrixPardiso::multiplyInPlaceRep(dvec &x, int times, bool transpose) {
    // Same rewrite as in multiply() above; the tested condition is unchanged.
    if (x.size() != (transpose ? num_rows : num_cols))
        throw std::runtime_error(
            "SparseMatrixPardiso::multiplyInPlaceRep(): input vector has " +
            std::to_string(x.size()) + " entries but the " +
            std::string(transpose ? "transposed " : "") + "matrix expects " +
            std::to_string(transpose ? num_rows : num_cols));
    dvec workspace(x.size());

    struct matrix_descr descr;
    descr.type = SPARSE_MATRIX_TYPE_GENERAL;
    sparse_operation_t op = transpose ? SPARSE_OPERATION_TRANSPOSE : SPARSE_OPERATION_NON_TRANSPOSE;

    for(llong i = 0; i < times; i++) {
        // it's not safe to write into the same memory - need to swap
        mkl_sparse_d_mv(op, 1, handler, descr, x.data(), 0, workspace.data());
        x = workspace;
    }
}

SparseMatrix* SparseMatrixPardiso::multiply(SparseMatrix &B, bool transpose) {
    sparse_operation_t op = transpose ? SPARSE_OPERATION_TRANSPOSE : SPARSE_OPERATION_NON_TRANSPOSE;

    SparseMatrixPardiso *C = new SparseMatrixPardiso(num_rows, static_cast<SparseMatrixPardiso&>(B).num_cols);

    sparse_status_t info = mkl_sparse_spmm(op, handler, static_cast<SparseMatrixPardiso&>(B).handler, &C->handler);

    info = sparse_status_t::SPARSE_STATUS_ALLOC_FAILED;
    if(info != SPARSE_STATUS_SUCCESS) throw std::runtime_error("Pardiso: Error multiplying matrices. Code " + std::to_string(info));

    return C;
}

void SparseMatrixPardiso::subtractIdentity() {
    for (llong i = 0; i < num_rows; ++i) {
        for (llong j = row_index[i]; j < row_index[i + 1]; ++j) {
            if (i == cols[j]) data[j] = 1.0 - data[j];
            else data[j] = -data[j];
        }
    }
}

double SparseMatrixPardiso::search(int i, int j) {
    if(i >= current_row) return NAN;
    for(llong k = row_index[i]; k < row_index[i + 1]; k++) {
        if (cols[k] == j) {
            return data[k];
        }
    }
    return 0; // was not found
}

void SparseMatrixPardiso::setValue(double x, int i, int j) {
    //TODO Implementation (Not used).
    (void)x;
    (void)i;
    (void)j;
}

void SparseMatrixPardiso::resizeVectors(){
    // Resize columns vector
    llong *cols_new = (llong*) realloc(cols, num_non_zeros * sizeof(llong));
    if (!(cols_new != NULL))
        throw std::runtime_error(
            "SparseMatrixPardiso::resizeVectors(): out of memory reallocating the "
            "column-index buffer to " + std::to_string(num_non_zeros) + " entries");
    cols = cols_new;

    // Resize data vector
    double* data_new = (double*) realloc(data, num_non_zeros * sizeof(double));
    if (!(data_new != NULL))
        throw std::runtime_error(
            "SparseMatrixPardiso::resizeVectors(): out of memory reallocating the "
            "data buffer to " + std::to_string(num_non_zeros) + " doubles");
    data = data_new;
}

void SparseMatrixPardiso::saveMarket(std::string name) {
#ifndef WFES_CLI
    QString outputPath(QStandardPaths::writableLocation(QStandardPaths::DocumentsLocation) + "/Wfes/");
    QDir dir;

    if (!dir.exists(outputPath))
        dir.mkpath(outputPath);

    QFile file(outputPath + QString::fromStdString(name));
    file.open(QIODevice::WriteOnly);

    if(!file.isOpen()) {
        qDebug() << "The file is not open.";
    }

    QTextStream outStream(&file);
    outStream << "%%%%MatrixMarket matrix coordinate real general\n";

    llong num_rows_l = (llong)num_rows;
    llong num_cols_l = (llong)num_cols;
    llong num_non_zeros_l = (llong)num_non_zeros;

    outStream << num_rows_l << "\t" << num_cols_l << "\t" << num_non_zeros_l << "\n";

    for (llong i = 0; i < num_rows; ++i) {
        for (llong j = row_index[i]; j < row_index[i + 1]; ++j) {
            outStream << i+1 << "\t" << cols[j] + 1 << "\t" << data[j] << "\n";
        }
    }
    file.close();
#else
    // CLI version - write directly to current directory
    std::ofstream file(name);
    if (!file.is_open()) {
        throw std::runtime_error(
            "SparseMatrixPardiso::saveMarket(): Cannot open file for writing: " + name);
    }

    file << "%%MatrixMarket matrix coordinate real general\n";
    file << num_rows << "\t" << num_cols << "\t" << num_non_zeros << "\n";

    for (llong i = 0; i < num_rows; ++i) {
        for (llong j = row_index[i]; j < row_index[i + 1]; ++j) {
            file << i+1 << "\t" << cols[j] + 1 << "\t"
                 << std::scientific << std::setprecision(16) << data[j] << "\n";
        }
    }
    file.close();
#endif
}
