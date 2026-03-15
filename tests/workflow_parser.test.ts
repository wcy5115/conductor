/**
 * workflow_parser.ts 单元测试
 *
 * 测试 src/workflow_parser.ts 中的核心解析逻辑：
 * - WorkflowGraph 类：有向图的增删查操作（addEdge / getNextSteps / isBranch / merge / getEndNodes）
 * - FractalParser 类：字符串形式和字典形式的 workflow_graph 解析
 * - autoOutputKey()：步骤 ID → 输出键名的转换
 *
 * 这个模块是纯逻辑、零外部依赖（不涉及文件 I/O 或网络），
 * 所有测试都是同步的，不需要 mock 或临时文件。
 */

// ---- 测试框架 API ----
// describe：将相关用例分组，便于组织和阅读测试报告
// it：定义单个测试用例（别名 test），描述"它应该做什么"
// expect：创建断言，配合 .toBe() / .toEqual() / .toThrow() 等匹配器验证结果
import { describe, it, expect } from "vitest";

// ---- 被测模块 ----
// WorkflowGraph：有向图数据结构，存储步骤之间的边
// FractalParser：分形语法解析器，将字符串/字典形式的流程定义解析为 WorkflowGraph
// autoOutputKey：根据步骤 ID 生成输出键名（把 "." 替换为 "_" 再加 "_response" 后缀）
import {
  WorkflowGraph,
  FractalParser,
  autoOutputKey,
} from "../src/workflow_parser";

// ============================================================
// WorkflowGraph 类测试
// ============================================================
// WorkflowGraph 是一个邻接表表示的有向图，
// edges 字典的 key 是起点步骤 ID，value 是后继步骤 ID 数组。
// 例如 edges = { "1": ["2", "3"] } 表示步骤 1 之后可以走 2 或 3。
describe("WorkflowGraph", () => {
  // ---- addEdge 测试 ----
  describe("addEdge", () => {
    // 覆盖目标：基本的边添加功能
    // 调用 addEdge("1", "2") 后，edges["1"] 应包含 "2"
    it("添加一条边", () => {
      const graph = new WorkflowGraph();
      graph.addEdge("1", "2");
      // edges["1"] 应该是 ["2"]，表示步骤 1 的唯一后继是步骤 2
      expect(graph.edges["1"]).toEqual(["2"]);
    });

    // 覆盖目标：同一起点添加多条边
    // addEdge("1", "2") + addEdge("1", "3") → edges["1"] = ["2", "3"]
    it("同一起点添加多条边", () => {
      const graph = new WorkflowGraph();
      graph.addEdge("1", "2");
      graph.addEdge("1", "3");
      expect(graph.edges["1"]).toEqual(["2", "3"]);
    });

    // 覆盖目标：自动去重逻辑
    // 源码中 if (!this.edges[fromStep].includes(toStep)) 这行判断
    // 重复添加同一条边不应产生重复元素
    //
    // 操作：addEdge("1", "2") 调用两次
    // 预期：edges["1"] 仍然是 ["2"]，长度为 1
    it("重复添加同一条边自动去重", () => {
      const graph = new WorkflowGraph();
      graph.addEdge("1", "2");
      graph.addEdge("1", "2");
      // 去重后应该只有一个 "2"
      expect(graph.edges["1"]).toEqual(["2"]);
    });
  });

  // ---- getNextSteps 测试 ----
  describe("getNextSteps", () => {
    // 覆盖目标：正常获取后继节点
    // edges = { "1": ["2", "3"] } → getNextSteps("1") 返回 ["2", "3"]
    it("返回指定步骤的所有后继节点", () => {
      const graph = new WorkflowGraph();
      graph.addEdge("1", "2");
      graph.addEdge("1", "3");
      expect(graph.getNextSteps("1")).toEqual(["2", "3"]);
    });

    // 覆盖目标：?? [] 空值合并兜底逻辑
    // 查询一个从未添加过边的节点，edges[stepId] 为 undefined，
    // ?? 运算符返回右侧默认值 []
    it("不存在的节点返回空数组", () => {
      const graph = new WorkflowGraph();
      expect(graph.getNextSteps("999")).toEqual([]);
    });
  });

  // ---- isBranch 测试 ----
  describe("isBranch", () => {
    // 覆盖目标：单后继 → 不是分支
    // edges = { "1": ["2"] } → getNextSteps("1").length === 1 → false
    it("单后继节点返回 false", () => {
      const graph = new WorkflowGraph();
      graph.addEdge("1", "2");
      expect(graph.isBranch("1")).toBe(false);
    });

    // 覆盖目标：多后继 → 是分支
    // edges = { "1": ["2", "3"] } → getNextSteps("1").length === 2 → true
    it("多后继节点返回 true", () => {
      const graph = new WorkflowGraph();
      graph.addEdge("1", "2");
      graph.addEdge("1", "3");
      expect(graph.isBranch("1")).toBe(true);
    });

    // 覆盖目标：不存在的节点 → 后继为空数组 → length === 0 → false
    it("不存在的节点返回 false", () => {
      const graph = new WorkflowGraph();
      expect(graph.isBranch("nonexistent")).toBe(false);
    });
  });

  // ---- merge 测试 ----
  describe("merge", () => {
    // 覆盖目标：将另一个图的边合并到当前图
    // graph1: { "1": ["2"] }
    // graph2: { "2": ["3"], "3": ["END"] }
    // 合并后：graph1.edges = { "1": ["2"], "2": ["3"], "3": ["END"] }
    it("合并两个图的所有边", () => {
      const graph1 = new WorkflowGraph();
      graph1.addEdge("1", "2");

      const graph2 = new WorkflowGraph();
      graph2.addEdge("2", "3");
      graph2.addEdge("3", "END");

      graph1.merge(graph2);

      // graph1 应同时包含自己原有的边和 graph2 的边
      expect(graph1.edges["1"]).toEqual(["2"]);
      expect(graph1.edges["2"]).toEqual(["3"]);
      expect(graph1.edges["3"]).toEqual(["END"]);
    });

    // 覆盖目标：合并时通过 addEdge 自动去重
    // graph1 和 graph2 都有 "1" → "2" 这条边，合并后不应重复
    it("合并时自动去重", () => {
      const graph1 = new WorkflowGraph();
      graph1.addEdge("1", "2");

      const graph2 = new WorkflowGraph();
      graph2.addEdge("1", "2");

      graph1.merge(graph2);
      expect(graph1.edges["1"]).toEqual(["2"]);
    });
  });

  // ---- getEndNodes 测试 ----
  describe("getEndNodes", () => {
    // 覆盖目标：存在出度为 0 的非 END 节点
    // edges = { "1": ["2", "3"], "2": ["END"] }
    // 所有节点：1, 2, 3, END
    // 出度为 0 的：3（edges 中没有 "3" 作为 key）、END
    // 排除 END 后：["3"]
    it("返回出度为 0 的非 END 节点", () => {
      const graph = new WorkflowGraph();
      graph.addEdge("1", "2");
      graph.addEdge("1", "3");
      graph.addEdge("2", "END");
      // 步骤 3 没有出边，是终点节点
      expect(graph.getEndNodes()).toEqual(["3"]);
    });

    // 覆盖目标：所有路径都显式指向 END 时的兜底逻辑
    // edges = { "1": ["2"], "2": ["END"] }
    // 所有节点：1, 2, END
    // 出度为 0 的：END
    // 排除 END 后：[] → 空数组 → 触发兜底 → 返回 ["END"]
    it("所有路径都到 END 时返回 ['END']", () => {
      const graph = new WorkflowGraph();
      graph.addEdge("1", "2");
      graph.addEdge("2", "END");
      expect(graph.getEndNodes()).toEqual(["END"]);
    });

    // 覆盖目标：多个终点节点
    // edges = { "1": ["2", "3"] }
    // 步骤 2 和 3 都没有出边，都是终点
    it("返回多个终点节点", () => {
      const graph = new WorkflowGraph();
      graph.addEdge("1", "2");
      graph.addEdge("1", "3");
      expect(graph.getEndNodes()).toEqual(["2", "3"]);
    });
  });
});

// ============================================================
// FractalParser - 字符串形式测试
// ============================================================
// 字符串形式使用箭头 "->" 连接步骤，方括号 "[...]" 表示分支。
// 解析器会递归处理嵌套的方括号，最终生成有向图。
describe("FractalParser - 字符串形式", () => {
  // 创建一个共用的解析器实例
  // FractalParser 是无状态的（没有实例属性会被修改），所以多个测试共享一个实例是安全的
  const parser = new FractalParser();

  // 覆盖目标：纯箭头链，没有分支（情况 A）
  // "1 -> 2 -> END" 是最简单的线性流程
  //
  // 预期 edges：
  //   "1" → ["2"]    （步骤 1 之后走步骤 2）
  //   "2" → ["END"]  （步骤 2 之后结束）
  it("纯箭头链: '1 -> 2 -> END'", () => {
    const graph = parser.parse("1 -> 2 -> END");
    expect(graph.edges).toEqual({
      "1": ["2"],
      "2": ["END"],
    });
    // 起始节点应该是箭头链的第一个步骤
    expect(graph.startNode).toBe("1");
  });

  // 覆盖目标：单层分支（情况 B）
  // "1 -> [2, 3] -> 4 -> END" 表示步骤 1 之后分支到 2 和 3，
  // 然后 2 和 3 都汇合到步骤 4
  //
  // 预期 edges：
  //   "1" → ["2", "3"]  （分支）
  //   "2" → ["4"]       （汇合到 4）
  //   "3" → ["4"]       （汇合到 4）
  //   "4" → ["END"]     （结束）
  it("单层分支: '1 -> [2, 3] -> 4 -> END'", () => {
    const graph = parser.parse("1 -> [2, 3] -> 4 -> END");
    expect(graph.edges).toEqual({
      "1": ["2", "3"],
      "2": ["4"],
      "3": ["4"],
      "4": ["END"],
    });
    expect(graph.startNode).toBe("1");
  });

  // 覆盖目标：嵌套分支（递归解析）
  // "1 -> [2 -> [2.1, 2.2] -> 3, 4] -> 5 -> END"
  //
  // 外层分支：
  //   分支 A："2 -> [2.1, 2.2] -> 3"（内部还有分支）
  //   分支 B："4"
  //
  // 内层分支（分支 A 内部）：
  //   2 → 2.1 → 3
  //   2 → 2.2 → 3
  //
  // 预期 edges：
  //   "1"   → ["2", "4"]     （外层分支）
  //   "2"   → ["2.1", "2.2"] （内层分支）
  //   "2.1" → ["3"]          （内层汇合到 3）
  //   "2.2" → ["3"]          （内层汇合到 3）
  //   "3"   → ["5"]          （外层汇合到 5）
  //   "4"   → ["5"]          （外层汇合到 5）
  //   "5"   → ["END"]        （结束）
  it("嵌套分支: '1 -> [2 -> [2.1, 2.2] -> 3, 4] -> 5 -> END'", () => {
    const graph = parser.parse(
      "1 -> [2 -> [2.1, 2.2] -> 3, 4] -> 5 -> END",
    );
    expect(graph.edges).toEqual({
      "1": ["2", "4"],
      "2": ["2.1", "2.2"],
      "2.1": ["3"],
      "2.2": ["3"],
      "3": ["5"],
      "4": ["5"],
      "5": ["END"],
    });
    expect(graph.startNode).toBe("1");
  });

  // 覆盖目标：只有一个步骤、没有箭头的极简情况
  // "1" → 没有方括号（情况 A），_parseArrowChain("1") 返回 ["1"]
  // 只有一个步骤、没有边，所以 edges 为空
  //
  // 预期：edges = {}（没有边），startNode = "1"
  it("单步骤: '1'", () => {
    const graph = parser.parse("1");
    // 只有一个步骤，没有任何边
    expect(graph.edges).toEqual({});
    expect(graph.startNode).toBe("1");
  });
});

// ============================================================
// FractalParser - 字典形式测试
// ============================================================
// 字典形式使用键值对定义步骤之间的关系，
// 值可以是字符串（箭头链）、数组（分支）、或嵌套字典（子图）。
describe("FractalParser - 字典形式", () => {
  const parser = new FractalParser();

  // 覆盖目标：纯键值对，值为字符串（单步后继）
  // { "1": "2", "2": "END" }
  // _processDictEntry 处理 key="1" value="2"：
  //   _parseArrowChain("2") → ["2"]，steps[0] !== key → addEdge("1", "2")
  // _processDictEntry 处理 key="2" value="END"：
  //   _parseArrowChain("END") → ["END"]，steps[0] !== key → addEdge("2", "END")
  //
  // 预期 edges：{ "1": ["2"], "2": ["END"] }
  it("纯键值对: { '1': '2', '2': 'END' }", () => {
    const graph = parser.parse({ "1": "2", "2": "END" });
    expect(graph.edges).toEqual({
      "1": ["2"],
      "2": ["END"],
    });
    // 有 "1" 这个 key，所以 startNode 优先用 "1"
    expect(graph.startNode).toBe("1");
  });

  // 覆盖目标：数组值（分支）
  // { "1": ["2", "3"], "2": "END", "3": "END" }
  // _processDictEntry 处理 key="1" value=["2","3"]：
  //   Array.isArray(value) → true，遍历数组 addEdge("1","2") 和 addEdge("1","3")
  //
  // 预期 edges：{ "1": ["2", "3"], "2": ["END"], "3": ["END"] }
  it("数组值（分支）: { '1': ['2', '3'], '2': 'END', '3': 'END' }", () => {
    const graph = parser.parse({
      "1": ["2", "3"],
      "2": "END",
      "3": "END",
    });
    expect(graph.edges).toEqual({
      "1": ["2", "3"],
      "2": ["END"],
      "3": ["END"],
    });
    expect(graph.startNode).toBe("1");
  });

  // 覆盖目标：带 "main" 键的字典
  // { "main": "1 -> 2 -> END" }
  // 进入 _parseDict 的 "main" 分支：
  //   1. _parseValue(graphDict["main"]) → _parseString("1 -> 2 -> END")
  //   2. 得到 mainGraph，edges = { "1": ["2"], "2": ["END"] }
  //   3. graph.merge(mainGraph)，graph.startNode = mainGraph.startNode = "1"
  //
  // 预期 edges：{ "1": ["2"], "2": ["END"] }
  it("带 main 键: { main: '1 -> 2 -> END' }", () => {
    const graph = parser.parse({ main: "1 -> 2 -> END" });
    expect(graph.edges).toEqual({
      "1": ["2"],
      "2": ["END"],
    });
    expect(graph.startNode).toBe("1");
  });

  // 覆盖目标：不支持的类型抛异常
  // parse() 方法中 typeof workflowGraph 既不是 string 也不是 object 时，
  // 会走到 else 分支抛出 "不支持的 workflow_graph 类型" 错误
  //
  // 传入 number 类型（42）触发这个分支
  // as any 绕过 TypeScript 类型检查，模拟运行时传入非法类型的情况
  it("不支持的类型抛异常", () => {
    expect(() => parser.parse(42 as any)).toThrow("不支持的 workflow_graph 类型");
  });
});

// ============================================================
// autoOutputKey 测试
// ============================================================
// 源码逻辑：stepId.replace(/\./g, "_") + "_response"
// 把步骤 ID 中的所有点号替换为下划线，再拼上 "_response" 后缀
describe("autoOutputKey", () => {
  // 覆盖目标：无点号的步骤 ID
  // "1" 中没有点号，replace 不做任何替换，直接拼后缀
  // "1" → "1" + "_response" → "1_response"
  it("无点号: '1' → '1_response'", () => {
    expect(autoOutputKey("1")).toBe("1_response");
  });

  // 覆盖目标：有一个点号的步骤 ID
  // "1.2" 中有一个点号，replace 将其替换为下划线
  // "1.2" → "1_2" + "_response" → "1_2_response"
  it("有点号: '1.2' → '1_2_response'", () => {
    expect(autoOutputKey("1.2")).toBe("1_2_response");
  });

  // 覆盖目标：正则的 g（global）标志
  // "1.2.1" 中有两个点号，不加 g 只会替换第一个
  // 加了 g 后两个点号都被替换为下划线
  // "1.2.1" → "1_2_1" + "_response" → "1_2_1_response"
  it("多个点号: '1.2.1' → '1_2_1_response'", () => {
    expect(autoOutputKey("1.2.1")).toBe("1_2_1_response");
  });
});
