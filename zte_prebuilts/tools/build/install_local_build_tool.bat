rem zte_prebuilts\tools\build\install_local_build_tool.bat

adb push local_build.sh /data/openclaw/openclaw_run/

adb shell "chmod +x /data/openclaw/openclaw_run/local_build.sh"
adb shell "chown system:system /data/openclaw/openclaw_run/local_build.sh"
