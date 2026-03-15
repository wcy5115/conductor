/**
 * 工作流分形语法解析器
 *
 * 负责把 YAML 文件中的 `workflow_graph` 字段解析成一个有向图（WorkflowGraph），
 * 供引擎（workflow_engine.ts）按图执行各步骤。
 *
 * 为什么叫"分形"？因为字符串语法支持嵌套方括号，例如：
 *   "1 -> [2 -> [2.1, 2.2] -> 3, 4] -> 5 -> END"
 * 每个 [...] 内部的结构与外层相同，可以无限嵌套——这就是分形（fractal）的含义。
 *
 * 支持两种写法：
 *
 * 1. 字符串形式（箭头链 + 方括号分支）：
 *    "1 -> [1.2, 1.3] -> 2 -> END"
 *
 * 2. 字典形式（键值对，值可以是字符串、数组或嵌套字典）：
 *    workflow_graph:
 *      "1": "2"
 *      "2": "END"
 */

// ============================================================
// GraphValue — workflow_graph 字典值的递归类型
// ============================================================

// 为什么不直接写 type GraphValue = string | GraphValue[] | { [key: string]: GraphValue }？
// 因为 TypeScript 不允许 type alias 直接递归引用自身，编译器会报 TS2456 循环引用错误。
// 解决方法：用 interface 做"中转"——interface 天然支持递归引用，
// 然后让 type GraphValue 引用这些 interface 即可。
//
// 具体来说：
//   GraphValueArr 相当于 GraphValue[]（值的数组，数组里每个元素又是 GraphValue）
//   GraphValueObj 相当于 { [key: string]: GraphValue }（值的字典，字典里每个值又是 GraphValue）
interface GraphValueArr extends Array<GraphValue> {}
interface GraphValueObj {
  [key: string]: GraphValue;
}

/**
 * workflow_graph 字典值的递归类型
 *
 * 三种可能的形态：
 *   - string：   最简单的形式，如 "2 -> 3 -> END"
 *   - 数组：     表示多个分支，如 ["2", "3"]
 *   - 嵌套字典： 表示子图，如 { "2": "3", "3": "END" }
 */
type GraphValue = string | GraphValueArr | GraphValueObj;

// ============================================================
// WorkflowGraph — 工作流图结构
// ============================================================

/**
 * 工作流图结构 —— 存储步骤之间的有向边
 *
 * "有向边"就是从步骤 A 指向步骤 B 的单向箭头，表示"执行完 A 之后执行 B"。
 *
 * 内部用一个字典 edges 存储所有边：
 *   edges = {
 *     "1": ["1.2", "1.3"],   // 步骤 1 之后可以走 1.2 或 1.3（分支）
 *     "1.2": ["2"],          // 步骤 1.2 之后走步骤 2
 *     "1.3": ["2"],          // 步骤 1.3 之后也走步骤 2（汇合）
 *     "2": ["END"],          // 步骤 2 之后结束
 *   }
 *
 * 使用示例：
 *   const graph = new WorkflowGraph();
 *   graph.addEdge("1", "2");
 *   graph.addEdge("2", "END");
 *   graph.getNextSteps("1");   // → ["2"]
 *   graph.isBranch("1");       // → false（只有一个后继）
 */
export class WorkflowGraph {
  // edges —— 邻接表，记录每个步骤的所有后继步骤
  // 类型 Record<string, string[]> 等价于 Python 的 dict[str, list[str]]
  // key 是起点步骤 ID，value 是所有后继步骤 ID 组成的数组
  edges: Record<string, string[]> = {};

  // startNode —— 整个图的起始节点 ID，默认为 "1"
  // 解析时会根据实际内容更新，比如字典形式的第一个 key
  startNode = "1";

  /**
   * 添加一条有向边（自动去重）
   *
   * 如果 fromStep → toStep 这条边已经存在，不会重复添加。
   *
   * @param fromStep 起点步骤 ID
   * @param toStep   终点步骤 ID
   */
  addEdge(fromStep: string, toStep: string): void {
    // 如果 fromStep 还没有邻接列表，先初始化为空数组
    if (!this.edges[fromStep]) this.edges[fromStep] = [];
    // 检查是否已经存在这条边，避免重复
    if (!this.edges[fromStep].includes(toStep)) {
      this.edges[fromStep].push(toStep);
    }
  }

  /**
   * 获取指定步骤的所有后继节点
   *
   * @param stepId 步骤 ID
   * @returns 后继步骤数组，如果该步骤没有出边则返回空数组
   *
   * 示例：
   *   edges = { "1": ["2", "3"] }
   *   getNextSteps("1")   → ["2", "3"]
   *   getNextSteps("999") → []（不存在的步骤返回空数组）
   */
  getNextSteps(stepId: string): string[] {
    // ?? 是空值合并运算符：左侧为 null 或 undefined 时返回右侧的默认值
    return this.edges[stepId] ?? [];
  }

  /**
   * 判断是否为分支节点
   *
   * 分支节点 = 后继步骤数量 ≥ 2，即这个步骤之后有两条或更多条路径可走。
   *
   * 示例：
   *   edges = { "1": ["2", "3"], "2": ["END"] }
   *   isBranch("1") → true（两个后继：2 和 3）
   *   isBranch("2") → false（一个后继：END）
   */
  isBranch(stepId: string): boolean {
    return this.getNextSteps(stepId).length > 1;
  }

  /**
   * 将另一个图的所有边合并到当前图
   *
   * 用途：解析嵌套分支时，先递归解析出子图，再合并到主图中。
   *
   * @param other 要合并进来的另一个 WorkflowGraph
   */
  merge(other: WorkflowGraph): void {
    // 遍历 other 图的每条边，逐条添加到当前图
    // Object.entries() 返回 [key, value] 二元组数组
    for (const [fromStep, toSteps] of Object.entries(other.edges)) {
      for (const toStep of toSteps) {
        // addEdge 内部会自动去重，不用担心重复边
        this.addEdge(fromStep, toStep);
      }
    }
  }

  /**
   * 获取所有终点节点（出度为 0 且不是 "END" 的节点）
   *
   * "终点节点"指的是没有任何出边的普通步骤——它不指向任何下一步。
   * "END" 是特殊标记（不是真正的步骤），所以被排除在外。
   *
   * 用途：解析分支时，需要知道每个分支"走到哪里结束了"，
   * 以便把分支终点连接到分支后面的步骤。
   *
   * 示例：
   *   edges = { "1": ["2", "3"], "2": ["END"] }
   *   → 所有节点：1, 2, 3, END
   *   → 出度为 0 的：3, END
   *   → 排除 END 后：["3"]
   *
   * 如果没有找到终点节点（所有路径都显式指向了 END），返回 ["END"]。
   *
   * @returns 终点节点 ID 数组
   */
  getEndNodes(): string[] {
    // 第一步：收集图中出现的所有节点（包括只作为终点、没有出边的节点）
    // Object.keys(this.edges) 只能拿到有出边的节点（作为 key 出现的），
    // 还需要遍历所有 value 数组，把只作为终点出现的节点也加进来
    const allNodes = new Set(Object.keys(this.edges));
    for (const toSteps of Object.values(this.edges)) {
      for (const toStep of toSteps) allNodes.add(toStep);
    }

    // 特殊情况：图中没有任何边（单步骤分支，如 "2"）
    // 此时 startNode 本身就是唯一的节点，既是起点也是终点
    // 如果不处理这种情况，下面的 filter 会得到空数组，
    // 兜底返回 ["END"]，导致后续连接逻辑误认为"分支已结束"而跳过连边
    if (allNodes.size === 0) return [this.startNode];

    // 第二步：过滤出终点节点
    // 条件 1：不是 "END"（END 是流程结束标记，不算业务步骤）
    // 条件 2：出度为 0（getNextSteps 返回空数组，即没有下一步）
    const endNodes = [...allNodes].filter(
      (node) => node !== "END" && this.getNextSteps(node).length === 0,
    );

    // 第三步：如果没有找到任何终点节点，说明所有路径都已显式连接到 END，
    // 这时返回 ["END"] 作为兜底
    return endNodes.length > 0 ? endNodes : ["END"];
  }
}

// ============================================================
// FractalParser — 分形语法解析器
// ============================================================

/**
 * 分形语法解析器 —— 将 YAML 中的 workflow_graph 解析为 WorkflowGraph
 *
 * 支持两种输入格式：
 *
 * 格式一：字符串形式（箭头链 + 方括号分支）
 *   "1 -> [1.2, 1.3] -> 2 -> END"
 *   解析结果：
 *     1 → 1.2 → 2 → END
 *     1 → 1.3 → 2 → END
 *
 * 格式二：字典形式（键值对）
 *   { "1": "2", "2": "END" }
 *   解析结果：
 *     1 → 2 → END
 *
 * 使用示例：
 *   const parser = new FractalParser();
 *   const graph = parser.parse("1 -> [2, 3] -> 4 -> END");
 *   graph.edges  // → { "1": ["2", "3"], "2": ["4"], "3": ["4"], "4": ["END"] }
 */
export class FractalParser {
  /**
   * 解析入口 —— 根据输入类型分派到对应的解析方法
   *
   * @param workflowGraph 字符串或字典形式的流程定义（从 YAML 文件读取）
   * @returns 解析后的有向图
   */
  parse(workflowGraph: string | Record<string, GraphValue>): WorkflowGraph {
    if (typeof workflowGraph === "string") {
      // 字符串形式，如 "1 -> [2, 3] -> END"
      return this._parseString(workflowGraph);
    } else if (typeof workflowGraph === "object" && workflowGraph !== null) {
      // 字典形式，如 { "1": "2", "2": "END" }
      return this._parseDict(workflowGraph);
    } else {
      throw new Error(`不支持的 workflow_graph 类型: ${typeof workflowGraph}`);
    }
  }

  // ============================================================
  // _parseString — 解析字符串形式的 workflow_graph
  // ============================================================

  /**
   * 解析字符串形式的 workflow_graph（核心递归方法）
   *
   * 算法思路：以最外层方括号 [...] 为分界点，把字符串切成三段：
   *   "前段 -> [分支1, 分支2] -> 后段"
   *    ^^^^     ^^^^^^^^^^^^^^    ^^^^
   *   before      branches       after
   *
   * 然后：
   *   1. 前段：按箭头链解析成线性步骤
   *   2. 分支：递归解析每个分支（分支内部可能还有嵌套的 [...]）
   *   3. 后段：按箭头链解析成线性步骤
   *   4. 把三段连接起来：前段末尾 → 各分支起点，各分支终点 → 后段起点
   *
   * 如果没有方括号（纯箭头链如 "1 -> 2 -> END"），直接线性解析，不需要递归。
   *
   * 完整示例：
   *   输入："1 -> [2 -> 3, 4] -> 5 -> END"
   *
   *   第一步：找到最外层方括号位置 [5, 16]
   *   第二步：切割——前段 "1"，分支内容 "2 -> 3, 4"，后段 "5 -> END"
   *   第三步：前段解析——步骤 ["1"]
   *   第四步：分支分割——["2 -> 3", "4"]
   *   第五步：递归解析分支 "2 -> 3" → 图 { 2→3 }，起点 "2"，终点 ["3"]
   *   第六步：递归解析分支 "4"     → 图 { }，  起点 "4"，终点 ["4"]
   *   第七步：连接——1→2, 1→4（前段末尾连接分支起点）
   *   第八步：连接——3→5, 4→5（分支终点连接后段起点）
   *   第九步：后段解析——5→END
   *
   *   最终 edges = { "1":["2","4"], "2":["3"], "3":["5"], "4":["5"], "5":["END"] }
   *
   * @param expr 字符串形式的 workflow_graph，如 "1 -> [2, 3] -> 4 -> END"
   */
  private _parseString(expr: string): WorkflowGraph {
    const graph = new WorkflowGraph();
    expr = expr.trim();

    // 第一步：找到最外层方括号的位置
    // 返回 [startIndex, endIndex] 或 null（没有方括号）
    const bracketPos = this._findOutermostBracket(expr);

    // ---- 情况 A：没有方括号，纯箭头链 ----
    // 例如 "1 -> 2 -> END" → 直接拆分成 ["1", "2", "END"]，依次连边
    if (bracketPos === null) {
      const steps = this._parseArrowChain(expr);
      // 相邻步骤之间添加有向边：steps[0]→steps[1]→steps[2]→...
      for (let i = 0; i < steps.length - 1; i++) {
        graph.addEdge(steps[i]!, steps[i + 1]!);
      }
      // 第一个步骤作为起始节点
      if (steps.length > 0) graph.startNode = steps[0]!;
      return graph;
    }

    // ---- 情况 B：有方括号，需要切割+递归 ----
    // bracketPos = [start, end]，其中 start 是 '[' 的位置，end 是对应 ']' 的位置
    const [start, end] = bracketPos;

    // 第二步：解析方括号前面的部分（"前段"）
    // 例如 "1 -> [2, 3] -> END" → 前段是 "1 -> "
    // slice(0, start) 截取到 '[' 之前，再用正则去掉末尾的 " -> "（箭头是连接符，不属于步骤名）
    const beforeRaw = expr.slice(0, start).replace(/->\s*$/, "").trim();
    // mergeFrom 记录"前段的最后一个步骤"，用于后面连接到各分支的起点
    let mergeFrom: string | null = null;
    if (beforeRaw) {
      const beforeSteps = this._parseArrowChain(beforeRaw);
      // 前段步骤之间依次连边
      for (let i = 0; i < beforeSteps.length - 1; i++) {
        graph.addEdge(beforeSteps[i]!, beforeSteps[i + 1]!);
      }
      // 前段的第一个步骤作为整个图的起始节点
      graph.startNode = beforeSteps[0]!;
      // 前段的最后一个步骤就是分支的"发散点"
      mergeFrom = beforeSteps[beforeSteps.length - 1]!;
    }

    // 第三步：解析方括号内部的各个分支
    // 例如 "[2 -> 3, 4 -> 5]" → 提取内容 "2 -> 3, 4 -> 5"
    const branchContent = expr.slice(start + 1, end);
    // 按逗号分割分支（注意要跳过嵌套方括号内的逗号）
    // "2 -> 3, 4 -> 5" → ["2 -> 3", "4 -> 5"]
    const branches = this._splitBranches(branchContent);
    // branchEndNodes 收集每个分支的终点，用于后面连接到"后段"
    const branchEndNodes: string[] = [];

    for (const branch of branches) {
      // 递归调用：每个分支本身可能又包含嵌套的 [...]
      // 例如分支 "2 -> [2.1, 2.2] -> 3" 会再次触发 _parseString 的递归
      const branchGraph = this._parseString(branch.trim());
      // 如果前段有末尾步骤，把它连接到这个分支的起点
      // 例如 mergeFrom="1"，branchGraph.startNode="2" → 添加边 1→2
      if (mergeFrom !== null) graph.addEdge(mergeFrom, branchGraph.startNode);
      // 把分支子图的所有边合并到主图
      graph.merge(branchGraph);
      // 收集这个分支的终点节点（可能有多个，如果分支内部又有分支的话）
      branchEndNodes.push(...branchGraph.getEndNodes());
    }

    // 第四步：解析方括号后面的部分（"后段"）
    // 例如 "1 -> [2, 3] -> 5 -> END" → 后段是 " -> 5 -> END"
    // slice(end + 1) 截取 ']' 之后的部分，正则去掉开头的 " -> "
    const afterRaw = expr.slice(end + 1).replace(/^->\s*/, "").trim();
    if (afterRaw) {
      const afterSteps = this._parseArrowChain(afterRaw);
      // 把每个分支的终点连接到后段的第一个步骤（汇合点）
      // 例如 branchEndNodes=["2","3"]，afterSteps[0]="5" → 添加边 2→5 和 3→5
      for (const endNode of branchEndNodes) {
        // 如果分支终点是 "END"（已经显式结束），就不再往后连了
        if (endNode !== "END") graph.addEdge(endNode, afterSteps[0]!);
      }
      // 后段步骤之间依次连边
      for (let i = 0; i < afterSteps.length - 1; i++) {
        graph.addEdge(afterSteps[i]!, afterSteps[i + 1]!);
      }
    }

    return graph;
  }

  // ============================================================
  // _parseDict — 解析字典形式的 workflow_graph
  // ============================================================

  /**
   * 解析字典形式的 workflow_graph
   *
   * 字典有两种结构：
   *
   * 结构一：有 "main" 键（入口子图 + 其他子图）
   *   {
   *     "main": "1 -> 2 -> END",     // 主流程（字符串形式）
   *     "2":    "2.1 -> 2.2 -> END"  // 步骤 2 的子步骤展开
   *   }
   *   → 先解析 main 得到主图，再处理其他键值对
   *
   * 结构二：无 "main" 键（纯键值对）
   *   {
   *     "1": "2",                    // 步骤 1 之后走步骤 2
   *     "2": ["3", "4"],             // 步骤 2 之后分支到 3 和 4
   *     "3": "END",
   *     "4": "END"
   *   }
   *   → 起始节点优先用 "1"，如果没有 "1" 就用第一个键
   *
   * @param graphDict 字典形式的流程定义
   */
  private _parseDict(graphDict: Record<string, GraphValue>): WorkflowGraph {
    const graph = new WorkflowGraph();

    if ("main" in graphDict) {
      // 有 "main" 键：先解析主流程
      const mainGraph = this._parseValue(graphDict["main"]);
      graph.merge(mainGraph);
      graph.startNode = mainGraph.startNode;
      // 处理除 "main" 以外的其他键值对
      for (const [key, value] of Object.entries(graphDict)) {
        if (key !== "main") this._processDictEntry(graph, key, value);
      }
    } else {
      // 无 "main" 键：所有键值对平等处理
      const keys = Object.keys(graphDict);
      // 起始节点优先用 "1"（约定俗成），否则用第一个键
      graph.startNode = keys.includes("1") ? "1" : keys[0]!;
      for (const [key, value] of Object.entries(graphDict)) {
        this._processDictEntry(graph, key, value);
      }
    }

    return graph;
  }

  // ============================================================
  // _processDictEntry — 处理字典中的单个键值对
  // ============================================================

  /**
   * 处理字典中的单个键值对，根据 value 的类型添加不同的边
   *
   * 三种值类型对应三种处理方式：
   *
   * 1. 字符串 → 箭头链
   *    { "1": "2 -> 3 -> END" }
   *    → 添加边 1→2, 2→3, 3→END
   *
   * 2. 数组 → 分支（一对多）
   *    { "1": ["2", "3"] }
   *    → 添加边 1→2, 1→3
   *
   * 3. 嵌套字典 → 子图
   *    { "1": { "2": "3", "3": "END" } }
   *    → 添加边 1→2, 2→3, 3→END
   *
   * @param graph 要往里添加边的目标图
   * @param key   字典的键（起点步骤 ID）
   * @param value 字典的值（终点步骤定义，类型可能是字符串、数组或嵌套字典）
   */
  private _processDictEntry(
    graph: WorkflowGraph,
    key: string,
    value: GraphValue,
  ): void {
    if (typeof value === "string") {
      // 值是字符串 → 按箭头链解析
      // 例如 key="1", value="2 -> 3 -> END" → steps=["2", "3", "END"]
      const steps = this._parseArrowChain(value);
      if (steps.length > 0) {
        // 如果箭头链的第一个步骤不是 key 本身，需要添加 key → 第一步 的边
        // 例如 key="1", steps=["2","3"] → 添加 1→2
        // 但如果写成 "1": "1 -> 2 -> 3"，steps[0] 就是 "1" 本身，不需要再加自环边
        if (steps[0]! !== key) graph.addEdge(key, steps[0]!);
        // 箭头链内部的步骤依次连边
        for (let i = 0; i < steps.length - 1; i++) {
          graph.addEdge(steps[i]!, steps[i + 1]!);
        }
      }
    } else if (Array.isArray(value)) {
      // 值是数组 → 分支，key 指向数组中的每一项
      // 例如 key="1", value=["2", "3"] → 添加 1→2, 1→3
      for (const nextStep of value) {
        if (typeof nextStep === "string") graph.addEdge(key, nextStep);
      }
    } else if (typeof value === "object" && value !== null) {
      // 值是嵌套字典 → 子图
      // 例如 key="1", value={ "2": "3", "3": "END" }
      // 第一步：key 指向子字典的每个键（子图的入口）
      // → 添加 1→2, 1→3
      for (const subKey of Object.keys(value)) {
        graph.addEdge(key, subKey);
      }
      // 第二步：递归处理子字典的每个键值对
      // → 处理 "2": "3" 和 "3": "END"
      for (const [subKey, subValue] of Object.entries(value)) {
        this._processDictEntry(graph, subKey, subValue as GraphValue);
      }
    }
  }

  // ============================================================
  // _parseValue — 通用值解析（递归分派）
  // ============================================================

  /**
   * 根据值的类型分派到对应的解析方法
   *
   * 这是一个递归入口，用于处理字典中 "main" 键的值，
   * 因为 main 的值可能是字符串、数组或嵌套字典中的任何一种。
   *
   * @param value 要解析的值
   * @returns 解析出的子图
   */
  private _parseValue(value: GraphValue): WorkflowGraph {
    if (typeof value === "string") {
      // 字符串 → 交给 _parseString 处理
      return this._parseString(value);
    } else if (Array.isArray(value)) {
      // 数组 → 把每个元素分别解析成子图，全部合并
      const graph = new WorkflowGraph();
      for (const item of value) {
        graph.merge(this._parseValue(item as GraphValue));
      }
      return graph;
    } else if (typeof value === "object" && value !== null) {
      // 字典 → 交给 _parseDict 处理
      return this._parseDict(value as Record<string, GraphValue>);
    } else {
      throw new Error(`不支持的值类型: ${typeof value}`);
    }
  }

  // ============================================================
  // 辅助方法
  // ============================================================

  /**
   * 解析箭头链 —— 把 "1 -> 2 -> 3" 拆成 ["1", "2", "3"]
   *
   * 处理步骤：
   *   1. 按 "->" 分割字符串
   *   2. 每段去掉首尾空白
   *   3. 过滤掉空字符串（处理 "1 -> -> 3" 这种异常写法）
   *
   * 示例：
   *   "1 -> 2 -> END" → ["1", "2", "END"]
   *   "1"             → ["1"]
   *   ""              → []（空字符串返回空数组）
   *
   * @param chain 箭头链字符串
   * @returns 步骤 ID 数组
   */
  private _parseArrowChain(chain: string): string[] {
    if (!chain.trim()) return [];
    return chain.split("->").map((s) => s.trim()).filter(Boolean);
  }

  /**
   * 找到最外层方括号的位置（括号匹配算法）
   *
   * 用一个 depth 变量追踪嵌套层级：
   *   遇到 '[' → depth++
   *   遇到 ']' → depth--
   *   当 depth 从 1 降回 0 时，找到了与第一个 '[' 配对的 ']'
   *
   * 示例：
   *   "1 -> [2, [3, 4]] -> 5"
   *         ^          ^
   *     start=5     end=16
   *
   *   逐字符扫描过程：
   *   位置 5  '[' → depth: 0→1, 记录 start=5
   *   位置 9  '[' → depth: 1→2（嵌套层，跳过）
   *   位置 13 ']' → depth: 2→1（嵌套层关闭，还没回到 0）
   *   位置 14 ']' → depth: 1→0, 返回 [5, 14]
   *
   * @param expr 要搜索的字符串
   * @returns [start, end] 索引对，或 null（没有方括号）
   */
  private _findOutermostBracket(expr: string): [number, number] | null {
    // depth 追踪当前方括号嵌套深度，0 表示在所有方括号外面
    let depth = 0;
    // start 记录第一个 '[' 的位置，初始 -1 表示还没找到
    let start = -1;

    for (let i = 0; i < expr.length; i++) {
      const char = expr[i];
      if (char === "[") {
        // 遇到左方括号：如果是最外层的（depth === 0），记录起始位置
        if (depth === 0) start = i;
        depth++;
      } else if (char === "]") {
        depth--;
        // 遇到右方括号且 depth 降回 0：找到了配对的最外层方括号
        if (depth === 0 && start >= 0) return [start, i];
      }
    }
    // 没有找到完整的方括号对
    return null;
  }

  /**
   * 分割分支表达式 —— 在逗号处切割，但跳过嵌套方括号内的逗号
   *
   * 为什么不直接用 split(",")？
   * 因为分支内部可能有嵌套的 [...]，里面也有逗号，直接 split 会错误地把嵌套分支拆开。
   *
   * 算法：逐字符扫描，用 depth 追踪方括号嵌套深度，只在 depth === 0 时的逗号处切割。
   *
   * 示例：
   *   "2 -> 3, 4 -> [5, 6] -> 7"
   *   → ["2 -> 3", "4 -> [5, 6] -> 7"]
   *
   *   解析过程：
   *   - 扫描到第一个逗号（位置 6）：depth=0，切割！→ 收集 "2 -> 3"
   *   - 扫描到 '['（位置 14）：depth 变为 1
   *   - 扫描到逗号（位置 16）：depth=1，跳过！（这是嵌套分支内部的逗号）
   *   - 扫描到 ']'（位置 19）：depth 变为 0
   *   - 扫描结束：收集剩余部分 "4 -> [5, 6] -> 7"
   *
   * @param branchExpr 方括号内的分支表达式（不含外层方括号本身）
   * @returns 各分支字符串数组
   */
  private _splitBranches(branchExpr: string): string[] {
    const branches: string[] = [];
    // current 数组用来逐字符拼接当前分支的内容
    // 为什么用数组而不是字符串拼接？因为 JS 中字符串拼接每次创建新字符串，
    // 而数组 push + 最后 join 只创建一次，在字符很多时性能更好
    const current: string[] = [];
    // depth 追踪方括号嵌套深度，只有 depth=0 时的逗号才是分支分隔符
    let depth = 0;

    for (const char of branchExpr) {
      if (char === "[") {
        // 进入嵌套方括号，深度加 1
        depth++;
        current.push(char);
      } else if (char === "]") {
        // 离开嵌套方括号，深度减 1
        depth--;
        current.push(char);
      } else if (char === "," && depth === 0) {
        // 最外层的逗号 → 分支分隔符，切割
        const branch = current.join("").trim();
        if (branch) branches.push(branch);
        // 清空 current 数组，准备收集下一个分支
        // current.length = 0 是清空数组的高效写法，等价于 current.splice(0)
        current.length = 0;
      } else {
        // 普通字符（包括嵌套方括号内的逗号），追加到当前分支
        current.push(char);
      }
    }

    // 最后一个分支没有逗号结尾，需要手动收集
    const last = current.join("").trim();
    if (last) branches.push(last);
    return branches;
  }
}

// ============================================================
// autoOutputKey — 步骤输出键名生成
// ============================================================

/**
 * 根据步骤 ID 自动生成输出键名
 *
 * 规则：把步骤 ID 中的点号 "." 替换为下划线 "_"，再拼上 "_response" 后缀。
 * 原因：context.data 的键名中如果包含点号，在某些场景下会与 deepGet 的点路径语法冲突，
 * 所以用下划线替代。
 *
 * 示例：
 *   autoOutputKey("1")     → "1_response"
 *   autoOutputKey("1.2")   → "1_2_response"
 *   autoOutputKey("1.2.1") → "1_2_1_response"
 *
 * 正则拆解：
 *   /\./g
 *    \.  — 转义的点号，匹配字面量 "."（不转义的话 . 在正则中匹配任意字符）
 *    g   — global 标志，替换所有匹配项（不加 g 只替换第一个）
 *
 * @param stepId 步骤 ID，如 "1"、"1.2"、"1.2.1"
 * @returns 输出键名，如 "1_response"、"1_2_response"、"1_2_1_response"
 */
export function autoOutputKey(stepId: string): string {
  return `${stepId.replace(/\./g, "_")}_response`;
}
