#!/system/bin/sh
set -e

# Started by Cursor 10131309.A25680412 20260209150000888
# Use LF line endings only; CRLF breaks shebang on Android (./build.sh: No such file or directory).
# Ended by Cursor 10131309.A25680412 20260209150000888

echo "=================================================="
echo "🚀 开始构建 OpenClaw Android 纯净分发包 (终极版)..."
echo "=================================================="

# 定义变量
TMP_DIR="/data/local/tmp"
SRC_TAR="openclaw.tar.gz"
SRC_DIR="openclaw"
OUT_DIR="android_clean_env"
DIST_TAR="openclaw-android-clean.tar.gz"

NODE_BIN="/system_ext/bin/node"
NODE_LIB="/system_ext/openclaw/nodejs"

cd $TMP_DIR

# 1. 设置环境变量
export LD_LIBRARY_PATH="$NODE_LIB:$LD_LIBRARY_PATH"
export PATH="/system_ext/bin:$PATH"
export TMPDIR="/data/local/tmp/faketmp"
export HOME="/data/local/tmp/faketmp"
export npm_config_prefix="/data/local/tmp/npm_global"
export npm_config_cache="$HOME/.npm"
mkdir -p "$TMPDIR" "$HOME" "$npm_config_prefix/bin" "$npm_config_prefix/lib"
export PATH="$npm_config_prefix/bin:/system/bin:$PATH"

export COREPACK_ENABLE_STRICT=0
export COREPACK_ENABLE_AUTO_PIN=0
export NODE_OPTIONS="--max-old-space-size=4096"

# 国内加速镜像
export npm_config_registry=https://registry.npmmirror.com
export NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node
export SHARP_DIST_BASE_URL=https://npmmirror.com/mirrors/sharp-libvips
export ESBUILD_BINARY_PATH=https://npmmirror.com/mirrors/esbuild

echo "🚄 已启用全套国内加速镜像"
echo "🧠 Node.js 堆内存限制: 4096MB"
echo "✅ Node 版本: $(node -v)"

# 2. 安装 pnpm 并创建全套包装脚本
echo "🔧 正在安装 pnpm..."
npm install -g pnpm

PNPM_CJS="$npm_config_prefix/lib/node_modules/pnpm/bin/pnpm.cjs"
if [ ! -f "$PNPM_CJS" ]; then
    PNPM_CJS=$(find $npm_config_prefix -name "pnpm.cjs" -type f 2>/dev/null | head -1)
fi
if [ -z "$PNPM_CJS" ]; then
    echo "❌ 错误：找不到 pnpm.cjs"
    exit 1
fi

cat << WRAPPER > $npm_config_prefix/bin/pnpm_android
#!/bin/sh
export LD_LIBRARY_PATH=$NODE_LIB:\$LD_LIBRARY_PATH
export COREPACK_ENABLE_STRICT=0
export COREPACK_ENABLE_AUTO_PIN=0
export npm_config_registry=https://registry.npmmirror.com
export NODE_OPTIONS="--max-old-space-size=4096"
exec $NODE_BIN $PNPM_CJS "\$@"
WRAPPER
chmod 777 $npm_config_prefix/bin/pnpm_android

rm -f $npm_config_prefix/bin/pnpm $npm_config_prefix/bin/pnpx
cp $npm_config_prefix/bin/pnpm_android $npm_config_prefix/bin/pnpm
cp $npm_config_prefix/bin/pnpm_android $npm_config_prefix/bin/pnpx
chmod 777 $npm_config_prefix/bin/pnpm $npm_config_prefix/bin/pnpx

NPM_CJS=$(find $npm_config_prefix -name "npm-cli.js" -type f 2>/dev/null | head -1)
if [ -n "$NPM_CJS" ]; then
    cat << NPMW > $npm_config_prefix/bin/npm
#!/bin/sh
export LD_LIBRARY_PATH=$NODE_LIB:\$LD_LIBRARY_PATH
export NODE_OPTIONS="--max-old-space-size=4096"
exec $NODE_BIN $NPM_CJS "\$@"
NPMW
    chmod 777 $npm_config_prefix/bin/npm
fi

NPX_CJS=$(find $npm_config_prefix -name "npx-cli.js" -type f 2>/dev/null | head -1)
if [ -n "$NPX_CJS" ]; then
    cat << NPXW > $npm_config_prefix/bin/npx
#!/bin/sh
export LD_LIBRARY_PATH=$NODE_LIB:\$LD_LIBRARY_PATH
exec $NODE_BIN $NPX_CJS "\$@"
NPXW
    chmod 777 $npm_config_prefix/bin/npx
fi

cat << NODEW > $npm_config_prefix/bin/node
#!/bin/sh
export LD_LIBRARY_PATH=$NODE_LIB:\$LD_LIBRARY_PATH
exec $NODE_BIN "\$@"
NODEW
chmod 777 $npm_config_prefix/bin/node

PNPM_CMD="$npm_config_prefix/bin/pnpm"
PNPM_VER=$($PNPM_CMD -v)
echo "📦 pnpm 版本: $PNPM_VER"

# 3. 清理历史构建并解压源码
echo "📦 正在清理旧目录并解压源码包..."
rm -rf $SRC_DIR $OUT_DIR $DIST_TAR
mkdir  $SRC_DIR
tar zxvf  $SRC_TAR -C  $SRC_DIR


if [ -f "$SRC_DIR/package.json" ]; then
    cd $SRC_DIR
else
    REAL_DIR=$(find $SRC_DIR -name "package.json" -maxdepth 2 -type f | head -1 | xargs dirname)
    cd $REAL_DIR
fi
# Started by Cursor 10131309.A25680412 20260324171145001
SRC_WORK_DIR="$(pwd)"
[ -f "$SRC_WORK_DIR/package.json" ] || { echo "❌ ERROR: package.json missing in $SRC_WORK_DIR"; exit 1; }
# Ended by Cursor 10131309.A25680412 20260324171145001
echo "✅ 当前工作目录: $(pwd)"

# 修正 packageManager 版本
sed -i "s/\"packageManager\".*/\"packageManager\": \"pnpm@${PNPM_VER}\",/" package.json

# 4. 安装依赖
echo "🔄 开始安装依赖包..."
$PNPM_CMD install 
echo "✅ 依赖包安装完成！"

# 5/6. 核心编译后再打 Control UI（与 package.json prepack: pnpm build && pnpm ui:build 一致）
# Started by Cursor 10131309.A25680412 20260325103000001
# 若先 ui:build 再 pnpm build，tsdown 会清理/重写 dist/，导致 dist/control-ui 丢失，运行时找不到 control_ui。
echo "🔨 开始核心编译..."
$PNPM_CMD run build
echo "✅ 核心编译完成！"

echo "🎨 开始编译前端 Control UI..."
$PNPM_CMD run ui:build
echo "✅ 前端UI编译完成"
# Ended by Cursor 10131309.A25680412 20260325103000001

# 7. 生成 bionic_patch
echo "📝 生成 Android 专用补丁文件..."
mkdir -p $TMP_DIR/$OUT_DIR

cat << 'PATCHEOF' > $TMP_DIR/$OUT_DIR/bionic_patch.cjs
const os = require('os');
os.networkInterfaces = () => ({
  'lo': [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true }]
});
console.log('[System] Bionic network patch injected successfully.');
PATCHEOF

# 8. 一次性打包拷贝项目文件（不过滤）
echo "📂 正在一次性拷贝项目文件（不过滤）..."
mkdir -p "$TMP_DIR/$OUT_DIR/openclaw_run"

# Started by Cursor 10131309.A25680412 20260324172641001
[ -d "$TMP_DIR/$OUT_DIR/openclaw_run" ] || { echo "❌ ERROR: target dir missing: $TMP_DIR/$OUT_DIR/openclaw_run"; exit 1; }
cd "$SRC_WORK_DIR" || { echo "❌ ERROR: source dir missing: $SRC_WORK_DIR"; exit 1; }
tar -cf - . | (cd "$TMP_DIR/$OUT_DIR/openclaw_run" && tar -xf -)
# Ended by Cursor 10131309.A25680412 20260324172641001

# 拷贝 bionic_patch 到项目根目录
cp $TMP_DIR/$OUT_DIR/bionic_patch.cjs $TMP_DIR/$OUT_DIR/openclaw_run/

echo "🧩 项目文件组装完成！"

# 9. 打包（不再包含 nodejs 二进制，目标手机已预装）
echo "🗜️ 正在压缩生成最终分发包..."
cd $TMP_DIR/$OUT_DIR
tar -czvf $TMP_DIR/$DIST_TAR openclaw_run bionic_patch.cjs > /dev/null

# 10. 收尾
cd $TMP_DIR
FINAL_SIZE=$(du -sh $DIST_TAR | cut -f1)
echo "=================================================="
echo "🎉 完美收工！OpenClaw 纯净分发包生成成功！"
echo "📦 包路径: $TMP_DIR/$DIST_TAR"
echo "📦 包大小: $FINAL_SIZE"
echo "=================================================="
echo ""
echo "【分发到其他手机的步骤】"
echo "（前提：目标手机已预装 node 到 /system_ext/openclaw/nodejs/）"
echo ""
echo "1. 从母机拉取:"
echo "   adb pull $TMP_DIR/$DIST_TAR ."
echo ""
echo "2. 推送到目标手机:"
echo "   adb push $DIST_TAR /data/openclaw/"
echo ""
echo "3. 在目标手机上部署:"
echo "   adb shell"
echo "   cd /data/openclaw/"
echo "   rm -rf /data/openclaw/openclaw_run"
echo "   tar -zxf /data/local/tmp/openclaw-android-clean.tar.gz -C /data/openclaw/"
echo "   chown -R system:system /data/openclaw/openclaw_run"
echo "4. 启动 OpenClaw:"
echo "   export LD_LIBRARY_PATH=/system_ext/openclaw/nodejs"
echo "   export TMPDIR=/data/local/tmp/faketmp"
echo "   export HOME=/data/local/tmp/faketmp"
echo "   mkdir -p /data/local/tmp/faketmp"
echo "   cd /data/openclaw/openclaw_run"
echo "   node --require ./bionic_patch.cjs openclaw.mjs gateway --allow-unconfigured --verbose"
echo "=================================================="
