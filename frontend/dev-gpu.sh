#!/bin/bash
# GPU-accelerated development script for MeetOdds
# Automatically detects and runs in development mode with optimal GPU features

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo -e "${BLUE}🚀 MeetOdds GPU-Accelerated Development Mode${NC}"
echo ""

# Export CUDA flags for Linux/NVIDIA
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    export CMAKE_CUDA_ARCHITECTURES=75
    export CMAKE_CUDA_STANDARD=17
    export CMAKE_POSITION_INDEPENDENT_CODE=ON
fi

# Detect OS
if [[ "$OSTYPE" == "darwin"* ]]; then
    OS="macos"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    OS="linux"
else
    echo -e "${RED}❌ Unsupported OS: $OSTYPE${NC}"
    exit 1
fi

# Function to check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Find the correct directory - we need to be in frontend root for npm commands
if [ -f "package.json" ]; then
    FRONTEND_DIR="."
elif [ -f "frontend/package.json" ]; then
    cd frontend || { echo -e "${RED}❌ Failed to change to frontend directory${NC}"; exit 1; }
    FRONTEND_DIR="frontend"
else
    echo -e "${RED}❌ Could not find package.json${NC}"
    echo -e "${RED}   Make sure you're in the project root or frontend directory${NC}"
    exit 1
fi

echo ""
echo -e "${BLUE}📦 Starting MeetOdds in development mode...${NC}"
echo ""

# Check for pnpm or npm
if command_exists pnpm; then
    PKG_MGR="pnpm"
elif command_exists npm; then
    PKG_MGR="npm"
else
    echo -e "${RED}❌ Neither npm nor pnpm found${NC}"
    exit 1
fi

# Detect GPU feature if not already set
if [ -z "$TAURI_GPU_FEATURE" ]; then
    echo -e "${BLUE}🔍 Detecting GPU features...${NC}"
    TAURI_GPU_FEATURE=$(node scripts/auto-detect-gpu.js)
fi

if [ -n "$TAURI_GPU_FEATURE" ]; then
    if [ "$TAURI_GPU_FEATURE" == "none" ]; then
        echo -e "${YELLOW}⚠️ GPU feature explicitly set to none. Running in CPU-only mode.${NC}"
    else
        echo -e "${GREEN}✅ Detected GPU feature: $TAURI_GPU_FEATURE${NC}"
    fi
    export TAURI_GPU_FEATURE
else
    echo -e "${YELLOW}⚠️ No specific GPU feature detected or forced${NC}"
fi

# Run tauri dev using npm scripts
echo ""
echo -e "${CYAN}Starting complete Tauri application...${NC}"
echo ""

$PKG_MGR run tauri:dev

if [ $? -eq 0 ]; then
    echo ""
    echo -e "${GREEN}✅ Development server stopped cleanly${NC}"
else
    echo ""
    echo -e "${RED}❌ Development server encountered an error${NC}"
    exit 1
fi