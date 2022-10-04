import fs from "fs/promises";
import path from "path";
import { CloudFormationTemplate } from "../src";
import { buildDependencyGraph, topoSortWithLevels } from "../src/graph";

describe("topo", () => {
  test("function", async () => {
    const file = await fs.readFile(
      path.join(__dirname, "test-templates", "lambda-test.json")
    );

    const template = JSON.parse(file.toString()) as CloudFormationTemplate;

    const graph = buildDependencyGraph(template);
    console.log(topoSortWithLevels(graph));
  });

  test("queue", async () => {
    const file = await fs.readFile(
      path.join(__dirname, "test-templates", "queue-test.json")
    );

    const template = JSON.parse(file.toString()) as CloudFormationTemplate;

    const graph = buildDependencyGraph(template);
    console.log(topoSortWithLevels(graph));
  });
});
