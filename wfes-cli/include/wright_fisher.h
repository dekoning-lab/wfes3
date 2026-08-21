#pragma once

// This is a CLI adapter header that provides namespace mapping and compatibility
// between the original wfes2 code structure and the refactored WFES2-GUI classes

#include "model/wright-fisher/wrightFisher.h"

namespace wrightfisher = wfes::wrightfisher;

// Additional type definitions to match original wfes2 namespace
namespace WF = wfes::wrightfisher;