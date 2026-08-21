#include "solverViennaCL.h"


using namespace wfes::vienna;

SolverViennaCL::SolverViennaCL(SparseMatrixViennaCL &A, std::string solver, std::string preconditioner) : Solver(A), solver(solver), preconditioner(preconditioner) {

    /*
    //If ViennaCL with OpenMp instead of Open CL, set number of threads.
    #ifdef VIENNACL_WITH_OPENMP
        omp_set_num_threads(wfes::config::Config::n_threads);
    #endif

    // If viennaCL with openCL, you can print the current device with this.
    #ifdef VIENNACL_WITH_OPENCL
        qDebug() << QString::fromStdString(viennacl::ocl::current_device().info());
    #endif
    */
}

void SolverViennaCL::preprocess() {}

dvec SolverViennaCL::solve(dvec &b, bool transpose) {
    dvec res = dvec(b.size());

    if(this->solver.compare("MixedCG") == 0) {
        res = solve_mixed_cg(b, transpose);
    }
    else if(this->solver.compare("CG") == 0) {
        res = solve_cg(b, transpose);
    }
    else if(this->solver.compare("BicGStab") == 0) {
        res = solve_bicgstab(b, transpose);
    }
    else if(this->solver.compare("GMRes") == 0) {
        res = solve_gmres(b, transpose);
    }

    return res;
}

dvec SolverViennaCL::solve_mixed_cg(dvec &b, bool transpose) {
    // Eigen vector to ViennaCL vector.
    viennacl::vector<double> vcl_vec(b.size());
    copy(b, vcl_vec);

    viennacl::vector<double> vcl_res = viennacl::vector<double>(b.size());

    wfes::vienna::SparseMatrixViennaCL mat = static_cast<wfes::vienna::SparseMatrixViennaCL&>(m);

    if(transpose) {
        viennacl::compressed_matrix<double> vcl_transposed(mat.vcl_matrix.size1(), mat.vcl_matrix.size2());
        viennacl::linalg::detail::amg::amg_transpose(mat.vcl_matrix, vcl_transposed);
        // Solve transposed.
        vcl_res = viennacl::linalg::solve(vcl_transposed, vcl_vec, viennacl::linalg::mixed_precision_cg_tag());
    } else {
        // Solve non transposed.
        vcl_res = viennacl::linalg::solve(mat.vcl_matrix, vcl_vec, viennacl::linalg::mixed_precision_cg_tag());
    }

    dvec res = dvec(b.size());
    copy(vcl_res, res);

    return res;
}

dvec SolverViennaCL::solve_cg(dvec &b, bool transpose) {
    // Eigen vector to ViennaCL vector.
    viennacl::vector<double> vcl_vec(b.size());
    copy(b, vcl_vec);

    viennacl::vector<double> vcl_res = viennacl::vector<double>(b.size());

    wfes::vienna::SparseMatrixViennaCL mat = static_cast<wfes::vienna::SparseMatrixViennaCL&>(m);

    if(transpose) {
        viennacl::compressed_matrix<double> vcl_transposed(mat.vcl_matrix.size1(), mat.vcl_matrix.size2());
        viennacl::linalg::detail::amg::amg_transpose(mat.vcl_matrix, vcl_transposed);
        // Solve transposed.
        vcl_res = viennacl::linalg::solve(vcl_transposed, vcl_vec, viennacl::linalg::cg_tag());
    } else {
        // Solve non transposed.
        vcl_res = viennacl::linalg::solve(mat.vcl_matrix, vcl_vec, viennacl::linalg::cg_tag());
    }

    dvec res = dvec(b.size());
    copy(vcl_res, res);

    return res;
}

dvec SolverViennaCL::solve_bicgstab(dvec &b, bool transpose) {
    // configuration of preconditioner:
    viennacl::linalg::ilut_tag ilut_config(100, 1e-2, true);

    // Eigen vector to ViennaCL vector.
    viennacl::vector<double> vcl_vec(b.size());
    copy(b, vcl_vec);

    viennacl::vector<double> vcl_res = viennacl::vector<double>(b.size());
    viennacl::linalg::bicgstab_tag my_bicgstab_tag(0, 20, 20);

    wfes::vienna::SparseMatrixViennaCL mat = static_cast<wfes::vienna::SparseMatrixViennaCL&>(m);

    auto start = std::chrono::high_resolution_clock::now();
    if(transpose) {
        viennacl::compressed_matrix<double> vcl_transposed(mat.vcl_matrix.size1(), mat.vcl_matrix.size2());
        viennacl::linalg::detail::amg::amg_transpose(mat.vcl_matrix, vcl_transposed);

        // create and compute preconditioner:
        viennacl::linalg::ilut_tag ilut_config;
        viennacl::linalg::ilut_precond< viennacl::compressed_matrix<double> > vcl_ilut(vcl_transposed, ilut_config);

        // Solve transposed.
        vcl_res = viennacl::linalg::solve(vcl_transposed, vcl_vec, my_bicgstab_tag, vcl_ilut);
    } else {
        // create and compute preconditioner:
        viennacl::linalg::ilut_tag ilut_config;
        viennacl::linalg::ilut_precond< viennacl::compressed_matrix<double> > vcl_ilut(mat.vcl_matrix, ilut_config);

        // Solve non transposed.
        vcl_res = viennacl::linalg::solve(mat.vcl_matrix, vcl_vec, my_bicgstab_tag, vcl_ilut);
    }
    auto finish = std::chrono::high_resolution_clock::now();
    std::chrono::duration<double> elapsed = finish - start;

    dvec res = dvec(b.size());
    copy(vcl_res, res);

    return res;
}

dvec SolverViennaCL::solve_gmres(dvec &b, bool transpose) {
    // Eigen vector to ViennaCL vector.
    viennacl::vector<double> vcl_vec(b.size());
    copy(b, vcl_vec);

    viennacl::vector<double> vcl_res = viennacl::vector<double>(b.size());
    viennacl::linalg::gmres_tag my_gmres_tag(1e-5, 800, 500);

    wfes::vienna::SparseMatrixViennaCL mat = static_cast<wfes::vienna::SparseMatrixViennaCL&>(m);

    if(transpose) {
        viennacl::compressed_matrix<double> vcl_transposed(mat.vcl_matrix.size1(), mat.vcl_matrix.size2());
        viennacl::linalg::detail::amg::amg_transpose(mat.vcl_matrix, vcl_transposed);

        // Solve transposed.
        vcl_res = viennacl::linalg::solve(vcl_transposed, vcl_vec, my_gmres_tag);
    } else {
        // Solve non transposed.
        vcl_res = viennacl::linalg::solve(mat.vcl_matrix, vcl_vec, my_gmres_tag);
    }
    dvec res = dvec(b.size());
    copy(vcl_res, res);

    return res;
}

dmat SolverViennaCL::solve_multiple(dmat &b, bool transpose) {
    //TODO Implement this function.
    return dmat();
}
