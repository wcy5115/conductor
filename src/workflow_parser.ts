/**
 * 工作流分形语法解析器
 * 支持字符串和字典形式的 workflow_graph 解析
 */

// 递归类型必须通过 interface 中转，type alias 直接递归会报 TS2456
interface GraphValueArr extends Array<GraphValue> {}
interface GraphValueObj {
  [key: string]: GraphValue;
}
/** workflow_graph 字典值的递归类型（字符串 | 数组 | 嵌套字典） */
type GraphValue = string | GraphValueArr | GraphValueObj;

/**
 * 工作流图结构
 *
 * 存储步骤间的有向边，提供起始节点、后继查询等操作。
 */
export class WorkflowGraph {
  /** 边信息：{ stepId: [nextStep1, nextStep2, ...] } */
  edges: Record<string, string[]> = {};
  /** 起始节点 ID */
  startNode = "1";

  /** 添加一条有向边（自动去重） */
  addEdge(fromStep: string, toStep: string): void {
    if (!this.edges[fromStep]) this.edges[fromStep] = [];
    if (!this.edges[fromStep].includes(toStep)) {
      this.edges[fromStep].push(toStep);
    }
  }

  /** 获取指定步骤的所有后继节点 */
  getNextSteps(stepId: string): string[] {
    return this.edges[stepId] ?? [];
  }

  /** 判断是否为分支节点（后继 ≥ 2） */
  isBranch(stepId: string): boolean {
    return this.getNextSteps(stepId).length > 1;
  }

  /** 将另一个图的所有边合并到当前图 */
  merge(other: WorkflowGraph): void {
    for (const [fromStep, toSteps] of Object.entries(other.edges)) {
      for (const toStep of toSteps) {
        this.addEdge(fromStep, toStep);
      }
    }
  }

  /**
   * 获取所有终点节点（无出边且不是 "END" 的节点）
   *
   * @returns 终点节点列表；若无则返回 `["END"]`
   */
  getEndNodes(): string[] {
    const allNodes = new Set(Object.keys(this.edges));
    for (const toSteps of Object.values(this.edges)) {
      for (const toStep of toSteps) allNodes.add(toStep);
    }

    const endNodes = [...allNodes].filter(
      (node) => node !== "END" && this.getNextSteps(node).length === 0,
    );
    return endNodes.length > 0 ? endNodes : ["END"];
  }
}

/**
 * 分形语法解析器
 *
 * 将 YAML 中的 `workflow_graph` 字段解析为 {@link WorkflowGraph} 对象。
 * 支持字符串形式（箭头链 + 方括号分支）和字典形式两种语法。
 *
 * @example 字符串形式
 * ```
 * "1 -> [1.2, 1.3] -> 2 -> END"
 * ```
 *
 * @example 字典形式
 * ```yaml
 * workflow_graph:
 *   "1": "2"
 *   "2": "END"
 * ```
 */
export class FractalParser {
  /**
   * 解析 workflow_graph 定义
   *
   * @param workflowGraph 字符串或字典形式的流程定义
   * @returns 解析后的 {@link WorkflowGraph}
   */
  parse(workflowGraph: string | Record<string, GraphValue>): WorkflowGraph {
    if (typeof workflowGraph === "string") {
      return this._parseString(workflowGraph);
    } else if (typeof workflowGraph === "object" && workflowGraph !== null) {
      return this._parseDict(workflowGraph);
    } else {
      throw new Error(`不支持的 workflow_graph 类型: ${typeof workflowGraph}`);
    }
  }

  private _parseString(expr: string): WorkflowGraph {
    const graph = new WorkflowGraph();
    expr = expr.trim();

    const bracketPos = this._findOutermostBracket(expr);

    if (bracketPos === null) {
      // 无分支，纯箭头链
      const steps = this._parseArrowChain(expr);
      for (let i = 0; i < steps.length - 1; i++) {
        graph.addEdge(steps[i]!, steps[i + 1]!);
      }
      if (steps.length > 0) graph.startNode = steps[0]!;
      return graph;
    }

    const [start, end] = bracketPos;

    // 分支前的链条
    const beforeRaw = expr.slice(0, start).replace(/->\s*$/, "").trim();
    let mergeFrom: string | null = null;
    if (beforeRaw) {
      const beforeSteps = this._parseArrowChain(beforeRaw);
      for (let i = 0; i < beforeSteps.length - 1; i++) {
        graph.addEdge(beforeSteps[i]!, beforeSteps[i + 1]!);
      }
      graph.startNode = beforeSteps[0]!;
      mergeFrom = beforeSteps[beforeSteps.length - 1]!;
    }

    // 解析各分支
    const branchContent = expr.slice(start + 1, end);
    const branches = this._splitBranches(branchContent);
    const branchEndNodes: string[] = [];

    for (const branch of branches) {
      const branchGraph = this._parseString(branch.trim());
      if (mergeFrom !== null) graph.addEdge(mergeFrom, branchGraph.startNode);
      graph.merge(branchGraph);
      branchEndNodes.push(...branchGraph.getEndNodes());
    }

    // 分支后的链条
    const afterRaw = expr.slice(end + 1).replace(/^->\s*/, "").trim();
    if (afterRaw) {
      const afterSteps = this._parseArrowChain(afterRaw);
      for (const endNode of branchEndNodes) {
        if (endNode !== "END") graph.addEdge(endNode, afterSteps[0]!);
      }
      for (let i = 0; i < afterSteps.length - 1; i++) {
        graph.addEdge(afterSteps[i]!, afterSteps[i + 1]!);
      }
    }

    return graph;
  }

  private _parseDict(graphDict: Record<string, GraphValue>): WorkflowGraph {
    const graph = new WorkflowGraph();

    if ("main" in graphDict) {
      const mainGraph = this._parseValue(graphDict["main"]);
      graph.merge(mainGraph);
      graph.startNode = mainGraph.startNode;
      for (const [key, value] of Object.entries(graphDict)) {
        if (key !== "main") this._processDictEntry(graph, key, value);
      }
    } else {
      const keys = Object.keys(graphDict);
      graph.startNode = keys.includes("1") ? "1" : keys[0]!;
      for (const [key, value] of Object.entries(graphDict)) {
        this._processDictEntry(graph, key, value);
      }
    }

    return graph;
  }

  private _processDictEntry(
    graph: WorkflowGraph,
    key: string,
    value: GraphValue,
  ): void {
    if (typeof value === "string") {
      const steps = this._parseArrowChain(value);
      if (steps.length > 0) {
        if (steps[0]! !== key) graph.addEdge(key, steps[0]!);
        for (let i = 0; i < steps.length - 1; i++) {
          graph.addEdge(steps[i]!, steps[i + 1]!);
        }
      }
    } else if (Array.isArray(value)) {
      for (const nextStep of value) {
        if (typeof nextStep === "string") graph.addEdge(key, nextStep);
      }
    } else if (typeof value === "object" && value !== null) {
      for (const subKey of Object.keys(value)) {
        graph.addEdge(key, subKey);
      }
      for (const [subKey, subValue] of Object.entries(value)) {
        this._processDictEntry(graph, subKey, subValue as GraphValue);
      }
    }
  }

  private _parseValue(value: GraphValue): WorkflowGraph {
    if (typeof value === "string") {
      return this._parseString(value);
    } else if (Array.isArray(value)) {
      const graph = new WorkflowGraph();
      for (const item of value) {
        graph.merge(this._parseValue(item as GraphValue));
      }
      return graph;
    } else if (typeof value === "object" && value !== null) {
      return this._parseDict(value as Record<string, GraphValue>);
    } else {
      throw new Error(`不支持的值类型: ${typeof value}`);
    }
  }

  /** 解析箭头链："1 -> 2 -> 3" => ["1", "2", "3"] */
  private _parseArrowChain(chain: string): string[] {
    if (!chain.trim()) return [];
    return chain.split("->").map((s) => s.trim()).filter(Boolean);
  }

  /**
   * 找到最外层方括号的位置
   *
   * @returns `[start, end]` 索引对，或 `null`（若无方括号）
   */
  private _findOutermostBracket(expr: string): [number, number] | null {
    let depth = 0;
    let start = -1;

    for (let i = 0; i < expr.length; i++) {
      const char = expr[i];
      if (char === "[") {
        if (depth === 0) start = i;
        depth++;
      } else if (char === "]") {
        depth--;
        if (depth === 0 && start >= 0) return [start, i];
      }
    }
    return null;
  }

  /**
   * 分割分支表达式（正确处理嵌套方括号）
   *
   * `"1.2 -> 2, 1.3 -> 2"` => `["1.2 -> 2", "1.3 -> 2"]`
   */
  private _splitBranches(branchExpr: string): string[] {
    const branches: string[] = [];
    const current: string[] = [];
    let depth = 0;

    for (const char of branchExpr) {
      if (char === "[") {
        depth++;
        current.push(char);
      } else if (char === "]") {
        depth--;
        current.push(char);
      } else if (char === "," && depth === 0) {
        const branch = current.join("").trim();
        if (branch) branches.push(branch);
        current.length = 0;
      } else {
        current.push(char);
      }
    }

    const last = current.join("").trim();
    if (last) branches.push(last);
    return branches;
  }
}

/**
 * 自动生成步骤输出键名
 *
 * @param stepId 步骤 ID，如 `"1"`、`"1.2"`、`"1.2.1"`
 * @returns 输出键名，如 `"1_response"`、`"1_2_response"`、`"1_2_1_response"`
 */
export function autoOutputKey(stepId: string): string {
  return `${stepId.replace(/\./g, "_")}_response`;
}
