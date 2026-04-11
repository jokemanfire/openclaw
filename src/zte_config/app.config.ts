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
      extraPlatforms: [
        { os: 'android', arch: 'arm64' },
      ],
    },
   
    // 功能开关
    features: {
      vectorSearch: true,
      customAuth: true,
      enhancedLogging: process.env.NODE_ENV === 'development',
    },
   
    // 服务配置
    services: {
      embedding: {
        model: 'text-embedding-ada-002',
        dimensions: 1536,
      },
      search: {
        defaultEngine: 'hybrid', // 'text' | 'vector' | 'hybrid'
        vectorWeight: 0.7,
      },
    },
   
    // 日志配置（替代直接添加 console.log）
    logging: {
      modules: {
        'sqlite-vec': process.env.DEBUG_SQLITE_VEC === 'true' ? 'debug' : 'info',
        'vector-search': 'info',
      },
    },
  };
  