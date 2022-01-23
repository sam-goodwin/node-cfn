import {
  CloudControlClient,
  CreateResourceCommand,
  DeleteResourceCommand,
  UpdateResourceCommand,
} from "@aws-sdk/client-cloudcontrol";

import * as control from "@aws-sdk/client-cloudcontrol";

import { compare } from "fast-json-patch";
import { Expression } from "./expression";
import {
  IntrinsicFunction,
  isFnBase64,
  isFnFindInMap,
  isFnGetAtt,
  isFnJoin,
  isFnSelect,
  isFnSplit,
  isFnSub,
  isIntrinsicFunction,
  isRef,
} from "./function";
import { buildDependencyGraph, DependencyGraph } from "./graph";
import {
  PhysicalProperty,
  PhysicalResource,
  PhysicalResources,
  Resource,
} from "./resource";
import { CloudFormationTemplate, validateTemplate } from "./template";

const client = new CloudControlClient({});

/**
 * A map of each {@link Resource}'s Logical ID to its {@link PhysicalProperties}.
 */
export interface StackState {
  /**
   * The {@link CloudFormationTemplate} used to create this {@link StackState}.
   */
  template: CloudFormationTemplate;
  /**
   * Map of the provisioned {@link PhysicalResources} addressable by their Logical ID.
   */
  resources: PhysicalResources;
}

/**
 * Manages a {@link CloudFormationStack} deployed to AWS.
 */
export class Stack {
  // private readonly dependencyGraph: DependencyGraph;

  private readonly physicalResources: {
    [logicalId: string]: Promise<PhysicalResource>;
  } = {};

  private readonly deletedResources: {
    [logicalId: string]: Promise<PhysicalResource>;
  } = {};

  private state: StackState | undefined;

  constructor(readonly stackName: string, previousState?: StackState) {
    this.state = previousState;
  }

  /**
   * Delete all resources in this Stack.
   *
   * @returns
   */
  public async deleteStack(): Promise<void> {
    if (this.state === undefined) {
      throw new Error(
        `Cannot delete stack '${this.stackName}' - it does not exist.`
      );
    }
    const dependencyGraph = buildDependencyGraph(this.state!.template);

    await Promise.all(
      Object.keys(this.state.resources).map(async (logicalId) =>
        this.deleteResource(logicalId, dependencyGraph)
      )
    );
    this.state = undefined;
  }

  private async deleteResource(
    logicalId: string,
    dependencyGraph: DependencyGraph
  ) {
    if (logicalId in this.deletedResources) {
      return this.deletedResources[logicalId];
    }

    const resource = this.getPhysicalResource(logicalId);
    if (resource === undefined) {
      throw new Error(`Resource does not exist: '${logicalId}'`);
    }

    const dependencies = dependencyGraph[logicalId];
    // wait for dependencies to delete before deleting this resource
    await Promise.all(
      dependencies.map((dependency) =>
        this.deleteResource(dependency, dependencyGraph)
      )
    );

    const progress = (
      await client.send(
        new DeleteResourceCommand({
          TypeName: resource.Type,
          Identifier: resource.PhysicalId,
        })
      )
    ).ProgressEvent;

    if (progress === undefined) {
      throw new Error(
        `DeleteResourceCommand returned an unefined ProgressEvent`
      );
    }

    return this.waitForProgress(logicalId, resource, progress);
  }

  /**
   * Deploy all {@link Resource}s in this {@link CloudFormationStack}
   *
   * @returns the new {@link StackState}.
   */
  public async updateStack(
    template: CloudFormationTemplate
  ): Promise<StackState> {
    validateTemplate(template);
    return (this.state = {
      template,
      resources: (
        await Promise.all(
          Object.keys(template.Resources).map(async (logicalId) => ({
            [logicalId]: await this.updateResource(template, logicalId),
          }))
        )
      ).reduce((a, b) => ({ ...a, ...b }), {}),
    });
  }

  /**
   * Deploy a {@link Resource} to AWS.
   *
   * This Function will recursively deploy any dependent resoruces.
   *
   * TODO: intelligently support rollbacks.
   *
   * @param template the {@link CloudFormationTemplate} being evaluated.
   * @param logicalId Logical ID of the {@link Resource} to deploy.
   * @returns data describing the {@link PhysicalResource}.
   */
  private async updateResource(
    template: CloudFormationTemplate,
    logicalId: string
  ): Promise<PhysicalResource> {
    const logicalResource = this.getResource(template, logicalId);
    if (logicalId in this.physicalResources) {
      return this.physicalResources[logicalId];
    } else {
      return (this.physicalResources[logicalId] = (async () => {
        const properties = (
          await Promise.all(
            Object.entries(logicalResource.Properties).map(
              async ([propName, propExpr]) => {
                return {
                  [propName]: await this.evaluateExpr(template, propExpr),
                };
              }
            )
          )
        ).reduce((a, b) => ({ ...a, ...b }), {});

        const physicalResource = this.getPhysicalResource(logicalId);
        const progress = (
          physicalResource === undefined
            ? await client.send(
                new CreateResourceCommand({
                  TypeName: logicalResource.Type,
                  DesiredState: JSON.stringify(properties),
                })
              )
            : await client.send(
                new UpdateResourceCommand({
                  TypeName: logicalResource.Type,
                  PatchDocument: JSON.stringify(
                    // TODO: only perform update if there is a change
                    compare(physicalResource.Attributes, properties)
                  ),
                  Identifier: physicalResource.PhysicalId,
                })
              )
        ).ProgressEvent;

        if (progress === undefined) {
          throw new Error(
            `DeleteResourceCommand returned an unefined ProgressEvent`
          );
        }

        return this.waitForProgress(logicalId, logicalResource, progress);
      })());
    }
  }

  private async waitForProgress(
    logicalId: string,
    resource: Resource | PhysicalResource,
    progress: control.ProgressEvent
  ): Promise<PhysicalResource> {
    do {
      console.log(`${progress.OperationStatus} ${logicalId}`);
      const opStatus = progress?.OperationStatus;
      if (opStatus === "SUCCESS") {
        return {
          Type: resource.Type,
          PhysicalId: progress?.Identifier!,
          Attributes: JSON.parse(progress?.ResourceModel ?? "{}"),
        };
      } else if (opStatus === "FAILED") {
        throw new Error(
          progress?.StatusMessage ?? `failed to deploy resource: '${logicalId}'`
        );
      }

      try {
        progress = (
          await client.send(
            new control.GetResourceRequestStatusCommand({
              RequestToken: progress?.RequestToken,
            })
          )
        ).ProgressEvent!;
      } catch (err) {
        console.error(err);
        throw err;
      }

      const retryAfter = progress?.RetryAfter?.getTime();
      const waitTime = retryAfter ? retryAfter - Date.now() : 1000;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    } while (true);
  }

  /**
   * Evaluates an {@link Expression} to a {@link PhysicalProperty}.
   *
   * This property may come from evaluating an intrinsic function or by fetching
   * an attribute from a physically deployed resource.
   *
   * @param template the {@link CloudFormationTemplate} being evaluated
   * @param expr expression to evaluate
   * @returns the physical property as a primitive JSON object
   */
  private async evaluateExpr(
    template: CloudFormationTemplate,
    expr: Expression
  ): Promise<PhysicalProperty> {
    if (expr === undefined || expr === null) {
      return expr;
    } else if (isIntrinsicFunction(expr)) {
      return this.evaluateIntrinsicFunction(template, expr);
    } else if (typeof expr === "string" && expr.startsWith("!Ref ")) {
      return this.evaluateIntrinsicFunction(template, {
        Ref: expr.substring("!Ref ".length),
      });
    } else if (Array.isArray(expr)) {
      return Promise.all(expr.map((e) => this.evaluateExpr(template, e)));
    } else if (typeof expr === "object") {
      return (
        await Promise.all(
          Object.entries(expr).map(async ([k, v]) => ({
            [k]: await this.evaluateExpr(template, v),
          }))
        )
      ).reduce((a, b) => ({ ...a, ...b }), {});
    } else {
      return expr;
    }
  }

  /**
   * Evaluate a CloudFormation {@link IntrinsicFunction} to a {@link PhysicalProperty}.
   *
   * @param expr intrinsic function expression
   * @returns the physical value of the function
   */
  private async evaluateIntrinsicFunction(
    template: CloudFormationTemplate,
    expr: IntrinsicFunction
  ): Promise<PhysicalProperty> {
    if (isRef(expr)) {
      return (await this.updateResource(template, expr.Ref)).PhysicalId;
    } else if (isFnGetAtt(expr)) {
      const [logicalId, attributeName] = expr["Fn::GetAtt"];
      const resource = await this.updateResource(template, logicalId);
      const attributeValue = resource.Attributes[attributeName];
      if (attributeValue === undefined) {
        throw new Error(
          `attribute '${attributeName}' does not exist on resource '${logicalId}' of type '${resource.Type}'`
        );
      }
      return attributeValue;
    } else if (isFnJoin(expr)) {
      const [delimiter, values] = expr["Fn::Join"];
      return (
        await Promise.all(
          values.map((value) => this.evaluateExpr(template, value))
        )
      ).join(delimiter);
    } else if (isFnSelect(expr)) {
      const [index, listOfObjects] = expr["Fn::Select"];
      if (index in listOfObjects) {
        return this.evaluateExpr(template, listOfObjects[index]);
      } else {
        throw new Error(
          `index ${index} out of bounds in list: ${listOfObjects}`
        );
      }
    } else if (isFnSplit(expr)) {
      const [delimiter, sourceStringExpr] = expr["Fn::Split"];
      const sourceString = await this.evaluateExpr(template, sourceStringExpr);
      if (typeof sourceString !== "string") {
        throw new Error(
          `Fn::Split must operate on a String, but received: ${typeof sourceString}`
        );
      }
      return sourceString.split(delimiter);
    } else if (isFnSub(expr)) {
      const [string, variables] = expr["Fn::Sub"];
      let result = string;
      await Promise.all(
        Object.entries(variables).map(async ([varName, varVal]) => {
          const resolvedVal = await this.evaluateExpr(template, varVal);
          if (
            typeof resolvedVal === "string" ||
            typeof resolvedVal === "number" ||
            typeof resolvedVal === "boolean"
          ) {
            result = result.replace(`$${varName}`, resolvedVal.toString());
          } else {
            throw new Error(
              `Variable '${varName}' in Fn::Sub did not resolve to a String, Number or Boolean`
            );
          }
        })
      );
      return result;
    } else if (isFnBase64(expr)) {
      const exprVal = await this.evaluateExpr(template, expr["Fn::Base64"]);
      if (typeof exprVal === "string") {
        return Buffer.from(exprVal, "utf8").toString("base64");
      } else {
        throw new Error(
          `Fn::Base64 can only convert String values to Base64, but got '${typeof exprVal}'`
        );
      }
    } else if (isFnFindInMap(expr)) {
      const [mapName, topLevelKeyExpr, secondLevelKeyExpr] =
        expr["Fn::FindInMap"];

      const [topLevelKey, secondLevelKey] = await Promise.all([
        this.evaluateExpr(template, topLevelKeyExpr),
        this.evaluateExpr(template, secondLevelKeyExpr),
      ]);
      if (typeof topLevelKey !== "string") {
        throw new Error(
          `The topLevelKey in Fn::FindInMap must be a string, but got ${typeof topLevelKeyExpr}`
        );
      }
      if (typeof secondLevelKey !== "string") {
        throw new Error(
          `The secondLevelKey in Fn::FindInMap must be a string, but got ${typeof secondLevelKeyExpr}`
        );
      }
      const value =
        template.Mappings?.[mapName]?.[topLevelKey]?.[secondLevelKey];
      if (value === undefined) {
        throw new Error(
          `Could not find map value: ${mapName}.${topLevelKey}.${secondLevelKey}`
        );
      }
      return value;
    }

    throw new Error(
      `expression not implemented: ${Object.keys(expr).join(",")}`
    );
  }

  /**
   * Get the {@link Resource} by its {@link logicalId}.
   */
  private getResource(
    template: CloudFormationTemplate,
    logicalId: string
  ): Resource {
    const resource = template.Resources[logicalId];
    if (resource === undefined) {
      throw new Error(`resource does not exist: '${logicalId}'`);
    }
    return resource;
  }

  /**
   * Get the {@link PhysicalResource} by its {@link logicalId}.
   *
   * @returns the {@link PhysicalResource} if it exists, otherwise `undefined`.
   */
  private getPhysicalResource(logicalId: string): PhysicalResource | undefined {
    return this.state?.resources[logicalId];
  }
}
