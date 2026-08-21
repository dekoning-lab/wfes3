#ifdef WFES_CLI
#include <iostream>
#include "backend_config.h"
#include <iomanip>
#include <limits>
#include <vector>
#include <string>
#include <sstream>
#ifdef OMP
#include <omp.h>
#endif
#include "args.hpp"
#include "args_parser.hpp"
#include "initial_distribution.h"   // for the shared validate_model_domain checks
#include "parsing.h"
#include "wright_fisher.h"
#include "utils.h"
#include "solver.h"
#include "exceptions.h"
#include "types.h"

using namespace std;
using namespace Eigen;

// Utility functions for parsing comma-separated values
std::vector<llong> parse_long_vector(const std::string& str) {
    std::vector<llong> values;
    std::stringstream ss(str);
    std::string item;
    
    while (std::getline(ss, item, ',')) {
        item.erase(0, item.find_first_not_of(" \t"));
        item.erase(item.find_last_not_of(" \t") + 1);
        if (!item.empty()) {
            values.push_back(std::stoll(item));
        }
    }
    return values;
}

std::vector<double> parse_double_vector(const std::string& str) {
    std::vector<double> values;
    std::stringstream ss(str);
    std::string item;
    
    while (std::getline(ss, item, ',')) {
        item.erase(0, item.find_first_not_of(" \t"));
        item.erase(item.find_last_not_of(" \t") + 1);
        if (!item.empty()) {
            values.push_back(std::stod(item));
        }
    }
    return values;
}

struct Options {
    llong p;  // Starting frequency count
    string initial_distribution_path = "";  // --initial: whole starting distribution
    std::vector<llong> N_vec;     // Population sizes
    std::vector<llong> t_vec;     // Time epochs  
    std::vector<double> s_vec;    // Selection coefficients
    std::vector<double> h_vec;    // Dominance coefficients
    std::vector<double> u_vec;    // Backward mutation rates
    std::vector<double> v_vec;    // Forward mutation rates
    double alpha = 1e-20;         // Matrix tail truncation (NOT the integration cutoff)
    // Starting-copy integration cutoff, matching the other ten tools. Negative
    // means "not requested": 0 is a meaningful value (integrate nothing).
    double integration_cutoff = -1.0;
    bool verbose = false;
    // Platform-aware: hardcoding "Pardiso" made this tool fail out of the box
    // on Apple Silicon, where MKL/Pardiso does not exist.
#ifdef __APPLE__
    string library = "Accelerate";
#else
    string library = "Pardiso";
#endif
    llong block_size = 100;
    llong n_threads = 1;          // -t/--num-threads
    string output_file = "";
    bool json_output = false;      // structured output; previously unavailable
    bool csv_output = false;
};

// Helper function to iterate generations within an epoch
void iterate_generations(dvec& x, llong N, llong t, double s, double h, double u, double v, double alpha, string library, llong block_size, bool verbose = false) {
    if (t <= 0) return;
    
    WF::Matrix wf = WF::Single(N, N, WF::NON_ABSORBING, s, h, u, v, true, alpha, verbose, block_size, library);
    wf.Q->multiplyInPlaceRep(x, t, true);
    x = x / x.sum();  // Normalize
}

// Helper function to switch population size between epochs
dvec switch_population_size(const dvec& x, llong Nx, llong Ny, double s, double h, double u, double v, double alpha, string library, llong block_size, bool verbose = false) {
    WF::Matrix wf = WF::Single(Nx, Ny, WF::NON_ABSORBING, s, h, u, v, true, alpha, verbose, block_size, library);
    dvec x_copy = x;  // Create a non-const copy
    dvec next = wf.Q->multiply(x_copy, true);
    next = next / next.sum();  // Normalize
    return next;
}

Options parse_arguments(int argc, char* argv[]) {
    args::ArgumentParser parser("Wright-Fisher Allele Frequency Spectrum (Deterministic)");
    
    args::HelpFlag help(parser, "help", "Display this help menu", {"help"});
    
    args::ValueFlag<llong> arg_p(parser, "int", "Initial allele count", {'p', "initial-count"});
    args::ValueFlag<double> arg_integration_cutoff(parser, "float",
        "Starting number of copies integration cutoff", {'c', "integration-cutoff"});
    args::ValueFlag<string> arg_N_vec(parser, "int[k]", "Population sizes (comma-separated, required)", {'N', "pop-sizes"});
    args::ValueFlag<string> arg_t_vec(parser, "int[k]", "Number of generations for each epoch (comma-separated, required)", {'G', "generations"});
    args::ValueFlag<string> arg_s_vec(parser, "float[k]", "Selection coefficients (comma-separated)", {'s', "selection"});
    args::ValueFlag<string> arg_h_vec(parser, "float[k]", "Dominance coefficients (comma-separated)", {'h', "dominance"});
    args::ValueFlag<string> arg_u_vec(parser, "float[k]", "Backward mutation rates (comma-separated)", {'u', "backward-mu"});
    args::ValueFlag<string> arg_v_vec(parser, "float[k]", "Forward mutation rates (comma-separated)", {'v', "forward-mu"});
    args::ValueFlag<double> arg_alpha(parser, "float", "Tail truncation weight", {'a', "alpha"});
    args::ValueFlag<string> arg_initial(parser, "path",
        "Path to initial state distribution CSV (one probability per state)", {'i', "initial"});
    args::Flag arg_verbose(parser, "verbose", "Verbose solver output", {"verbose"});
    args::ValueFlag<string> arg_library(parser, "library", "Library (Pardiso, ViennaCL, Accelerate, SuiteSparse, or ParU). Note: on macOS, Accelerate uses UMFPACK for the factorization", {'l', "library"});
    args::ValueFlag<llong> arg_block_size(parser, "int", "Block size", {'b', "block-size"});
    // This tool was the only one of the eleven with no thread control, while
    // the GUI emitted --num-threads for it -- so any run from the GUI failed
    // with "Flag could not be matched: num-threads". Its per-epoch matrix
    // construction in wfes-lib is OpenMP-parallel, so the flag is meaningful.
    args::ValueFlag<llong> arg_n_threads(parser, "int", "Number of threads",
                                         {'t', "num-threads"});
    args::ValueFlag<string> arg_output_file(parser, "output_file", "Output file", {'o', "output-file"});
    args::Flag arg_json(parser, "json", "Output results in JSON format", {"json"});
    args::Flag arg_csv(parser, "csv", "Output results in CSV format", {"csv"});

    try {
        parser.ParseCLI(argc, argv);
    } catch (args::Help&) {
        cout << parser;
        exit(0);
    } catch (args::ParseError& e) {
        cerr << e.what() << endl;
        cerr << parser;
        exit(1);
    }

    Options options;
    
    // -p names a single starting count. It is not required when the starting
    // distribution comes from a file or from the mutation integration, which
    // both replace it; -1 marks "not given" so the run can tell them apart.
    options.p = arg_p ? args::get(arg_p) : -1;
    
    if (!arg_N_vec) {
        throw std::invalid_argument("Error: argument --pop-sizes (-N) is required.");
    }
    options.N_vec = parse_long_vector(args::get(arg_N_vec));
    
    if (!arg_t_vec) {
        throw std::invalid_argument("Error: argument --generations (-G) is required.");
    }
    options.t_vec = parse_long_vector(args::get(arg_t_vec));
    
    if (!arg_s_vec) {
        throw std::invalid_argument("Error: argument s-vec is required.");
    }
    options.s_vec = parse_double_vector(args::get(arg_s_vec));
    
    // Optional arguments with defaults
    if (arg_h_vec) {
        options.h_vec = parse_double_vector(args::get(arg_h_vec));
    } else {
        options.h_vec = std::vector<double>(options.s_vec.size(), 0.5);
    }
    
    if (arg_u_vec) {
        options.u_vec = parse_double_vector(args::get(arg_u_vec));
    } else {
        options.u_vec = std::vector<double>(options.s_vec.size(), 1e-9);
    }
    
    if (arg_v_vec) {
        options.v_vec = parse_double_vector(args::get(arg_v_vec));
    } else {
        options.v_vec = std::vector<double>(options.s_vec.size(), 1e-9);
    }
    
    if (arg_alpha) options.alpha = args::get(arg_alpha);
    if (arg_integration_cutoff) options.integration_cutoff = args::get(arg_integration_cutoff);
    if (arg_initial) options.initial_distribution_path = args::get(arg_initial);
    if (arg_verbose) options.verbose = true;
    if (arg_library) options.library = args::get(arg_library);
    if (arg_block_size) options.block_size = args::get(arg_block_size);
    if (arg_n_threads) options.n_threads = args::get(arg_n_threads);
    if (arg_output_file) options.output_file = args::get(arg_output_file);
    options.json_output = arg_json;
    options.csv_output = arg_csv;
    // parse_arguments returns Options, so signal the conflict by throwing; the
    // caller's catch turns it into "Error: ..." on stderr with a nonzero exit,
    // matching how the other validation failures in this function report.
    if (options.json_output && options.csv_output) {
        throw std::runtime_error("Cannot specify both --csv and --json output formats");
    }
    
    // Validate vector lengths
    size_t n_epochs = options.N_vec.size();
    if (options.t_vec.size() != n_epochs ||
        options.s_vec.size() != n_epochs ||
        options.h_vec.size() != n_epochs ||
        options.u_vec.size() != n_epochs ||
        options.v_vec.size() != n_epochs) {
        throw std::invalid_argument("Error: All parameter vectors must have the same length.");
    }

    // Per-epoch domain checks. This tool has its own parser and its own Options
    // struct rather than going through Args_Parser, so it does not inherit the
    // validation the other tools get; apply the same rules per epoch.
    for (size_t i = 0; i < n_epochs; ++i) {
        wfes::cli::Args_Parser::validate_model_domain(
            options.N_vec[i], options.s_vec[i], options.h_vec[i],
            options.u_vec[i], options.v_vec[i], options.alpha,
            "epoch " + std::to_string(i + 1));
    }

    return options;
}

int main(int argc, char* argv[]) {
    try {
        Options options = parse_arguments(argc, argv);

        // Same OMP + MKL pair the other tools use; see their mains.
        if (options.n_threads > 0) {
#ifdef OMP
            omp_set_num_threads(options.n_threads);
#endif
#ifdef WFES_USE_MKL
            mkl_set_num_threads(options.n_threads);
#endif
        }
        
        // Starting distribution. --initial supplies the whole thing; otherwise
        // it is a point mass at p, which is what this has always used. The
        // range check applies only to p, since a supplied distribution carries
        // its own support.
        dvec p_vec = dvec::Zero(2 * options.N_vec[0] + 1);
        if (!options.initial_distribution_path.empty()) {
            p_vec = wfes::cli::load_initial_distribution(
                options.initial_distribution_path, 2 * options.N_vec[0] + 1,
                "allele counts 0..2N in the first epoch");
        } else if (options.integration_cutoff >= 0 && options.p < 0) {
            // The starting-copy distribution a new mutation produces, as the
            // other tools build it: row 0 of the first epoch's matrix,
            // conditioned on at least one copy, truncated at the cutoff.
            wrightfisher::Row row = wrightfisher::binom_row(
                2 * options.N_vec[0],
                wrightfisher::psi_diploid(0, options.N_vec[0], options.s_vec[0],
                                          options.h_vec[0], options.u_vec[0], options.v_vec[0]),
                options.alpha);
            dvec first = row.Q;
            if (first(0) >= 1.0) {
                throw std::invalid_argument(
                    "Error: no mutation reaches one copy (forward mutation rate is zero?); "
                    "--integration-cutoff has nothing to integrate over.");
            }
            dvec tail = first.tail(first.size() - 1);
            tail /= 1 - first(0);
            llong z = 0;
            if (options.integration_cutoff > 0) {
                while (z < tail.size() && tail(z) > options.integration_cutoff) z++;
            } else {
                z = tail.size();  // cutoff 0: keep every copy number the row has
            }
            if (z == 0) {
                throw std::invalid_argument(
                    "Error: --integration-cutoff is above every starting-copy probability; "
                    "nothing would be integrated over.");
            }
            for (llong i = 0; i < z; i++) {
                llong state = row.start + 1 + i;
                if (state < p_vec.size()) p_vec(state) = tail(i);
            }
            p_vec /= p_vec.sum();
        } else {
            if (options.p < 0) {
                throw std::invalid_argument(
                    "Error: no starting state given. Use -p <count>, "
                    "--integration-cutoff <float>, or --initial <path>.");
            }
            // Valid starting counts are 1..2N-1: the state space is 0..2N, and
            // the bound here read `>= N`, which rejected every count in the
            // upper half of a perfectly ordinary state space.
            if (options.p <= 0 || options.p >= 2 * options.N_vec[0]) {
                throw std::invalid_argument(
                    "Error: starting count p must be in range (0, 2N[0]).");
            }
            p_vec(options.p) = 1.0;
        }
        
        if (options.verbose) {
            cout << "Starting with frequency " << options.p << " in population of size " << options.N_vec[0] << endl;
        }
        
        // Evolve through epochs
        for (size_t epoch = 0; epoch < options.N_vec.size(); ++epoch) {
            if (options.verbose) {
                cout << "Epoch " << (epoch + 1) << "/" << options.N_vec.size() 
                     << ": N=" << options.N_vec[epoch] 
                     << ", t=" << options.t_vec[epoch]
                     << ", s=" << options.s_vec[epoch] << endl;
            }
            
            // Evolve for t generations within the epoch
            WF::Matrix wf = WF::Single(
                options.N_vec[epoch], options.N_vec[epoch], 
                WF::NON_ABSORBING, 
                options.s_vec[epoch], options.h_vec[epoch], 
                options.u_vec[epoch], options.v_vec[epoch], 
                true, options.alpha, options.verbose, options.block_size, options.library);
            wf.Q->multiplyInPlaceRep(p_vec, options.t_vec[epoch], true);
            p_vec /= p_vec.sum();
            
            // Switch population size for next epoch (if not last epoch)
            if (epoch + 1 < options.N_vec.size()) {
                WF::Matrix wf_switch = WF::Single(
                    options.N_vec[epoch], options.N_vec[epoch + 1], 
                    WF::NON_ABSORBING, 
                    options.s_vec[epoch + 1], options.h_vec[epoch + 1], 
                    options.u_vec[epoch + 1], options.v_vec[epoch + 1], 
                    true, options.alpha, options.verbose, options.block_size, options.library);
                dvec next = wf_switch.Q->multiply(p_vec, true);
                next /= next.sum();
                p_vec = next;
            }
        }
        
        // Output final allele frequency spectrum
        if (!options.output_file.empty()) {
            std::ofstream output_stream(options.output_file.c_str());
            for (llong i = 0; i < p_vec.size(); i++) {
                output_stream << i << "\t" << p_vec(i) << endl;
            }
            output_stream.close();
        } else if (options.json_output) {
            // Round-trip precision; the stream default of 6 significant figures
            // would discard information the computation already has.
            cout << std::setprecision(std::numeric_limits<double>::max_digits10);
            // This tool previously had no --json or --csv at all: its only
            // output was a bare two-column "index<TAB>probability" dump, which
            // is why the GUI had to scrape text and mis-parsed the values.
            cout << "{" << endl;
            cout << "  \"model\": \"wfafs_deterministic\"," << endl;
            cout << "  \"parameters\": {" << endl;
            cout << "    \"starting_count\": " << options.p << "," << endl;
            cout << "    \"n_epochs\": " << options.N_vec.size() << "," << endl;
            cout << "    \"population_sizes\": [";
            for (size_t i = 0; i < options.N_vec.size(); i++) {
                cout << options.N_vec[i];
                if (i + 1 < options.N_vec.size()) cout << ", ";
            }
            cout << "]," << endl;
            cout << "    \"epoch_lengths\": [";
            for (size_t i = 0; i < options.t_vec.size(); i++) {
                cout << options.t_vec[i];
                if (i + 1 < options.t_vec.size()) cout << ", ";
            }
            cout << "]," << endl;
            cout << "    \"alpha\": " << options.alpha << endl;
            cout << "  }," << endl;
            cout << "  \"spectrum\": [" << endl;
            for (llong i = 0; i < p_vec.size(); i++) {
                cout << "    {\"count\": " << i << ", \"probability\": " << p_vec(i) << "}";
                if (i + 1 < p_vec.size()) cout << ",";
                cout << endl;
            }
            cout << "  ]" << endl;
            cout << "}" << endl;
        } else if (options.csv_output) {
            cout << "count,probability" << endl;
            for (llong i = 0; i < p_vec.size(); i++) {
                cout << i << "," << p_vec(i) << endl;
            }
        } else {
            for (llong i = 0; i < p_vec.size(); i++) {
                cout << i << "\t" << p_vec(i) << endl;
            }
        }
        
    } catch (const std::exception& e) {
        cerr << "Error: " << e.what() << endl;
        return 1;
    }
    
    return 0;
}
#endif // WFES_CLI