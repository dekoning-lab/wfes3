#include "types.h"
#include "output_formatter.hpp"
#include <cmath>
#include <iostream>
#include <iomanip>
#include <fstream>
#include <stdexcept>
#include <limits>
#include <sstream>

namespace wfes {
namespace cli {

// See the contract in output_formatter.hpp.
double OutputFormatter::require_finite(double value, const char* field) {
    if (std::isfinite(value)) return value;
    std::ostringstream os;
    os << "refusing to emit a non-finite value: " << field << " = "
       << (std::isnan(value) ? "nan" : (value > 0 ? "inf" : "-inf"))
       << ". Neither is a JSON number, and a CSV reader would coerce it into an "
          "ordinary-looking finite value, so nothing usable can be printed for "
          "this field. The result is not defined for these parameters";
    throw std::runtime_error(os.str());
}

void OutputFormatter::require_finite_all(const dvec& values, const char* field) {
    for (llong i = 0; i < values.size(); i++) {
        if (std::isfinite(values(i))) continue;
        std::string named = std::string(field) + "[" + std::to_string(i) + "]";
        require_finite(values(i), named.c_str());
    }
}

namespace {

// Every print_* below validates the whole result set before writing the first
// character, so a refusal cannot leave a truncated JSON object on stdout.
// Applied to the JSON and CSV branches only: the plain-text branch is read by a
// person, who is not misled by the word "nan" the way a parser is.
bool structured(const CommandLineOptions& options) {
    return options.json_output || options.csv_output;
}

// Same convention as require_finite/require_finite_all above: validate the
// whole payload before writing the first character, so a refusal can never
// leave a partial file (or a partial "stdout" pseudo-file -- see the special
// case below) behind. These two overloads exist separately from
// require_finite_all because the message has to name a FILE, not a JSON/CSV
// field: write_vector_to_file / write_matrix_to_file serve the raw
// --output-Q/R/N/B/I/E/V family, which are plain numeric dumps with no field
// names of their own and are read back by both external tools and this
// project's own GUI, which stores several of them with a .csv extension. A
// bare "nan" token there is not a smaller failure than refusing to write --
// it is a value a downstream reader will silently accept as text and then
// parse as an ordinary number.
void require_finite_for_file(const dvec& vec, const std::string& filename) {
    for (llong i = 0; i < vec.size(); i++) {
        if (std::isfinite(vec(i))) continue;
        std::ostringstream os;
        os << "refusing to write " << filename << ": entry [" << i << "] = "
           << (std::isnan(vec(i)) ? "nan" : (vec(i) > 0 ? "inf" : "-inf"))
           << " is not finite. A file reader would silently accept that text "
              "token as an ordinary value, so nothing was written. The result "
              "is not defined for these parameters";
        throw std::runtime_error(os.str());
    }
}

void require_finite_for_file(const dmat& mat, const std::string& filename) {
    for (llong i = 0; i < mat.rows(); i++) {
        for (llong j = 0; j < mat.cols(); j++) {
            if (std::isfinite(mat(i, j))) continue;
            std::ostringstream os;
            os << "refusing to write " << filename << ": entry [" << i << ","
               << j << "] = "
               << (std::isnan(mat(i, j)) ? "nan" : (mat(i, j) > 0 ? "inf" : "-inf"))
               << " is not finite. A file reader would silently accept that "
                  "text token as an ordinary value, so nothing was written. "
                  "The result is not defined for these parameters";
            throw std::runtime_error(os.str());
        }
    }
}

}  // namespace

namespace {

// Escape a string for use as a JSON string value.
//
// Only options.initial_distribution_path goes through this, in
// print_switching_absorption_results below, but a path may legitimately
// contain a backslash or a quote, and one of those in the parameters block
// would make the whole document unparseable. Duplicated (byte-for-byte)
// from the same-named, same-purpose local helper already in
// wfes_switching_main.cpp / wfes_sequential_main.cpp / wfes_single_main.cpp,
// rather than shared, matching this codebase's existing convention for this
// exact helper.
std::string json_escape(const std::string &raw) {
    std::string out;
    out.reserve(raw.size());
    for (char c : raw) {
        if (c == '"' || c == '\\') {
            out.push_back('\\');
            out.push_back(c);
        } else if (static_cast<unsigned char>(c) < 0x20) {
            std::ostringstream os;
            os << "\\u" << std::hex << std::setw(4) << std::setfill('0')
               << static_cast<int>(static_cast<unsigned char>(c));
            out += os.str();
        } else {
            out.push_back(c);
        }
    }
    return out;
}

}  // namespace

void OutputFormatter::write_vector_to_file(const dvec& vec, const std::string& filename) {
    // Refuse before writing the first character, whether the destination is
    // a real file or the "stdout" pseudo-filename below -- see the contract
    // comment on require_finite_for_file above.
    require_finite_for_file(vec, filename);

    // Handle stdout as a special case
    if (filename == "stdout") {
        for (llong i = 0; i < vec.size(); i++) {
            std::cout << std::setprecision(std::numeric_limits<double>::max_digits10) << vec(i);
            if (i < vec.size() - 1) {
                std::cout << "\n";
            }
        }
        return;
    }
    
    std::ofstream file(filename);
    if (!file.is_open()) {
        throw std::runtime_error("Unable to open file: " + filename);
    }
    
    for (llong i = 0; i < vec.size(); i++) {
        file << std::setprecision(std::numeric_limits<double>::max_digits10) << vec(i);
        if (i < vec.size() - 1) {
            file << "\n";
        }
    }
    
    file.close();
}

void OutputFormatter::write_matrix_to_file(const dmat& mat, const std::string& filename) {
    // Refuse before writing the first character, whether the destination is
    // a real file or the "stdout" pseudo-filename below -- see the contract
    // comment on require_finite_for_file above.
    require_finite_for_file(mat, filename);

    // Handle stdout as a special case
    if (filename == "stdout") {
        for (llong i = 0; i < mat.rows(); i++) {
            for (llong j = 0; j < mat.cols(); j++) {
                std::cout << std::setprecision(std::numeric_limits<double>::max_digits10) << mat(i, j);
                if (j < mat.cols() - 1) {
                    std::cout << ",";
                }
            }
            std::cout << "\n";
        }
        return;
    }
    
    std::ofstream file(filename);
    if (!file.is_open()) {
        throw std::runtime_error("Unable to open file: " + filename);
    }
    
    for (llong i = 0; i < mat.rows(); i++) {
        for (llong j = 0; j < mat.cols(); j++) {
            file << std::setprecision(std::numeric_limits<double>::max_digits10) << mat(i, j);
            if (j < mat.cols() - 1) {
                file << ",";
            }
        }
        if (i < mat.rows() - 1) {
            file << "\n";
        }
    }
    
    file.close();
}

void OutputFormatter::print_fixation_results(const CommandLineOptions& options, 
                                             double T_fix, double T_std, double rate) {
    if (structured(options)) {
        require_finite(T_fix, "T_fix");
        require_finite(T_std, "T_std");
        require_finite(rate, "rate");
    }
    if (options.json_output) {
        std::cout << "{" << std::endl;
        std::cout << "  \"model\": \"fixation\"," << std::endl;
        std::cout << "  \"results\": {" << std::endl;
        std::cout << "    \"T_fix\": " << T_fix << "," << std::endl;
        std::cout << "    \"T_std\": " << T_std << "," << std::endl;
        std::cout << "    \"rate\": " << rate << std::endl;
        std::cout << "  }" << std::endl;
        std::cout << "}" << std::endl;
    } else if (options.csv_output) {
        std::cout << "T_fix,T_std,rate" << std::endl;
        std::cout << T_fix << "," << T_std << "," << rate << std::endl;
    } else {
        std::cout << "T_fix = " << T_fix << std::endl;
        std::cout << "T_std = " << T_std << std::endl;
        std::cout << "Rate = " << rate << std::endl;
    }
}

void OutputFormatter::print_absorption_results(const CommandLineOptions& options,
                                              double P_ext, double P_fix, 
                                              double T_abs, double T_abs_std,
                                              double T_ext, double T_ext_std, double N_ext,
                                              double T_fix, double T_fix_std) {
    if (structured(options)) {
        require_finite(P_ext, "P_ext");
        require_finite(P_fix, "P_fix");
        require_finite(T_abs, "T_abs");
        require_finite(T_abs_std, "T_abs_std");
        require_finite(T_ext, "T_ext");
        require_finite(T_ext_std, "T_ext_std");
        require_finite(N_ext, "N_ext");
        require_finite(T_fix, "T_fix");
        require_finite(T_fix_std, "T_fix_std");
    }
    if (options.json_output) {
        std::cout << "{" << std::endl;
        std::cout << "  \"model\": \"absorption\"," << std::endl;
        std::cout << "  \"results\": {" << std::endl;
        std::cout << "    \"P_ext\": " << P_ext << "," << std::endl;
        std::cout << "    \"P_fix\": " << P_fix << "," << std::endl;
        std::cout << "    \"T_abs\": " << T_abs << "," << std::endl;
        std::cout << "    \"T_abs_std\": " << T_abs_std << "," << std::endl;
        std::cout << "    \"T_ext\": " << T_ext << "," << std::endl;
        std::cout << "    \"T_ext_std\": " << T_ext_std << "," << std::endl;
        std::cout << "    \"N_ext\": " << N_ext << "," << std::endl;
        std::cout << "    \"T_fix\": " << T_fix << "," << std::endl;
        std::cout << "    \"T_fix_std\": " << T_fix_std << std::endl;
        std::cout << "  }" << std::endl;
        std::cout << "}" << std::endl;
    } else if (options.csv_output) {
        std::cout << "P_ext,P_fix,T_abs,T_abs_std,T_ext,T_ext_std,N_ext,T_fix,T_fix_std" << std::endl;
        std::cout << P_ext << "," << P_fix << "," << T_abs << "," << T_abs_std << ","
                  << T_ext << "," << T_ext_std << "," << N_ext << "," 
                  << T_fix << "," << T_fix_std << std::endl;
    } else {
        std::cout << "P_ext = " << P_ext << std::endl;
        std::cout << "P_fix = " << P_fix << std::endl;
        std::cout << "T_abs = " << T_abs << std::endl;
        std::cout << "T_abs_std = " << T_abs_std << std::endl;
        std::cout << "T_ext = " << T_ext << std::endl;
        std::cout << "T_ext_std = " << T_ext_std << std::endl;
        std::cout << "N_ext = " << N_ext << std::endl;
        std::cout << "T_fix = " << T_fix << std::endl;
        std::cout << "T_fix_std = " << T_fix_std << std::endl;
    }
}

void OutputFormatter::print_equilibrium_results(const CommandLineOptions& options, double e_freq) {
    if (structured(options)) require_finite(e_freq, "E_freq");
    if (options.json_output) {
        std::cout << "{" << std::endl;
        std::cout << "  \"model\": \"equilibrium\"," << std::endl;
        std::cout << "  \"results\": {" << std::endl;
        std::cout << "    \"E_freq\": " << e_freq << std::endl;
        std::cout << "  }" << std::endl;
        std::cout << "}" << std::endl;
    } else if (options.csv_output) {
        std::cout << "E[freq]" << std::endl;
        std::cout << e_freq << std::endl;
    } else {
        std::cout << "E[freq] = " << e_freq << std::endl;
    }
}

void OutputFormatter::print_equilibrium_results_with_distribution(
    const CommandLineOptions& options, double e_freq, const dvec& distribution) {
    if (structured(options)) {
        require_finite(e_freq, "E_freq");
        require_finite_all(distribution, "distribution");
    }
    if (options.json_output) {
        std::cout << "{" << std::endl;
        std::cout << "  \"model\": \"equilibrium\"," << std::endl;
        std::cout << "  \"results\": {" << std::endl;
        std::cout << "    \"E_freq\": " << e_freq << "," << std::endl;
        std::cout << "    \"distribution\": [" << std::endl;
        for (llong i = 0; i < distribution.size(); i++) {
            std::cout << "      {\"copies\": " << i << ", \"probability\": " << distribution[i] << "}";
            if (i < distribution.size() - 1) std::cout << ",";
            std::cout << std::endl;
        }
        std::cout << "    ]" << std::endl;
        std::cout << "  }" << std::endl;
        std::cout << "}" << std::endl;
    } else if (options.csv_output) {
        std::cout << "copies,probability" << std::endl;
        for (llong i = 0; i < distribution.size(); i++) {
            std::cout << i << "," << distribution[i] << std::endl;
        }
    } else {
        std::cout << "E[freq] = " << e_freq << std::endl;
        // In verbose mode, could print distribution
    }
}

void OutputFormatter::print_establishment_results(
    const CommandLineOptions& options,
    double est_freq, double P_est,
    double T_seg, double T_seg_std,
    double T_seg_ext, double T_seg_ext_std,
    double T_seg_fix, double T_seg_fix_std,
    double T_est, double T_est_std) {
    if (structured(options)) {
        require_finite(est_freq, "est_freq");
        require_finite(P_est, "P_est");
        require_finite(T_seg, "T_seg");
        require_finite(T_seg_std, "T_seg_std");
        require_finite(T_seg_ext, "T_seg_ext");
        require_finite(T_seg_ext_std, "T_seg_ext_std");
        require_finite(T_seg_fix, "T_seg_fix");
        require_finite(T_seg_fix_std, "T_seg_fix_std");
        require_finite(T_est, "T_est");
        require_finite(T_est_std, "T_est_std");
    }
    if (options.json_output) {
        std::cout << "{" << std::endl;
        std::cout << "  \"model\": \"establishment\"," << std::endl;
        std::cout << "  \"results\": {" << std::endl;
        std::cout << "    \"est_freq\": " << est_freq << "," << std::endl;
        std::cout << "    \"P_est\": " << P_est << "," << std::endl;
        std::cout << "    \"T_seg\": " << T_seg << "," << std::endl;
        std::cout << "    \"T_seg_std\": " << T_seg_std << "," << std::endl;
        std::cout << "    \"T_seg_ext\": " << T_seg_ext << "," << std::endl;
        std::cout << "    \"T_seg_ext_std\": " << T_seg_ext_std << "," << std::endl;
        std::cout << "    \"T_seg_fix\": " << T_seg_fix << "," << std::endl;
        std::cout << "    \"T_seg_fix_std\": " << T_seg_fix_std << "," << std::endl;
        std::cout << "    \"T_est\": " << T_est << "," << std::endl;
        std::cout << "    \"T_est_std\": " << T_est_std << std::endl;
        std::cout << "  }" << std::endl;
        std::cout << "}" << std::endl;
    } else if (options.csv_output) {
        std::cout << "est_freq,P_est,T_seg,T_seg_std,T_seg_ext,T_seg_ext_std,T_seg_fix,T_seg_fix_std,T_est,T_est_std" << std::endl;
        std::cout << est_freq << "," << P_est << "," << T_seg << "," << T_seg_std << ","
                  << T_seg_ext << "," << T_seg_ext_std << "," << T_seg_fix << "," << T_seg_fix_std << ","
                  << T_est << "," << T_est_std << std::endl;
    } else {
        std::cout << "Est. freq. = " << est_freq << std::endl;
        std::cout << "P_est = " << P_est << std::endl;
        std::cout << "T_seg = " << T_seg << std::endl;
        std::cout << "T_seg_std = " << T_seg_std << std::endl;
        std::cout << "T_seg_ext = " << T_seg_ext << std::endl;
        std::cout << "T_seg_ext_std = " << T_seg_ext_std << std::endl;
        std::cout << "T_seg_fix = " << T_seg_fix << std::endl;
        std::cout << "T_seg_fix_std = " << T_seg_fix_std << std::endl;
        std::cout << "T_est = " << T_est << std::endl;
        std::cout << "T_est_std = " << T_est_std << std::endl;
    }
}

void OutputFormatter::print_allele_age_results(const CommandLineOptions& options,
                                              double age, double age_std,
                                              const std::vector<double>& raw_moments) {
    if (structured(options)) {
        require_finite(age, "E_T");
        require_finite(age_std, "Std_T");
        for (size_t k = 0; k < raw_moments.size(); k++) {
            require_finite(raw_moments[k],
                           ("age_raw_moments[" + std::to_string(k) + "]").c_str());
        }
    }
    // Central statistics from the raw moments, when higher moments were asked
    // for. Skewness needs K >= 3, excess kurtosis K >= 4.
    const size_t K = raw_moments.size();
    double skew = 0, kurt_ex = 0, var = 0;
    bool have_skew = false, have_kurt = false;
    if (K >= 3) {
        const double m1 = raw_moments[0], m2 = raw_moments[1], m3 = raw_moments[2];
        var = m2 - m1 * m1;
        const double sd = std::sqrt(var);
        skew = (m3 - 3 * m1 * m2 + 2 * m1 * m1 * m1) / (sd * sd * sd);
        have_skew = var > 0;
        if (K >= 4) {
            const double m4 = raw_moments[3];
            kurt_ex = (m4 - 4 * m1 * m3 + 6 * m1 * m1 * m2 - 3 * m1 * m1 * m1 * m1)
                      / (var * var) - 3.0;
            have_kurt = var > 0;
        }
    }
    if (options.json_output) {
        std::cout << "{" << std::endl;
        std::cout << "  \"model\": \"allele_age\"," << std::endl;
        std::cout << "  \"results\": {" << std::endl;
        std::cout << "    \"E_T\": " << age << "," << std::endl;
        std::cout << "    \"Std_T\": " << age_std;
        if (K > 0) {
            std::cout << "," << std::endl << "    \"age_raw_moments\": [";
            for (size_t k = 0; k < K; k++) {
                if (k) std::cout << ", ";
                std::cout << raw_moments[k];
            }
            std::cout << "]";
            if (have_skew) std::cout << "," << std::endl << "    \"age_skewness\": " << skew;
            if (have_kurt) std::cout << "," << std::endl << "    \"age_kurtosis_excess\": " << kurt_ex;
        }
        std::cout << std::endl;
        std::cout << "  }" << std::endl;
        std::cout << "}" << std::endl;
    } else if (options.csv_output) {
        std::cout << "E[T],Std[T]" << std::endl;
        std::cout << age << "," << age_std << std::endl;
        if (K > 0) {
            std::cout << "k,E[T^k]" << std::endl;
            for (size_t k = 0; k < K; k++) std::cout << (k + 1) << "," << raw_moments[k] << std::endl;
        }
    } else {
        std::cout << "E[T] = " << age << std::endl;
        std::cout << "Std[T] = " << age_std << std::endl;
        for (size_t k = 0; k < K; k++) {
            std::cout << "E[T^" << (k + 1) << "] = " << raw_moments[k] << std::endl;
        }
        if (have_skew) std::cout << "Skewness = " << skew << std::endl;
        if (have_kurt) std::cout << "Excess kurtosis = " << kurt_ex << std::endl;
    }
}

void OutputFormatter::print_fundamental_results(const CommandLineOptions& options,
                                               const dvec& sojourn, double T_abs) {
    // The sojourn vector is alpha^T N: expected generations spent in each
    // transient state before absorption, for the starting distribution given.
    // Its entries run over allele counts 1..2N-1, and its sum is the expected
    // time to absorption.
    // An empty vector means no starting distribution was usable. The matrix is
    // the mode's actual output and is reported either way.
    const bool has_start = sojourn.size() > 0;
    if (structured(options) && has_start) {
        require_finite(T_abs, "T_abs");
        require_finite_all(sojourn, "sojourn_times");
    }
    if (options.json_output) {
        std::cout << "{" << std::endl;
        std::cout << "  \"model\": \"fundamental\"," << std::endl;
        std::cout << "  \"results\": {" << std::endl;
        std::cout << "    \"message\": \"Fundamental matrix calculation completed\"";
        if (has_start) {
            std::cout << "," << std::endl;
            std::cout << "    \"T_abs\": " << std::setprecision(17) << T_abs << "," << std::endl;
            std::cout << "    \"sojourn_times\": [";
            for (llong i = 0; i < sojourn.size(); i++) {
                if (i) std::cout << ", ";
                std::cout << std::setprecision(17) << sojourn(i);
            }
            std::cout << "]";
        }
        std::cout << std::endl;
        std::cout << "  }" << std::endl;
        std::cout << "}" << std::endl;
    } else if (options.csv_output) {
        if (has_start) {
            std::cout << "count,sojourn_time" << std::endl;
            for (llong i = 0; i < sojourn.size(); i++) {
                std::cout << (i + 1) << "," << std::setprecision(17) << sojourn(i) << std::endl;
            }
        }
    } else {
        std::cout << "Fundamental matrix calculation completed." << std::endl;
        std::cout << "Results saved to output files (if specified)." << std::endl;
        if (has_start) {
            std::cout << "Expected time to absorption from the starting distribution: "
                      << T_abs << std::endl;
        }
    }
}

void OutputFormatter::print_non_absorbing_results(const CommandLineOptions& options) {
    if (options.json_output) {
        std::cout << "{" << std::endl;
        std::cout << "  \"model\": \"non_absorbing\"," << std::endl;
        std::cout << "  \"results\": {" << std::endl;
        std::cout << "    \"message\": \"Non-absorbing matrix construction completed\"" << std::endl;
        std::cout << "  }" << std::endl;
        std::cout << "}" << std::endl;
    } else if (!options.csv_output) {
        std::cout << "Non-absorbing matrix construction completed." << std::endl;
        std::cout << "Matrix saved to output file (if specified)." << std::endl;
    }
}

void OutputFormatter::print_switching_absorption_results(
    const CommandLineOptions& options,
    llong n_models,
    const dvec& population_sizes,
    const dvec& s,
    const dvec& h,
    const dvec& u,
    const dvec& v,
    const dvec& p,
    bool p_used,
    double P_ext, double P_fix,
    double T_ext, double T_fix,
    const dvec& P_cond_ext,
    const dvec& P_cond_fix,
    const dvec& T_uncond,
    const dvec& T_cond_ext,
    const dvec& T_cond_fix) {

    if (structured(options)) {
        require_finite(P_ext, "P_ext");
        require_finite(P_fix, "P_fix");
        require_finite(T_ext, "T_ext");
        require_finite(T_fix, "T_fix");
        require_finite_all(P_cond_ext, "P_cond_ext");
        require_finite_all(P_cond_fix, "P_cond_fix");
        require_finite_all(T_uncond, "T_uncond");
        require_finite_all(T_cond_ext, "T_cond_ext");
        require_finite_all(T_cond_fix, "T_cond_fix");
        require_finite(options.alpha, "alpha");
    }
    if (options.json_output) {
        std::cout << "{" << std::endl;
        std::cout << "  \"model\": \"switching-absorption\"," << std::endl;
        std::cout << "  \"parameters\": {" << std::endl;
        std::cout << "    \"n_models\": " << n_models << "," << std::endl;
        std::cout << "    \"population_sizes\": [";
        for (llong i = 0; i < n_models; i++) {
            std::cout << population_sizes(i);
            if (i < n_models - 1) std::cout << ", ";
        }
        std::cout << "]," << std::endl;
        std::cout << "    \"selection_coefficients\": [";
        for (llong i = 0; i < n_models; i++) {
            std::cout << s(i);
            if (i < n_models - 1) std::cout << ", ";
        }
        std::cout << "]," << std::endl;
        std::cout << "    \"dominance_coefficients\": [";
        for (llong i = 0; i < n_models; i++) {
            std::cout << h(i);
            if (i < n_models - 1) std::cout << ", ";
        }
        std::cout << "]," << std::endl;
        std::cout << "    \"backward_mutation_rates\": [";
        for (llong i = 0; i < n_models; i++) {
            std::cout << u(i);
            if (i < n_models - 1) std::cout << ", ";
        }
        std::cout << "]," << std::endl;
        std::cout << "    \"forward_mutation_rates\": [";
        for (llong i = 0; i < n_models; i++) {
            std::cout << v(i);
            if (i < n_models - 1) std::cout << ", ";
        }
        std::cout << "]," << std::endl;
        // --initial replaces the per-model starting states -- and their -p
        // weights -- with one supplied distribution (see the ABSORPTION
        // dispatch branch in wfes_switching_main.cpp), exactly as it does
        // for the FIXATION branch's own JSON output; p_used mirrors that
        // branch's options.initial_distribution_path.empty() condition, so
        // exactly one of the two fields below appears. A dead, never
        // validated -p (p_used == false) must never be published under
        // starting_probabilities as though it were the probability the run
        // actually used.
        if (p_used) {
            std::cout << "    \"starting_probabilities\": [";
            for (llong i = 0; i < n_models; i++) {
                std::cout << p(i);
                if (i < n_models - 1) std::cout << ", ";
            }
            std::cout << "]," << std::endl;
        } else {
            std::cout << "    \"initial_distribution\": \""
                      << json_escape(options.initial_distribution_path)
                      << "\"," << std::endl;
        }
        std::cout << "    \"alpha\": " << options.alpha << std::endl;
        std::cout << "  }," << std::endl;
        std::cout << "  \"results\": {" << std::endl;
        std::cout << "    \"P_ext\": " << P_ext << "," << std::endl;
        std::cout << "    \"P_fix\": " << P_fix << "," << std::endl;
        std::cout << "    \"T_ext\": " << T_ext << "," << std::endl;
        std::cout << "    \"T_fix\": " << T_fix << "," << std::endl;
        std::cout << "    \"P_cond_ext\": [";
        for (llong i = 0; i < n_models; i++) {
            std::cout << P_cond_ext(i);
            if (i < n_models - 1) std::cout << ", ";
        }
        std::cout << "]," << std::endl;
        std::cout << "    \"P_cond_fix\": [";
        for (llong i = 0; i < n_models; i++) {
            std::cout << P_cond_fix(i);
            if (i < n_models - 1) std::cout << ", ";
        }
        std::cout << "]," << std::endl;
        std::cout << "    \"T_uncond\": [";
        for (llong i = 0; i < n_models; i++) {
            std::cout << T_uncond(i);
            if (i < n_models - 1) std::cout << ", ";
        }
        std::cout << "]," << std::endl;
        std::cout << "    \"T_cond_ext\": [";
        for (llong i = 0; i < n_models; i++) {
            std::cout << T_cond_ext(i);
            if (i < n_models - 1) std::cout << ", ";
        }
        std::cout << "]," << std::endl;
        std::cout << "    \"T_cond_fix\": [";
        for (llong i = 0; i < n_models; i++) {
            std::cout << T_cond_fix(i);
            if (i < n_models - 1) std::cout << ", ";
        }
        std::cout << "]" << std::endl;
        std::cout << "  }" << std::endl;
        std::cout << "}" << std::endl;
    } else if (options.csv_output) {
        // Print headers
        for (llong i = 0; i < n_models; i++) {
            std::cout << "N" << i;
            if (i < n_models - 1) std::cout << ",";
        }
        std::cout << ",";
        for (llong i = 0; i < n_models; i++) {
            std::cout << "s" << i;
            if (i < n_models - 1) std::cout << ",";
        }
        std::cout << ",";
        for (llong i = 0; i < n_models; i++) {
            std::cout << "h" << i;
            if (i < n_models - 1) std::cout << ",";
        }
        std::cout << ",";
        for (llong i = 0; i < n_models; i++) {
            std::cout << "u" << i;
            if (i < n_models - 1) std::cout << ",";
        }
        std::cout << ",";
        for (llong i = 0; i < n_models; i++) {
            std::cout << "v" << i;
            if (i < n_models - 1) std::cout << ",";
        }
        std::cout << ",";
        for (llong i = 0; i < n_models; i++) {
            std::cout << "p" << i;
            if (i < n_models - 1) std::cout << ",";
        }
        std::cout << ",a,P_ext,P_fix,T_ext,T_fix";
        for (llong i = 0; i < n_models; i++) {
            std::cout << ",P_cond_ext" << i;
        }
        for (llong i = 0; i < n_models; i++) {
            std::cout << ",P_cond_fix" << i;
        }
        for (llong i = 0; i < n_models; i++) {
            std::cout << ",T_uncond" << i;
        }
        for (llong i = 0; i < n_models; i++) {
            std::cout << ",T_cond_ext" << i;
        }
        for (llong i = 0; i < n_models; i++) {
            std::cout << ",T_cond_fix" << i;
        }
        std::cout << std::endl;
        
        // Print values
        for (llong i = 0; i < n_models; i++) {
            std::cout << population_sizes(i);
            if (i < n_models - 1) std::cout << ",";
        }
        std::cout << ",";
        for (llong i = 0; i < n_models; i++) {
            std::cout << s(i);
            if (i < n_models - 1) std::cout << ",";
        }
        std::cout << ",";
        for (llong i = 0; i < n_models; i++) {
            std::cout << h(i);
            if (i < n_models - 1) std::cout << ",";
        }
        std::cout << ",";
        for (llong i = 0; i < n_models; i++) {
            std::cout << u(i);
            if (i < n_models - 1) std::cout << ",";
        }
        std::cout << ",";
        for (llong i = 0; i < n_models; i++) {
            std::cout << v(i);
            if (i < n_models - 1) std::cout << ",";
        }
        std::cout << ",";
        // Same p_used gate as the JSON branch above, and the same
        // convention CsvRow::add_per_model_or_empty already establishes for
        // the FIXATION branch's CSV: the column stays (same header, same
        // field count on every run), but a run that never read p leaves the
        // field empty rather than printing whatever raw, unvalidated value
        // -p happened to hold.
        for (llong i = 0; i < n_models; i++) {
            if (p_used) std::cout << p(i);
            if (i < n_models - 1) std::cout << ",";
        }
        std::cout << "," << options.alpha << ","
                  << P_ext << "," << P_fix << ","
                  << T_ext << "," << T_fix;
        for (llong i = 0; i < n_models; i++) {
            std::cout << "," << P_cond_ext(i);
        }
        for (llong i = 0; i < n_models; i++) {
            std::cout << "," << P_cond_fix(i);
        }
        for (llong i = 0; i < n_models; i++) {
            std::cout << "," << T_uncond(i);
        }
        for (llong i = 0; i < n_models; i++) {
            std::cout << "," << T_cond_ext(i);
        }
        for (llong i = 0; i < n_models; i++) {
            std::cout << "," << T_cond_fix(i);
        }
        std::cout << std::endl;
    } else {
        std::cout << "Absorption mode results:\n";
        std::cout << "P_ext = " << std::setprecision(10) << P_ext << std::endl;
        std::cout << "P_fix = " << std::setprecision(10) << P_fix << std::endl;
        std::cout << "T_ext = " << std::setprecision(10) << T_ext << std::endl;
        std::cout << "T_fix = " << std::setprecision(10) << T_fix << std::endl;
        std::cout << "P_cond_ext = [" << P_cond_ext.transpose() << "]" << std::endl;
        std::cout << "P_cond_fix = [" << P_cond_fix.transpose() << "]" << std::endl;
        std::cout << "T_uncond = [" << T_uncond.transpose() << "]" << std::endl;
        std::cout << "T_cond_ext = [" << T_cond_ext.transpose() << "]" << std::endl;
        std::cout << "T_cond_fix = [" << T_cond_fix.transpose() << "]" << std::endl;
    }
}

void OutputFormatter::print_wfafs_stochastic_results(
    const CommandLineOptions& options,
    const dvec& distribution,
    llong n_models) {

    if (structured(options)) {
        require_finite_all(distribution, "distribution");
        require_finite(options.alpha, "alpha");
    }
    if (options.json_output) {
        std::cout << "{" << std::endl;
        std::cout << "  \"model\": \"wfafs-stochastic\"," << std::endl;
        std::cout << "  \"parameters\": {" << std::endl;
        std::cout << "    \"n_models\": " << n_models << "," << std::endl;
        std::cout << "    \"alpha\": " << options.alpha << std::endl;
        std::cout << "  }," << std::endl;
        std::cout << "  \"results\": {" << std::endl;
        std::cout << "    \"distribution\": [";
        for (llong i = 0; i < distribution.size(); i++) {
            std::cout << std::endl << "      {\"allele_count\": " << i 
                      << ", \"probability\": " << distribution(i) << "}";
            if (i < distribution.size() - 1) std::cout << ",";
        }
        std::cout << std::endl << "    ]" << std::endl;
        std::cout << "  }" << std::endl;
        std::cout << "}" << std::endl;
    } else if (options.csv_output) {
        std::cout << "allele_count,probability" << std::endl;
        for (llong i = 0; i < distribution.size(); i++) {
            std::cout << i << "," << distribution(i) << std::endl;
        }
    } else {
        // Default tab-separated output (as in original)
        for (llong i = 0; i < distribution.size(); i++) {
            std::cout << i << "\t" << distribution(i) << std::endl;
        }
    }
}

} // namespace cli
} // namespace wfes