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
    const references: string[] = [];
    for (const propExpr of Object.values(resource.Properties)) {
      references.push(...findReferences(propExpr));
    }
    graph[logicalId] = Array.from(new Set(references));
  }

  const circularReferences = findCircularReferences(graph);
  if (circularReferences.length > 0) {
    throw new Error(
      `circular references detected: ${circularReferences.join(",")}`
    );
  }

  return graph;
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
      return [expr.Ref];
    } else if (isFnGetAtt(expr)) {
      return [expr["Fn::GetAtt"][0]];
    } else if (isFnJoin(expr)) {
      return expr["Fn::Join"][1].flatMap(findReferences);
    } else if (isFnSelect(expr)) {
      return expr["Fn::Select"][1].flatMap(findReferences);
    } else if (isFnSplit(expr)) {
      return findReferences(expr["Fn::Split"][1]);
    } else if (isFnSub(expr)) {
      return Object.values(expr["Fn::Sub"][1]).flatMap(findReferences);
    } else if (isFnBase64(expr)) {
      return findReferences(expr["Fn::Base64"]);
    }
  }
  return [];
}
