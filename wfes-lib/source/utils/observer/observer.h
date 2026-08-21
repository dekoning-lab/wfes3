#ifndef OBSERVER_H
#define OBSERVER_H

/**
 * @file observer.h
 * @brief Observer interface for the Observer design pattern
 * 
 * This file defines the abstract Observer interface used for communication
 * between the backend calculation threads and the GUI. The Observer pattern
 * allows the backend to notify the GUI of progress updates without tight coupling.
 */

/**
 * @class Observer
 * @brief Abstract observer interface for progress notifications
 * 
 * Implements the Observer design pattern to enable loose coupling between
 * the computational backend and the GUI frontend. Worker threads notify
 * observers of their progress, allowing the GUI to update progress bars
 * and status messages in real-time.
 */
class Observer {
    public:
        /**
         * @brief Default constructor
         */
        Observer() = default;

        /**
         * @brief Virtual destructor for proper cleanup of derived classes
         */
        virtual ~Observer() = default;

        /**
         * @brief Receive notification from subject
         * 
         * Called by the Subject when progress updates occur. The value
         * typically represents percentage completion (0-100) or other
         * status codes defined by the specific implementation.
         * 
         * @param value Progress value or status code from subject
         * @note This method is called from worker threads, so implementations
         *       must be thread-safe
         */
        virtual void update(int value) = 0;
};

#endif // OBSERVER_H
