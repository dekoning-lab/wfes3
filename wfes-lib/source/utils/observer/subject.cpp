#include "subject.h"

Subject::Subject() {
    this->observers = std::vector<Observer*>();
}

void Subject::addObserver(Observer* observer) {
    this->observers.push_back(observer);
}

void Subject::notify(int value) {
    for(Observer* observer : this->observers) {
        observer->update(value);
    }
}
