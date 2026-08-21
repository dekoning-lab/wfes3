#pragma once

#include <string>
#include <chrono>
#include <Eigen/Dense>

/**
 * @file types.h
 * @brief Type definitions and data structures for WFES command-line tools
 */

// Basic type definitions
typedef long long llong;  ///< Long integer type for large population sizes
typedef Eigen::VectorXd dvec;  ///< Double precision vector
typedef Eigen::VectorXi ivec;  ///< Integer vector
typedef Eigen::Matrix<llong, Eigen::Dynamic, 1> lvec;  ///< Long integer vector
typedef Eigen::Matrix<double, Eigen::Dynamic, Eigen::Dynamic, Eigen::RowMajor> dmat;  ///< Double precision matrix (row-major)

// Time point and duration definitions
using time_point = std::chrono::time_point<std::chrono::system_clock>;  ///< Time point for performance measurement
using time_diff = std::chrono::duration<double>;  ///< Time duration in seconds

namespace wfes {
namespace cli {

/**
 * @enum ModelType
 * @brief Available model types for WFES single population analysis
 */
enum class ModelType {
    ABSORPTION,      ///< Both extinction and fixation are absorbing states
    FIXATION,        ///< Only fixation is absorbing
    ESTABLISHMENT,   ///< Calculate establishment probabilities
    FUNDAMENTAL,     ///< Calculate fundamental matrix
    EQUILIBRIUM,     ///< Calculate equilibrium distribution
    NON_ABSORBING,   ///< Generate transition matrix only
    ALLELE_AGE       ///< Calculate expected age of an allele
};

/**
 * @enum SweepModelType
 * @brief Available model types for WFES sweep analysis
 */
enum class SweepModelType {
    FIXATION        ///< Fixation probability in sweep model
};

/**
 * @struct CommandLineOptions
 * @brief Structure containing all command-line options for WFES tools
 */
struct CommandLineOptions {
    // Model type
    ModelType model_type;
    
    // Population parameters
    llong population_size;
    double selection_coefficient;
    double dominance;
    double backward_mutation;
    double forward_mutation;
    bool recurrent_mutation;
    
    // Computational parameters
    double alpha;
    llong block_size;
    llong n_threads;
    double integration_cutoff;
    llong starting_copies;
    llong observed_copies;
    double odds_ratio;
    
    // Switching-specific parameters (for multi-model analyses)
    std::string population_sizes_str;
    std::string selection_coefficients_str;
    std::string dominance_coefficients_str;
    std::string backward_mutations_str;
    std::string forward_mutations_str;
    std::string starting_probabilities_str;
    std::string switching_matrix_str;
    std::string expected_times_str;  // For sequential models
    llong num_threads;
    
    // Time distribution specific parameters
    llong max_t;
    std::string output_P_path;
    double distribution_cutoff;  // CDF cutoff for distribution programs
    
    // Phase type moments specific parameters
    llong n_moments;
    
    // SGV (Standing Genetic Variation) specific parameters
    double lambda;
    
    // wfafs_stochastic specific parameters
    std::string generations_str;       // Expected generations in each model
    std::string factors_str;          // Matrix approximation factors
    llong initial_count;              // Initial allele count
    bool no_project;                  // Do not project distribution down
    std::string output_N_tmo_path;    // Output timeout-conditional sojourn
    
    // Input/output file paths
    std::string initial_distribution_path;
    std::string output_Q_path;
    std::string output_R_path;
    std::string output_N_path;
    std::string output_N_ext_path;
    std::string output_N_fix_path;
    std::string output_B_path;
    std::string output_I_path;
    std::string output_E_path;
    std::string output_V_path;
    
    // Backend selection
    std::string library;
    
    // Output formatting
    bool csv_output;
    bool json_output;
    bool force;
    bool verbose;
    
    // Constructor with defaults
    CommandLineOptions() : 
        population_size(0),
        selection_coefficient(0.0),
        dominance(0.5),
        backward_mutation(1e-9),
        forward_mutation(1e-9),
        recurrent_mutation(true),
        alpha(1e-20),
        block_size(100),
        n_threads(1),
        integration_cutoff(1e-10),
        starting_copies(0),
        observed_copies(0),
        odds_ratio(1.0),
        num_threads(1),
        max_t(100000),
        distribution_cutoff(0.99999),
        n_moments(20),
        lambda(0.0),
        initial_count(-1),
        no_project(false),
        library("Pardiso"),
        csv_output(false),
        json_output(false),
        force(false),
        verbose(false) {}
};

/**
 * @struct SweepCommandLineOptions
 * @brief Structure containing command-line options specific to wfes_sweep
 */
struct SweepCommandLineOptions {
    // Model type
    SweepModelType model_type;
    
    // Population parameters
    llong population_size;
    dvec selection_coefficients;  // Vector of length 2
    dvec dominance;              // Vector of length 2
    dvec backward_mutation;      // Vector of length 2
    dvec forward_mutation;       // Vector of length 2
    double lambda;               // Transition probability
    
    // Numerical parameters
    double alpha;
    llong n_threads;
    double integration_cutoff;
    llong starting_copies;
    
    // Output paths
    std::string output_Q_path;
    std::string output_R_path;
    std::string output_N_path;
    std::string output_B_path;
    std::string output_I_path;
    
    // Backend selection
    std::string library;
    
    // Output formatting
    bool csv_output;
    bool json_output;
    bool force;
    bool verbose;
    
    // Constructor with defaults
    SweepCommandLineOptions() : 
        population_size(0),
        lambda(0.0),
        alpha(1e-20),
        n_threads(1),
        integration_cutoff(1e-10),
        starting_copies(-1),
        library("Pardiso"),
        csv_output(false),
        json_output(false),
        force(false),
        verbose(false) {
        selection_coefficients = dvec::Zero(2);
        dominance = dvec::Constant(2, 0.5);
        backward_mutation = dvec::Constant(2, 1e-9);
        forward_mutation = dvec::Constant(2, 1e-9);
    }
};

} // namespace cli
} // namespace wfes