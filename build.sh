#!/bin/bash

# 开启严格模式：遇到错误立即退出
set -e

# 定义颜色输出
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # 恢复默认颜色

echo -e "\n${YELLOW}=== [1/3] 远程连接真机编译 ===${NC}"

# copy node_modules to root dir by WHL
cp -rf zte_prebuilts/node_modules_android node_modules

# package
cd ..
rm -rf openclaw/.git
tar -cf openclaw.tar.gz openclaw/

adb connect 10.230.224.39:15002
adb push openclaw.tar.gz /data/openclaw/
adb shell "cd /data/openclaw && (./build.sh; echo \$? > build_result.tmp)"

REMOTE_EXIT_CODE=$(adb shell "cat /data/openclaw/build_result.tmp" | tr -d '\r')
if [ "$REMOTE_EXIT_CODE" != "0" ]; then
    echo "真机编译失败！错误码：$REMOTE_EXIT_CODE"
    exit 1
fi
echo "真机编译成功！"


adb pull /data/openclaw/openclaw_run.tar.gz ./
tar -xf openclaw_run.tar.gz
cd openclaw_run

echo -e "\n${YELLOW}=== [2/3] 生成 Android Bionic 网络补丁 ===${NC}"

echo "const os = require('os'); os.networkInterfaces = () => ({ 'lo': [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true }] });" > bionic_patch.cjs
echo "已生成 bionic_patch.cjs"

echo -e "\n${YELLOW}=== [3/3] 组装并打包发布文件 ===${NC}"

cd ..
rm -f openclaw_run.tar.gz
cp -rf openclaw_home home
rm -rf home/.git

echo "正在压缩打包为 openclaw_run.tar.gz..."
tar -czvf openclaw_run.tar.gz openclaw_run home

FILE_SIZE=$(du -sh openclaw_run.tar.gz | awk '{print $1}')
echo "压缩包大小：${FILE_SIZE}"

echo -e "\n${GREEN}🎉 全部完成！最终一键部署包已生成: openclaw_run.tar.gz${NC}"
