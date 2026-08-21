#ifndef WFESLIB_GLOBAL_H
#define WFESLIB_GLOBAL_H

#include <QtCore/qglobal.h>

#if defined(WFESLIB_LIBRARY)
#  define WFESLIBSHARED_EXPORT Q_DECL_EXPORT
#else
#  define WFESLIBSHARED_EXPORT Q_DECL_IMPORT
#endif

#endif // WFESLIB_GLOBAL_H
