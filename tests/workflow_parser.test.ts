import { describe, expect, it } from "vitest";

import {
  WorkflowGraph,
  FractalParser,
  autoOutputKey,
} from "../src/workflow_parser";

describe("WorkflowGraph", () => {
  describe("addEdge", () => {
    it("adds one edge", () => {
      const graph = new WorkflowGraph();
      graph.addEdge("1", "2");
      expect(graph.edges["1"]).toEqual(["2"]);
    });

    it("adds multiple edges from the same start node", () => {
      const graph = new WorkflowGraph();
      graph.addEdge("1", "2");
      graph.addEdge("1", "3");
      expect(graph.edges["1"]).toEqual(["2", "3"]);
    });

    it("deduplicates repeated edges", () => {
      const graph = new WorkflowGraph();
      graph.addEdge("1", "2");
      graph.addEdge("1", "2");
      expect(graph.edges["1"]).toEqual(["2"]);
    });
  });

  describe("getNextSteps", () => {
    it("returns all successors for a step", () => {
      const graph = new WorkflowGraph();
      graph.addEdge("1", "2");
      graph.addEdge("1", "3");
      expect(graph.getNextSteps("1")).toEqual(["2", "3"]);
    });

    it("returns an empty array for an unknown step", () => {
      const graph = new WorkflowGraph();
      expect(graph.getNextSteps("999")).toEqual([]);
    });
  });

  describe("isBranch", () => {
    it("returns false for a single successor", () => {
      const graph = new WorkflowGraph();
      graph.addEdge("1", "2");
      expect(graph.isBranch("1")).toBe(false);
    });

    it("returns true for multiple successors", () => {
      const graph = new WorkflowGraph();
      graph.addEdge("1", "2");
      graph.addEdge("1", "3");
      expect(graph.isBranch("1")).toBe(true);
    });

    it("returns false for an unknown step", () => {
      const graph = new WorkflowGraph();
      expect(graph.isBranch("nonexistent")).toBe(false);
    });
  });

  describe("merge", () => {
    it("merges all edges from another graph", () => {
      const graph1 = new WorkflowGraph();
      graph1.addEdge("1", "2");

      const graph2 = new WorkflowGraph();
      graph2.addEdge("2", "3");
      graph2.addEdge("3", "END");

      graph1.merge(graph2);

      expect(graph1.edges["1"]).toEqual(["2"]);
      expect(graph1.edges["2"]).toEqual(["3"]);
      expect(graph1.edges["3"]).toEqual(["END"]);
    });

    it("deduplicates edges while merging", () => {
      const graph1 = new WorkflowGraph();
      graph1.addEdge("1", "2");

      const graph2 = new WorkflowGraph();
      graph2.addEdge("1", "2");

      graph1.merge(graph2);
      expect(graph1.edges["1"]).toEqual(["2"]);
    });
  });

  describe("getEndNodes", () => {
    it("returns non-END nodes with out-degree zero", () => {
      const graph = new WorkflowGraph();
      graph.addEdge("1", "2");
      graph.addEdge("1", "3");
      graph.addEdge("2", "END");
      expect(graph.getEndNodes()).toEqual(["3"]);
    });

    it("returns ['END'] when every path already ends at END", () => {
      const graph = new WorkflowGraph();
      graph.addEdge("1", "2");
      graph.addEdge("2", "END");
      expect(graph.getEndNodes()).toEqual(["END"]);
    });

    it("returns multiple end nodes", () => {
      const graph = new WorkflowGraph();
      graph.addEdge("1", "2");
      graph.addEdge("1", "3");
      expect(graph.getEndNodes()).toEqual(["2", "3"]);
    });
  });
});

describe("FractalParser - string form", () => {
  const parser = new FractalParser();

  it("parses a plain arrow chain", () => {
    const graph = parser.parse("1 -> 2 -> END");
    expect(graph.edges).toEqual({
      "1": ["2"],
      "2": ["END"],
    });
    expect(graph.startNode).toBe("1");
  });

  it("parses a single-level branch", () => {
    const graph = parser.parse("1 -> [2, 3] -> 4 -> END");
    expect(graph.edges).toEqual({
      "1": ["2", "3"],
      "2": ["4"],
      "3": ["4"],
      "4": ["END"],
    });
    expect(graph.startNode).toBe("1");
  });

  it("parses nested branches", () => {
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

  it("parses a single-step graph", () => {
    const graph = parser.parse("1");
    expect(graph.edges).toEqual({});
    expect(graph.startNode).toBe("1");
  });

  it("throws on an unmatched opening bracket", () => {
    expect(() => parser.parse("1 -> [2, 3 -> END")).toThrow(
      "Invalid workflow_graph bracket syntax",
    );
  });

  it("throws on an unmatched closing bracket", () => {
    expect(() => parser.parse("1 -> 2] -> END")).toThrow(
      "Invalid workflow_graph bracket syntax",
    );
  });
});

describe("FractalParser - dictionary form", () => {
  const parser = new FractalParser();

  it("parses a plain key-value graph", () => {
    const graph = parser.parse({ "1": "2", "2": "END" });
    expect(graph.edges).toEqual({
      "1": ["2"],
      "2": ["END"],
    });
    expect(graph.startNode).toBe("1");
  });

  it("parses array branch values", () => {
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

  it("parses a dictionary with main", () => {
    const graph = parser.parse({ main: "1 -> 2 -> END" });
    expect(graph.edges).toEqual({
      "1": ["2"],
      "2": ["END"],
    });
    expect(graph.startNode).toBe("1");
  });

  it("throws on an empty dictionary graph", () => {
    expect(() => parser.parse({})).toThrow(
      "Invalid workflow_graph: dictionary form cannot be empty",
    );
  });

  it("throws when array branches contain nested values", () => {
    expect(() => parser.parse({ "1": [{ "2": "END" }] } as any)).toThrow(
      'Invalid workflow_graph entry "1": array branch item at index 0 must be a string step id',
    );
  });

  it("throws on an unsupported graph type", () => {
    expect(() => parser.parse(42 as any)).toThrow(
      "Unsupported workflow_graph type",
    );
  });
});

describe("autoOutputKey", () => {
  it("handles step ids without dots", () => {
    expect(autoOutputKey("1")).toBe("1_response");
  });

  it("handles step ids with one dot", () => {
    expect(autoOutputKey("1.2")).toBe("1_2_response");
  });

  it("handles step ids with multiple dots", () => {
    expect(autoOutputKey("1.2.1")).toBe("1_2_1_response");
  });
});
