// customization/config/app.config.ts

/**
 * 应用配置
 *
 * 层级优先级（从高到低）：
 * 1. 环境变量 (process.env)
 * 2. 本文件的配置
 * 3. OpenClaw 默认配置
 */

export default {
  // 平台支持（对应 sqlite-vec 的 supportedPlatforms 修改）
  platform: {
    extraPlatforms: [{ os: "android", arch: "arm64" }],
  },
};
