#ifndef BANNER_H
#define BANNER_H

#include <iostream>
#include <string>

namespace wfes {
namespace banner {

/**
 * @brief Display the WFES ASCII art banner and credits
 * @param program_name Name of the specific program (e.g., "wfes_single")
 * @param show_credits Whether to show the full credits line (default: true)
 */
void displayBanner(const std::string& program_name = "", bool show_credits = true);

/**
 * @brief Display just the ASCII art without credits
 */
void displayASCII();

} // namespace banner
} // namespace wfes

#endif // BANNER_H