/**
 * Feature Flag 管理
 * 
 * 用于控制功能的启用/禁用，替代代码级的 if/else 修改
 */
 
import appConfig from './app.config';
 
class FeatureFlags {
  private flags: Map<string, boolean>;
 
  constructor(config: Record<string, boolean>) {
    this.flags = new Map(Object.entries(config));
  }
 
  isEnabled(feature: string): boolean {
    // 环境变量优先
    const envKey = `FEATURE_${feature.toUpperCase().replace(/-/g, '_')}`;
    if (process.env[envKey] !== undefined) {
      return process.env[envKey] === 'true';
    }
    return this.flags.get(feature) ?? false;
  }
 
  /**
   * 条件执行：只在功能启用时执行
   */
  async whenEnabled<T>(
    feature: string,
    fn: () => T | Promise<T>,
    fallback?: () => T | Promise<T>
  ): Promise<T | undefined> {
    if (this.isEnabled(feature)) {
      return fn();
    }
    return fallback?.();
  }
}
 
export const featureFlags = new FeatureFlags(appConfig.features);
