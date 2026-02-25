/**
 * 模型管理器模块
 * 用于处理模型简称到完整配置的映射
 */

const logger = {
  info: (msg: string) => console.info(msg),
  warning: (msg: string) => console.warn(msg),
  error: (msg: string) => console.error(msg),
};

// ========================================
// 类型定义
// ========================================

export interface ModelConfig {
  provider: "openai" | "anthropic";
  model_name: string;
  temperature?: number;
  max_tokens?: number;
  [key: string]: unknown;
}

// ========================================
// ModelManager 类
// ========================================

/**
 * 模型管理器，处理模型简称解析
 *
 * 用法：
 *   const manager = new ModelManager({
 *     gpt35: { provider: "openai", model_name: "gpt-3.5-turbo" },
 *     claude3: { provider: "anthropic", model_name: "claude-3-sonnet-20240229" },
 *   });
 *   const config = manager.getModelConfig("gpt35");
 */
export class ModelManager {
  private modelMappings: Record<string, ModelConfig>;

  constructor(modelMappings: Record<string, ModelConfig> = {}) {
    this.modelMappings = { ...modelMappings };
    logger.info(`模型管理器初始化完成，加载了 ${Object.keys(this.modelMappings).length} 个模型映射`);
  }

  // ========================================
  // 查询
  // ========================================

  /**
   * 根据模型简称获取完整的模型配置
   * 找不到时返回 null
   */
  getModelConfig(modelAlias: string): ModelConfig | null {
    if (!modelAlias) {
      logger.warning("模型简称为空");
      return null;
    }

    // 直接查找模型映射
    const config = this.modelMappings[modelAlias];
    if (config) {
      logger.info(`找到模型映射: ${modelAlias} -> ${JSON.stringify(config)}`);
      return { ...config }; // 返回副本，避免外部修改原始配置
    }

    // 没找到简称，尝试按完整模型名称匹配
    logger.warning(`未找到模型简称 '${modelAlias}' 的映射，尝试作为完整模型名称处理`);
    for (const providerConfig of Object.values(this.modelMappings)) {
      if (providerConfig.model_name === modelAlias) {
        return { ...providerConfig };
      }
    }

    logger.error(`无法找到模型 '${modelAlias}' 的配置`);
    return null;
  }

  /**
   * 获取所有可用的模型映射
   */
  listAvailableModels(): Record<string, ModelConfig> {
    return { ...this.modelMappings };
  }

  // ========================================
  // 增删改
  // ========================================

  /**
   * 添加新的模型映射，返回是否成功
   */
  addModelMapping(alias: string, config: ModelConfig): boolean {
    if (!alias || !config) {
      logger.error("模型简称或配置不能为空");
      return false;
    }
    if (alias in this.modelMappings) {
      logger.warning(`模型简称 '${alias}' 已存在，将被覆盖`);
    }
    this.modelMappings[alias] = config;
    logger.info(`添加模型映射: ${alias} -> ${JSON.stringify(config)}`);
    return true;
  }

  /**
   * 删除模型映射，返回是否成功
   */
  removeModelMapping(alias: string): boolean {
    if (alias in this.modelMappings) {
      delete this.modelMappings[alias];
      logger.info(`删除模型映射: ${alias}`);
      return true;
    }
    logger.warning(`模型简称 '${alias}' 不存在`);
    return false;
  }

  // ========================================
  // 验证
  // ========================================

  /**
   * 验证模型配置是否有效
   */
  validateModelConfig(config: ModelConfig): boolean {
    if (!config) return false;

    for (const field of ["provider", "model_name"] as const) {
      if (!config[field]) {
        logger.error(`模型配置缺少必要字段: ${field}`);
        return false;
      }
    }

    const validProviders: string[] = ["openai", "anthropic"];
    if (!validProviders.includes(config.provider)) {
      logger.error(`不支持的提供商: ${config.provider}`);
      return false;
    }

    const temperature = config.temperature ?? 0.7;
    if (temperature < 0 || temperature > 2) {
      logger.error(`温度值超出有效范围 [0, 2]: ${temperature}`);
      return false;
    }

    const maxTokens = config.max_tokens ?? 2000;
    if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
      logger.error(`max_tokens 必须是正整数: ${maxTokens}`);
      return false;
    }

    return true;
  }
}
