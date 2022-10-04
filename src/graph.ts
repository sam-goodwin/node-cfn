import { Set as ImmutableSet } from "immutable";
import { Expression } from "./expression";
import {
  isIntrinsicFunction,
  isRef,
  isFnGetAtt,
  isFnJoin,
  isFnSelect,
  isFnSplit,
  isFnSub,
  isFnBase64,
} from "./function";
import { isPseudoParameter } from "./pseudo-parameter";
// @ts-ignore - for tsdoc
import type { Stack } from "./stack";
import { CloudFormationTemplate } from "./template";

/**
 * Maps a Logical ID to the Logical IDs it depends on.
 */
export interface DependencyGraph {
  [logicalId: string]: string[];
}

/**
 * Builds the {@link DependencyGraph} for the {@link template}.
 *
 * @param template a {@link CloudFormationTemplate}
 * @returns the {@link DependencyGraph} for the {@link CloudFormationTemplate}.
 * @throws an Error if the stack is invalid, for example when there are any circular references in the template
 */
export function buildDependencyGraph(
  template: CloudFormationTemplate
): DependencyGraph {
  const graph: DependencyGraph = {};
  for (const [logicalId, resource] of Object.entries(template.Resources)) {
    graph[logicalId] = [
      ...(resource.Properties
        ? Array.from(new Set(findReferences(resource.Properties)))
        : []),
      ...(resource.DependsOn ?? []),
    ]
      // do not maintain parameters as dependencies, for now.
      .filter((x) => !(x in (template.Parameters ?? {})));
  }

  const circularReferences = findCircularReferences(graph);
  if (circularReferences.length > 0) {
    throw new Error(
      `circular references detected: ${circularReferences.join(",")}`
    );
  }

  return graph;
}

/**
 * Maps logical ids to the logical ids that depend on it.
 */
export function createDependentGraph(graph: DependencyGraph): DependencyGraph {
  const iGraph: Record<string, Set<string>> = {};
  Object.entries(graph).forEach(([dependent, dependencies]) => {
    if (!(dependent in iGraph)) {
      iGraph[dependent] = new Set();
    }
    dependencies.forEach((dependency) => {
      if (!(dependency in iGraph)) {
        iGraph[dependency] = new Set();
      }
      iGraph[dependency].add(dependent);
    });
  });
  return Object.fromEntries(
    Object.entries(iGraph).map(([key, values]) => [key, [...values]])
  );
}

export function topoSortWithLevels(graph: DependencyGraph) {
  // create a mutable dependency graph we'll use later.
  const depGraph = { ...graph };
  // we want fast access to all dependents of the graph.
  const invertedDepGraph = createDependentGraph(graph);
  // find one or more nodes that have no dependencies
  const roots = Object.entries(graph)
    .filter(([, deps]) => deps.length === 0)
    .map(([k]) => k);
  if (roots.length === 0) {
    throw Error("No root resources were found, there is a cycle.");
  }
  // bootstrap our queue with all of the root resources.
  let q: { id: string; level: number }[] = roots.map((c) => ({
    id: c,
    level: 1,
  }));
  let topo: { id: string; level: number }[] = [];
  while (q.length > 0) {
    const { id: current, level } = q.shift()!;

    topo.push({ id: current, level });

    // find all unsatisfied deps (has a dependency left)
    const unsatisfiedDeps = invertedDepGraph[current].filter(
      (d) => depGraph[d].length > 0
    );

    // remove current from all deps
    // return deps that are now satisfied.
    const satisfied = unsatisfiedDeps.filter((dep) => {
      // EWWWWWWW - mutation in a filter, bad sam.
      depGraph[dep] = depGraph[dep].filter((d) => d !== current);
      return depGraph[dep].length === 0;
    });

    // add the level as the level of the parent where it was discovered
    q.push(...satisfied.map((c) => ({ id: c, level: level + 1 })));
  }

  return topo;
}

const emptySet = ImmutableSet<string>([]);

function findCircularReferences(graph: DependencyGraph): string[] {
  const circularReferences: string[] = [];
  for (const [logicalId, references] of Object.entries(graph)) {
    for (const reference of references) {
      const isCircular = transitReference(reference);
      if (isCircular) {
        circularReferences.push(logicalId);
        break;
      }
    }

    function transitReference(
      reference: string,
      seen: ImmutableSet<string> = emptySet
    ): boolean | undefined {
      if (reference === logicalId) {
        return true;
      } else if (seen.has(reference)) {
        // we're walking in circles, there is a circular reference somewhere
        // but this logicalId is not the culprit - one of its transitive dependencies is
        return undefined;
      } else {
        const transitiveReferences = graph[reference];
        if (transitiveReferences === undefined) {
          throw new Error(`reference does not exist: '${reference}'`);
        }
        seen = seen.add(reference);
        for (const transitiveReference of transitiveReferences) {
          const isCircular = transitReference(transitiveReference, seen);
          if (isCircular) {
            return true;
          }
        }
        return false;
      }
    }
  }
  return circularReferences;
}

function findReferences(expr: Expression): string[] {
  if (isIntrinsicFunction(expr)) {
    if (isRef(expr)) {
      if (isPseudoParameter(expr.Ref)) {
        return [];
      }
      return [expr.Ref];
    } else if (isFnGetAtt(expr)) {
      return [expr["Fn::GetAtt"][0]];
    } else if (isFnJoin(expr)) {
      return findReferences(expr["Fn::Join"]);
    } else if (isFnSelect(expr)) {
      return findReferences(expr["Fn::Select"]);
    } else if (isFnSplit(expr)) {
      return findReferences(expr["Fn::Split"]);
    } else if (isFnSub(expr)) {
      return findReferences(expr["Fn::Sub"]);
    } else if (isFnBase64(expr)) {
      return findReferences(expr["Fn::Base64"]);
    }
    // TODO: RuleFunctions
  } else if (!!expr) {
    if (Array.isArray(expr)) {
      return expr.flatMap((e) => findReferences(e));
    } else if (typeof expr === "object") {
      return Object.values(expr).flatMap((e) => findReferences(e));
    }
  }
  return [];
}

/**
 * Return the `logicalId`s from {@link prevState} that do not exist in the {@link desiredState}.
 *
 * @param prevState the previous {@link CloudFormationTemplate} of a {@link Stack}.
 * @param desiredState the new (desired) {@link CloudFormationTemplate} for a {@link Stack}.
 * @returns an array of all `logicalId`s from {@link prevState} that do not exist in the {@link desiredState}.
 */
export function discoverOrphanedDependencies(
  prevState: CloudFormationTemplate,
  desiredState: CloudFormationTemplate
): string[] {
  const oldIds = new Set(Object.keys(prevState.Resources));
  const newIds = new Set(Object.keys(desiredState.Resources));
  return Array.from(oldIds).filter((oldId) => !newIds.has(oldId));
}
