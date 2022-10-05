import { buildDependencyGraph, topoSortWithLevels } from "./graph";
import { CloudFormationTemplate } from "./template";

export function displayTopoOrder(template: CloudFormationTemplate) {
  const graph = buildDependencyGraph(template);
  const topoResult = topoSortWithLevels(graph);

  const output = topoResult
    .map(
      ({ resourceId, level }) =>
        `${[...new Array(level)].join("  ")}${resourceId}`
    )
    .join("\n");

  console.log(output);
}
