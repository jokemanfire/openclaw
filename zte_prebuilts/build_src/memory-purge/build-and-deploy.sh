#!/bin/bash
# Build memory_purge.node and deploy it into zte_prebuilts/libs/.
#
# Run on the dev machine (Linux x86_64) with Android NDK r29 installed.
# This is the equivalent of how zte_prebuilts/libs/sqlite-vec-android/ is
# populated.
#
# Usage:
#   export ANDROID_NDK_HOME=/opt/android-ndk-r29
#   export NODE_VERSION=24.14.0   # match device node-core
#   ./build-and-deploy.sh
#
# Output:
#   ../../libs/memory-purge-android/0.3.0/arm64/memory_purge.node
#
# NOTE: NATIVE_VERSION must match memory_purge.cc's GetInfo().version AND
# the wrapper's NATIVE_VERSION constant in memoryPurgeAdapter.ts. All three
# are kept in lockstep; bump together when ABI surface changes.

set -euo pipefail

cd "$(dirname "$0")"
SCRIPT_DIR="$(pwd)"
REPO_ROOT="$(cd ../../.. && pwd)"

# Run the actual build
./build.sh

NATIVE_VERSION="0.3.0"
DEPLOY_DIR="$REPO_ROOT/zte_prebuilts/libs/memory-purge-android/$NATIVE_VERSION/arm64"
mkdir -p "$DEPLOY_DIR"

cp "$SCRIPT_DIR/build/Release/memory_purge.node" "$DEPLOY_DIR/memory_purge.node"

echo ""
echo "=== Deployed to $DEPLOY_DIR/memory_purge.node ==="
ls -la "$DEPLOY_DIR/memory_purge.node"
file "$DEPLOY_DIR/memory_purge.node"
