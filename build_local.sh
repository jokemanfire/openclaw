#!/usr/bin/env bash
# Started by Cursor 10131309.A25680412 20260209123000888
set -e

# Started by Cursor 10131309.A25680412 20260209140000888
# Git Bash (MSYS) maps paths like /data/... to C:/Program Files/Git/data/... and breaks adb remote paths.
# MSYS_NO_PATHCONV=1 disables that rewrite for adb push/pull/shell arguments.
case "$(uname -s 2>/dev/null)" in
  MINGW* | MSYS* | CYGWIN*) export MSYS_NO_PATHCONV=1 ;;
esac
# Ended by Cursor 10131309.A25680412 20260209140000888

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

OPENCLAW_DIR="openclaw-default-ccs"

echo -e "\n${YELLOW}=== [1/3] 连接真机编译 ===${NC}"

cp -rf zte_prebuilts/node_modules_android node_modules

cd ..
rm -f openclaw.tar.gz
# Started by Cursor 10131309.A25680412 20260209160000888
# Real gzip (.tar.gz): device build.sh uses tar zxf path; plain tar caused zcat: not gzip.
tar -czf openclaw.tar.gz --exclude=.git "${OPENCLAW_DIR}/"
# Ended by Cursor 10131309.A25680412 20260209160000888

echo -e "pack completed"

# adb connect 10.230.224.39:15002
adb push openclaw.tar.gz /data/local/tmp/

echo -e "push completed"

adb push "${OPENCLAW_DIR}/zte_prebuilts/tools/build/build.sh" /data/openclaw/
adb shell "chmod +x /data/openclaw/build.sh"

echo -e "start to build"
adb shell "cd /data/openclaw && (./build.sh; echo \$? > build_result.tmp)"

REMOTE_EXIT_CODE=$(adb shell "cat /data/openclaw/build_result.tmp" | tr -d '\r')
if [ "${REMOTE_EXIT_CODE}" != "0" ]; then
  echo "真机编译失败！错误码：${REMOTE_EXIT_CODE}"
  exit 1
fi
echo "真机编译成功！"

#adb pull /data/local/tmp/openclaw_run.tar.gz .
echo -e "获取命令: adb pull /data/local/tmp/openclaw-android-clean.tar.gz ."
echo -e "\n${GREEN}全部完成！最终一键部署包已生成: openclaw_run.tar.gz${NC}"
# Ended by Cursor 10131309.A25680412 20260209123000888
