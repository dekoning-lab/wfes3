#include "banner.h"
#include <iostream>
#include <iomanip>

namespace wfes {
namespace banner {

void displayASCII() {
    std::cout << "\n";
    std::cout << "██╗    ██╗███████╗███████╗███████╗\n";
    std::cout << "██║    ██║██╔════╝██╔════╝██╔════╝\n";
    std::cout << "██║ █╗ ██║█████╗  █████╗  ███████╗\n";
    std::cout << "██║███╗██║██╔══╝  ██╔══╝  ╚════██║\n";
    std::cout << "╚███╔███╔╝██║     ███████╗███████║\n";
    std::cout << " ╚══╝╚══╝ ╚═╝     ╚══════╝╚══════╝\n";
    std::cout << "\n";
}

void displayBanner(const std::string& program_name, bool show_credits) {
    displayASCII();
    
    if (show_credits) {
        std::cout << "Wright-Fisher Exact Solver (WFES) by Ivan Krukov, Alberto Casas-Ortiz,\n";
        std::cout << "Bianca DeSanctis, and A.P. Jason de Koning (2025)\n";
    }
    
    if (!program_name.empty()) {
        std::cout << "\nProgram: " << program_name << "\n";
    }
    
    std::cout << "\n" << std::string(60, '=') << "\n\n";
}

} // namespace banner
} // namespace wfes