#ifndef SUBJECT_H
#define SUBJECT_H

#include "observer.h"

#include "vector"

/**
 * @file subject.h
 * @brief Subject interface for the Observer design pattern
 * 
 * This file defines the Subject class that worker threads inherit from
 * to send progress notifications to the GUI. Part of the Observer pattern
 * implementation for loose coupling between backend and frontend.
 */

/**
 * @class Subject
 * @brief Observable subject that notifies observers of state changes
 * 
 * Worker threads inherit from this class to gain the ability to notify
 * GUI components of their progress. The Subject maintains a list of
 * observers and notifies them all when progress updates occur.
 */
class Subject{
    public:
         /**
         * @brief Default constructor
         */
        Subject();

        /**
         * @brief List of registered observers
         * 
         * Contains pointers to all Observer instances that should be
         * notified of progress updates. Typically includes GUI components
         * like progress bars or status labels.
         */
        std::vector<Observer*> observers;

        /**
         * @brief Register an observer for notifications
         * 
         * Adds an observer to the notification list. The observer will
         * receive update() calls whenever notify() is called.
         * 
         * @param observer Pointer to observer to register
         * @note Does not take ownership of the observer pointer
         */
        void addObserver(Observer* observer);

        /**
         * @brief Notify all registered observers
         * 
         * Calls update(value) on each registered observer. Typically
         * called from worker threads to report progress.
         * 
         * @param value Progress value (usually 0-100) or status code
         * @note This method should be thread-safe if called from worker threads
         */
        void notify(int value);

};

#endif // SUBJECT_H
