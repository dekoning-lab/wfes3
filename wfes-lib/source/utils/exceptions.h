#ifndef EXCEPTIONS_H
#define EXCEPTIONS_H

#include <iterator>
#include <exception>
#include <stdexcept>

namespace wfes {
    namespace exception{
        /**
         * @brief The Error class represents an exception that happens in the application.
         */
        class Error : public std::runtime_error {
            public:
                Error(const std::string &problem) : std::runtime_error(problem) {}
                virtual ~Error() {}
        };

    }
}

#endif // EXCEPTIONS_H
