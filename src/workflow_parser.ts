interface GraphValueArr extends Array<GraphValue> {}

interface GraphValueObj {
  [key: string]: GraphValue;
}

type GraphValue = string | GraphValueArr | GraphValueObj;

export class WorkflowGraph {
  edges: Record<string, string[]> = {};
  startNode = "1";

  addEdge(fromStep: string, toStep: string): void {
    if (!this.edges[fromStep]) this.edges[fromStep] = [];
    if (!this.edges[fromStep].includes(toStep)) {
      this.edges[fromStep].push(toStep);
    }
  }

  getNextSteps(stepId: string): string[] {
    return this.edges[stepId] ?? [];
  }

  isBranch(stepId: string): boolean {
    return this.getNextSteps(stepId).length > 1;
  }

  merge(other: WorkflowGraph): void {
    for (const [fromStep, toSteps] of Object.entries(other.edges)) {
      for (const toStep of toSteps) {
        this.addEdge(fromStep, toStep);
      }
    }
  }

  getEndNodes(): string[] {
    const allNodes = new Set(Object.keys(this.edges));
    for (const toSteps of Object.values(this.edges)) {
      for (const toStep of toSteps) allNodes.add(toStep);
    }

    if (allNodes.size === 0) return [this.startNode];

    const endNodes = [...allNodes].filter(
      (node) => node !== "END" && this.getNextSteps(node).length === 0,
    );

    return endNodes.length > 0 ? endNodes : ["END"];
  }
}

export class FractalParser {
  parse(workflowGraph: string | Record<string, GraphValue>): WorkflowGraph {
    if (typeof workflowGraph === "string") {
      return this._parseString(workflowGraph);
    }

    if (typeof workflowGraph === "object" && workflowGraph !== null) {
      return this._parseDict(workflowGraph);
    }

    throw new Error(`Unsupported workflow_graph type: ${typeof workflowGraph}`);
  }

  private _parseString(expr: string): WorkflowGraph {
    const graph = new WorkflowGraph();
    expr = expr.trim();

    const bracketPos = this._findOutermostBracket(expr);
    if (bracketPos === null) {
      const steps = this._parseArrowChain(expr);
      for (let i = 0; i < steps.length - 1; i++) {
        graph.addEdge(steps[i]!, steps[i + 1]!);
      }
      if (steps.length > 0) graph.startNode = steps[0]!;
      return graph;
    }

    const [start, end] = bracketPos;
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

    const branchContent = expr.slice(start + 1, end);
    const branches = this._splitBranches(branchContent);
    const branchEndNodes: string[] = [];

    for (const branch of branches) {
      const branchGraph = this._parseString(branch.trim());
      if (mergeFrom !== null) graph.addEdge(mergeFrom, branchGraph.startNode);
      graph.merge(branchGraph);
      branchEndNodes.push(...branchGraph.getEndNodes());
    }

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
    const entries = Object.entries(graphDict);

    if (entries.length === 0) {
      throw new Error("Invalid workflow_graph: dictionary form cannot be empty");
    }

    if ("main" in graphDict) {
      const mainGraph = this._parseValue(graphDict["main"]);
      graph.merge(mainGraph);
      graph.startNode = mainGraph.startNode;
      for (const [key, value] of entries) {
        if (key !== "main") this._processDictEntry(graph, key, value);
      }
      return graph;
    }

    const keys = Object.keys(graphDict);
    graph.startNode = keys.includes("1") ? "1" : keys[0]!;
    for (const [key, value] of entries) {
      this._processDictEntry(graph, key, value);
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
      return;
    }

    if (Array.isArray(value)) {
      for (const [index, nextStep] of value.entries()) {
        if (typeof nextStep !== "string") {
          throw new Error(
            `Invalid workflow_graph entry "${key}": array branch item at index ${index} must be a string step id`,
          );
        }
        graph.addEdge(key, nextStep);
      }
      return;
    }

    if (typeof value === "object" && value !== null) {
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
    }

    if (Array.isArray(value)) {
      const graph = new WorkflowGraph();
      for (const item of value) {
        graph.merge(this._parseValue(item as GraphValue));
      }
      return graph;
    }

    if (typeof value === "object" && value !== null) {
      return this._parseDict(value as Record<string, GraphValue>);
    }

    throw new Error(`Unsupported value type: ${typeof value}`);
  }

  private _parseArrowChain(chain: string): string[] {
    if (!chain.trim()) return [];
    return chain.split("->").map((s) => s.trim()).filter(Boolean);
  }

  private _findOutermostBracket(expr: string): [number, number] | null {
    let depth = 0;
    let start = -1;
    let outermostBracket: [number, number] | null = null;

    for (let i = 0; i < expr.length; i++) {
      const char = expr[i];
      if (char === "[") {
        if (depth === 0) start = i;
        depth++;
      } else if (char === "]") {
        if (depth === 0) {
          throw new Error(
            `Invalid workflow_graph bracket syntax: unexpected ']' at index ${i}`,
          );
        }
        depth--;
        if (depth === 0 && start >= 0 && outermostBracket === null) {
          outermostBracket = [start, i];
        }
      }
    }

    if (depth > 0) {
      throw new Error(
        `Invalid workflow_graph bracket syntax: missing closing ']' for '[' at index ${start}`,
      );
    }

    return outermostBracket;
  }

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

export function autoOutputKey(stepId: string): string {
  return `${stepId.replace(/\./g, "_")}_response`;
}
