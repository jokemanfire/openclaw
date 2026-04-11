adb shell 

rm -rf /data/openclaw/openclaw_run
tar -zxf /data/local/tmp/openclaw-android-clean.tar.gz -C /data/openclaw/

chown -R system:system /data/openclaw/openclaw_run