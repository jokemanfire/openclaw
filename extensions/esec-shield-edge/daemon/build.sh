#!/bin/bash

DEFAULT_VERSION="2026.5.18"
DAEMON_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT_DIR="$DAEMON_DIR/../bin"
DOCKER_IMAGE="golang:latest"

VERSION="$DEFAULT_VERSION"
GOOS=""
GOARCH=""
USE_DOCKER=false
DOCKER_REGISTRY="public-docker-virtual.artnj.zte.com.cn"
IN_DOCKER=false

[[ -f /.dockerenv ]] && IN_DOCKER=true
CMDLINE="$@"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --version)
            VERSION="$2"
            shift 2
            ;;
        --version=*)
            VERSION="${1#*=}"
            shift
            ;;
        --os)
            GOOS="$2"
            shift 2
            ;;
        --os=*)
            GOOS="${1#*=}"
            shift
            ;;
        --arch)
            GOARCH="$2"
            shift 2
            ;;
        --arch=*)
            GOARCH="${1#*=}"
            shift
            ;;
        --docker)
            USE_DOCKER=true
            shift
            ;;
        --docker-registry)
            DOCKER_REGISTRY="$2"
            USE_DOCKER=true
            shift 2
            ;;
        --docker-registry=*)
            DOCKER_REGISTRY="${1#*=}"
            USE_DOCKER=true
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --version VERSION   Set version (default: $DEFAULT_VERSION)"
            echo "  --os OS             Target OS: linux, darwin, windows (default: all)"
            echo "  --arch ARCH         Target arch: amd64, arm64 (default: all)"
            echo "  --docker            Build using Docker (golang:alpine)"
            echo "  --docker-registry   Docker registry prefix (implies --docker)"
            echo "                      Example: ghcr.io, mirror.example.com"
            echo "  -h, --help          Show this help"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

cd "$DAEMON_DIR"

LDFLAGS="-s -w -X esec-shield-daemon-edge/config.PluginVersion=$VERSION"

build() {
    local goos=$1
    local goarch=$2
    local suffix="${goos}-${goarch/amd64/x64}"
    local ext=""
    [ "$goos" = "windows" ] && ext=".exe"

    echo "Building for $goos-$goarch..."
    CGO_ENABLED=0 GOOS=$goos GOARCH=$goarch go build -ldflags="$LDFLAGS" -o "$OUTPUT_DIR/esec-shield-daemon-edge-v$VERSION-$suffix$ext" ./cmd/daemon
}

build_targets() {
    if [[ -n "$GOOS" && -n "$GOARCH" ]]; then
        build "$GOOS" "$GOARCH"
    elif [[ -n "$GOOS" ]]; then
        case "$GOOS" in
            linux)
                build linux amd64
                build linux arm64
                ;;
            darwin)
                build darwin amd64
                build darwin arm64
                ;;
            windows)
                build windows amd64
                build windows arm64
                ;;
            *)
                echo "Unknown OS: $GOOS (supported: linux, darwin, windows)"
                exit 1
                ;;
        esac
    else
        build linux amd64
        build linux arm64
        # build darwin amd64
        # build darwin arm64
        # build windows amd64
        # build windows arm64
    fi
}

generate_checksums() {
    cd "$OUTPUT_DIR"
    if command -v sha256sum &> /dev/null; then
        sha256sum esec-shield-daemon-edge-v$VERSION-* > checksums.txt
    elif command -v shasum &> /dev/null; then
        shasum -a 256 esec-shield-daemon-edge-v$VERSION-* > checksums.txt
    else
        echo "Warning: sha256sum/shasum not found, skipping checksums"
    fi
}

if $IN_DOCKER; then
    echo "Building esec-shield-daemon-edge v$VERSION (in Docker)..."
    rm -rf "$OUTPUT_DIR"/*
    mkdir -p "$OUTPUT_DIR"
    go env -w GOPROXY="https://artnj.zte.com.cn/artifactory/api/go/public-go-virtual"
    go env -w GOSUMDB="off"
    build_targets
    generate_checksums
elif $USE_DOCKER; then
    if ! command -v docker &> /dev/null; then
        echo "Error: docker not found"
        exit 1
    fi

    DOCKER_FULL_IMAGE="$DOCKER_IMAGE"
    if [[ -n "$DOCKER_REGISTRY" ]]; then
        DOCKER_FULL_IMAGE="$DOCKER_REGISTRY/$DOCKER_IMAGE"
    fi

    EXTENSION_DIR="$(dirname "$DAEMON_DIR")"

    echo "Using Docker ($DOCKER_FULL_IMAGE) for cross-compilation..."

    docker run --rm \
        -v "$EXTENSION_DIR:/work" \
        -w /work/daemon \
        -e GOOS="$GOOS" \
        -e GOARCH="$GOARCH" \
        $DOCKER_FULL_IMAGE \
        bash /work/daemon/build.sh $CMDLINE

    echo "Build complete. Binaries in $OUTPUT_DIR:"
    ls -lh "$OUTPUT_DIR"
else
    echo "Building esec-shield-daemon-edge v$VERSION..."
    rm -rf "$OUTPUT_DIR"
    mkdir -p "$OUTPUT_DIR"
    build_targets
    generate_checksums

    echo "Build complete. Binaries in $OUTPUT_DIR:"
    ls -lh "$OUTPUT_DIR"
fi
