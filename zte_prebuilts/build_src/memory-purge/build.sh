#!/bin/bash
# Build memory_purge.node for Android arm64.
#
# Required env:
#   ANDROID_NDK_HOME  Path to Android NDK r29 (or compatible)
#   NODE_VERSION      Node.js version matching device (e.g. 24.14.0)
#   ANDROID_API       Target Android API (default 24)
#
# Output: build/Release/memory_purge.node
#
# This script is idempotent: clean rebuild every time to avoid stale artifacts.

set -euo pipefail

cd "$(dirname "$0")"

NDK="${ANDROID_NDK_HOME:-/opt/android-ndk-r29}"
NODE_VERSION="${NODE_VERSION:-24.14.0}"
ANDROID_API="${ANDROID_API:-24}"

if [ ! -d "$NDK" ]; then
  echo "ERROR: ANDROID_NDK_HOME not set or invalid: $NDK" >&2
  echo "  Download NDK r29 from https://developer.android.com/ndk/downloads" >&2
  exit 1
fi

TOOLCHAIN="$NDK/toolchains/llvm/prebuilt/linux-x86_64"
CC="$TOOLCHAIN/bin/aarch64-linux-android${ANDROID_API}-clang"
CXX="$TOOLCHAIN/bin/aarch64-linux-android${ANDROID_API}-clang++"
AR="$TOOLCHAIN/bin/llvm-ar"

if [ ! -x "$CC" ]; then
  echo "ERROR: clang not found at $CC" >&2
  echo "  Check NDK version (this script expects r29). Adjust ANDROID_API or NDK." >&2
  exit 1
fi

# Locate Node.js headers
NODE_HEADERS_DIR="${NODE_HEADERS_DIR:-./node-headers-${NODE_VERSION}}"
if [ ! -d "$NODE_HEADERS_DIR" ]; then
  echo "Downloading Node.js v${NODE_VERSION} headers..."
  curl -fL -o /tmp/node-headers.tar.gz \
    "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-headers.tar.gz"
  rm -rf "$NODE_HEADERS_DIR"
  tar xf /tmp/node-headers.tar.gz
  mv "node-v${NODE_VERSION}" "$NODE_HEADERS_DIR"
  rm /tmp/node-headers.tar.gz
fi

NODE_INCLUDE="$NODE_HEADERS_DIR/include/node"

if [ ! -f "$NODE_INCLUDE/node_api.h" ]; then
  echo "ERROR: node_api.h not found at $NODE_INCLUDE" >&2
  exit 1
fi

# Build
rm -rf build
mkdir -p build/Release

echo "Compiling memory_purge.cc with target=android-arm64-api${ANDROID_API}..."
# Note: Node.js N-API symbols (napi_*) are resolved at runtime by node-core,
# not at link time. Use --unresolved-symbols=ignore-in-shared-libs to skip
# linking against napi.lib (which doesn't exist on Linux/Android targets).
"$CXX" \
  -shared -fPIC \
  -std=c++17 -O2 \
  -fno-exceptions -fno-rtti \
  -fvisibility=hidden \
  -Wall -Wextra \
  -DNAPI_VERSION=8 -D_GNU_SOURCE -DBUILDING_NODE_EXTENSION \
  -I"$NODE_INCLUDE" \
  -Wl,--unresolved-symbols=ignore-in-object-files \
  -ldl -llog \
  memory_purge.cc \
  -o build/Release/memory_purge.node

echo ""
echo "=== Build successful ==="
file build/Release/memory_purge.node
echo ""

# Disable pipefail for the inspection block; readelf|grep|head can return
# non-zero from SIGPIPE without indicating real failure.
set +o pipefail

echo "Dependencies:"
"$TOOLCHAIN/bin/llvm-readelf" -d build/Release/memory_purge.node | grep -E "NEEDED|SONAME" || true
echo ""
echo "Sample exported symbols (first 10):"
"$TOOLCHAIN/bin/llvm-readelf" -s --dyn-syms build/Release/memory_purge.node 2>/dev/null \
  | awk 'NR>3 && $4=="GLOBAL"' | head -10 || true
echo ""

set -o pipefail

echo "Output: $(pwd)/build/Release/memory_purge.node"
echo "Size: $(stat -c%s build/Release/memory_purge.node) bytes"
