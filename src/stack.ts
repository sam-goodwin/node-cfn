/* eslint-disable @typescript-eslint/no-shadow */
import * as control from "@aws-sdk/client-cloudcontrol";
import * as ssm from "@aws-sdk/client-ssm";

import { compare } from "fast-json-patch";
import { Expression } from "./expression";
import {
  IntrinsicFunction,
  isFnAnd,
  isFnBase64,
  isFnContains,
  isFnEachMemberEquals,
  isFnEachMemberIn,
  isFnEquals,
  isFnFindInMap,
  isFnGetAtt,
  isFnIf,
  isFnJoin,
  isFnNot,
  isFnOr,
  isFnRefAll,
  isFnSelect,
  isFnSplit,
  isFnSub,
  isFnValueOf,
  isFnValueOfAll,
  isIntrinsicFunction,
  isRef,
  isRefString,
  parseRefString,
} from "./function";
import {
  buildDependencyGraph,
  DependencyGraph,
  discoverOrphanedDependencies,
} from "./graph";

import {
  // @ts-ignore - imported for typedoc
  SSMParameterType,
  Parameter,
  ParameterValues,
  validateParameter,
} from "./parameter";
import { isPseudoParameter, PseudoParameter } from "./pseudo-parameter";
import {
  PhysicalResource,
  PhysicalResources,
  LogicalResource,
  PhysicalProperties,
  ResourceType,
  DeletionPolicy,
} from "./resource";
import { Assertion, Rule, RuleFunction, Rules } from "./rule";

import { CloudFormationTemplate } from "./template";
import { isDeepEqual } from "./util";
import { Value } from "./value";

/**
 * A map of each {@link LogicalResource}'s Logical ID to its {@link PhysicalProperties}.
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

export interface UpdateState {
  /**
   * The previous {@link CloudFormationTemplate} which triggered the `Update`.
   *
   * This is `undefined` when a {@link Stack} is first deployed.
   */
  previousState: CloudFormationTemplate | undefined;
  /**
   * The {@link previousState}'s {@link DependencyGraph}.
   */
  previousDependencyGraph: DependencyGraph | undefined;
  /**
   * The new {@link CloudFormationTemplate} which triggered the `Update`.
   *
   * This is `undefined` when a {@link Stack} is being deleted..
   */
  desiredState: CloudFormationTemplate | undefined;
  /**
   * The {@link desiredState}'s {@link DependencyGraph}.
   */
  desiredDependencyGraph: DependencyGraph | undefined;
  /**
   * Input {@link ParameterValues} for the {@link desiredState}'s {@link Parameters}.
   */
  parameterValues?: ParameterValues;
  /**
   * Map of `logicalId` to its {@link Task} in operation.s
   */
  tasks: Tasks;
  /**
   * A Promise to the {@link StackState} output by this Update.
   */
  execute(): Promise<StackState | undefined>;
  /**
   * Call this hook to cancel the {@link UpdateState}.
   */
  cancel(): Promise<StackState | undefined>;
}

export interface Tasks {
  [logicalId: string]: Task;
}

export interface Task {
  resource: Promise<PhysicalResource | undefined>;
  cancellationToken: CancellationToken;
}

class CancellationToken {
  private resolve: ((value: any) => any) | undefined;

  // @ts-ignore - not sure whether we need to support throwing an error in the cancel promise
  private reject: ((err: any) => any) | undefined;

  private readonly promise: Promise<undefined>;

  public isCancelled: boolean = false;

  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      return undefined;
    });
  }

  /**
   * Wait until the {@link Task} associated with this {@link CancellationToken} is Cancelled.
   */
  public waitUntilCancelled() {
    return this.promise;
  }

  /**
   * Begin the process of cancelling this {@link CancellationToken}.
   */
  public cancel() {
    this.isCancelled = true;
  }

  /**
   * The {@link Task} calls this function to report when it has stopped execution.
   */
  public cancelled() {
    if (this.isCancelled) {
      if (this.resolve === undefined) {
        // should be impossible
        throw new Error(`isCancelled is true but resolve is undefined`);
      }
      this.resolve(undefined);
    }
    return undefined;
  }
}

export interface StackProps {
  /**
   * AWS Account.
   */
  readonly account: string;
  /**
   * AWS Region.
   */
  readonly region: string;
  /**
   * Name of the Stack. Must be unique within an {@link account} and {@link region.}
   */
  readonly stackName: string;
  /**
   * Previous Create/Update {@link StackState}. This determines the behavior of the provisioning engine.
   */
  readonly previousState?: StackState;
  /**
   * The {@link control.CloudControlClient} to use when Creating, Updating and Deleting Resources.
   *
   * @default - one is created with default configuration
   */
  readonly controlClient?: control.CloudControlClient;
  /**
   * The {@link ssm.SSMClient} to use when resolving {@link SSMParameterType}
   *
   * @default - one is created with default configuration
   */
  readonly ssmClient?: ssm.SSMClient;
}

/**
 * Manages a {@link CloudFormationStack} deployed to AWS.
 */
export class Stack {
  /**
   * AWS Account.
   */
  readonly account: string;
  /**
   * AWS Region.
   */
  readonly region: string;
  /**
   * Account-wide unique name
   */
  readonly stackName: string;
  /**
   * The {@link control.CloudControlClient} to use when Creating, Updating and Deleting Resources.
   */
  readonly controlClient: control.CloudControlClient;
  /**
   * The {@link ssm.SSMClient} to use when resolving {@link SSMParameterType}
   */
  readonly ssmClient: ssm.SSMClient;

  /**
   * Current {@link StackState} of the {@link Stack}.
   */
  private currentState: StackState | undefined;

  constructor(props: StackProps) {
    this.account = props.account;
    this.region = props.region;
    this.stackName = props.stackName;
    this.currentState = props.previousState;
    this.controlClient =
      props.controlClient ??
      new control.CloudControlClient({
        region: this.region,
      });
    this.ssmClient =
      props.ssmClient ??
      new ssm.SSMClient({
        region: this.region,
      });
  }

  /**
   * @returns the current {@link StackState}.
   */
  public getState() {
    return this.currentState;
  }

  /**
   * Get the {@link PhysicalResource} by its {@link logicalId}.
   *
   * @returns the {@link PhysicalResource} if it exists, otherwise `undefined`.
   */
  private getPhysicalResource(logicalId: string): PhysicalResource | undefined {
    return this.currentState?.resources[logicalId];
  }

  /**
   * Get the {@link LogicalResource} by its {@link logicalId}.
   */
  private getLogicalResource(
    logicalId: string,
    state: UpdateState
  ): LogicalResource {
    const resource =
      state.desiredState?.Resources[logicalId] ??
      state.previousState?.Resources[logicalId];
    if (resource === undefined) {
      throw new Error(`resource does not exist: '${logicalId}'`);
    }
    if (resource.Type === "AWS::DynamoDB::Table") {
      // CloudControl API doesn't support AWS::DynamoDB::Table
      // so as a quick hack, we map it to AWS::DynamoDB::GlobalTable which is supported.
      resource.Type = "AWS::DynamoDB::GlobalTable";
      resource.Properties.Replicas = [
        {
          Region: this.region,
          SSESpecification: resource.Properties.SSESpecification,
        },
      ];
    }
    return resource;
  }

  /**
   * Delete all resources in this Stack.
   */
  public deleteStack(): UpdateState {
    if (this.currentState === undefined) {
      throw new Error(
        `Cannot delete stack '${this.stackName}' since it does not exist.`
      );
    }
    const tasks: Tasks = {};

    const state: UpdateState = {
      previousState: this.currentState.template,
      previousDependencyGraph: buildDependencyGraph(this.currentState.template),
      desiredState: undefined,
      desiredDependencyGraph: undefined,
      tasks,
      execute: async () => {
        // delete all resources in the stack
        await this.deleteResources(
          Object.keys(this.currentState!.resources),
          state
        );

        // set the state to `undefined` - this stack is goneskies
        return (this.currentState = undefined);
      },
      cancel: async () => {
        return null as any;
      },
    };

    return state;
  }

  /**
   * Delete the Resources identified by {@link logicalIds} in order of their dependencies.
   *
   * @param logicalIds list of logicalIds to delete
   * @param state {@link UpdateState} for this Stack Update operation.
   */
  private async deleteResources(logicalIds: string[], state: UpdateState) {
    const allowedLogicalIds = new Set(logicalIds);
    return Promise.all(
      logicalIds.map(async (logicalId) => {
        state.tasks[logicalId] = this.deleteResource(
          logicalId,
          state,
          allowedLogicalIds
        );
      })
    );
  }

  /**
   * Delete a Resource from AWS. Recursively delete its dependencies if there are any.
   *
   * @param logicalId Logical ID of the {@link PhysicalResource} to delete.
   * @param state {@link UpdateState} for this Stack Update operation.
   * @param allowedLogicalIds a set of logicalIds that are allowed to be deleted. This is so that we
   *                          can delete a sub-set of the logicalIds when transiting dependencies,
   *                          for example when deleting orphaned resources during a Stack Update.
   * @returns the {@link PhysicalResource} that was deleted, or `undefined` if there was no Resource.
   */
  private deleteResource(
    logicalId: string,
    state: UpdateState,
    allowedLogicalIds: Set<String>
  ): Task {
    if (logicalId in state.tasks) {
      return state.tasks[logicalId];
    }
    const cancellationToken = new CancellationToken();

    return {
      cancellationToken,
      resource: (async () => {
        const physicalResource = this.getPhysicalResource(logicalId);
        const logicalResource = this.getLogicalResource(logicalId, state);

        if (physicalResource === undefined || logicalResource === undefined) {
          // TODO: should we error here or continue optimistically?
          throw new Error(`Resource does not exist: '${logicalId}'`);
        }

        const deletionPolicy = logicalResource.DeletionPolicy;
        if (
          deletionPolicy === DeletionPolicy.Snapshot ||
          (deletionPolicy === undefined &&
            (physicalResource.Type === "AWS::RDS::DBCluster" ||
              (physicalResource.Type === "AWS::RDS::DBInstance" &&
                logicalResource.Properties.DBClusterIdentifier === undefined)))
        ) {
          // RDS defaults to Snapshot in certain conditions, so we detect them and error here
          // since we don't yet support DeletionPolicy.Snapshot
          throw new Error(`DeletionPolicy.Snapshot is not yet supported`);
        }

        if (
          deletionPolicy === undefined ||
          deletionPolicy === DeletionPolicy.Delete
        ) {
          const dependencies = state.previousDependencyGraph?.[logicalId];

          if (dependencies === undefined) {
            throw new Error(`undefined dependencies`);
          }

          // wait for dependencies to delete before deleting this resource
          await Promise.all(
            dependencies.map(
              (dependency) =>
                this.deleteResource(dependency, state, allowedLogicalIds)
                  .resource
            )
          );

          if (allowedLogicalIds?.has(logicalId) ?? true) {
            // if this logicalId is allowed to be deleted, then delete it
            // nite: we always transit dependencies BEFORE any other action is taken
            const progress = (
              await this.controlClient.send(
                new control.DeleteResourceCommand({
                  TypeName: physicalResource.Type,
                  Identifier: physicalResource.PhysicalId,
                })
              )
            ).ProgressEvent;

            if (progress === undefined) {
              throw new Error(
                `DeleteResourceCommand returned an unefined ProgressEvent`
              );
            }

            return this.waitForProgress(
              logicalId,
              physicalResource.Type,
              physicalResource.InputProperties,
              progress
            );
          } else {
            // we're not allowed to delete it, so skip
            return physicalResource;
          }
        } else if (deletionPolicy === DeletionPolicy.Retain) {
          return physicalResource;
        } else {
          // should never reach here
          throw new Error(`Unsupported: DeletionPolicy.${deletionPolicy}`);
        }
      })(),
    };
  }

  /**
   * Deploy all {@link LogicalResource}s in this {@link CloudFormationStack}
   *
   * @param desiredState a {@link CloudFormationTemplate} describing the Desired State of this {@link Stack}.
   * @param parameterValues input values of the {@link Parameters}.
   * @returns the {@link UpdateState} request.
   */
  public updateStack(
    desiredState: CloudFormationTemplate,
    parameterValues?: ParameterValues
  ): UpdateState {
    const previousState = this.currentState?.template;

    const tasks: Tasks = {};

    const state: UpdateState = {
      previousState: this.currentState?.template,
      previousDependencyGraph: this.currentState?.template
        ? buildDependencyGraph(this.currentState.template)
        : undefined,
      desiredState: desiredState,
      desiredDependencyGraph: buildDependencyGraph(desiredState),
      parameterValues,
      tasks,
      cancel: async () => {
        for (const task of Object.values(tasks)) {
          // trigger the task to cancel
          task.cancellationToken.cancel();
        }

        // wait for tasks to stop executing
        await Promise.all(
          Object.values(tasks).map((task) =>
            task.cancellationToken.waitUntilCancelled()
          )
        );

        // TODO: initiate rollback

        return this.currentState;
      },
      execute: async () => {
        await this.validateParameters(desiredState, parameterValues);
        if (desiredState.Rules) {
          await this.validateRules(desiredState.Rules, state);
        }

        // create new resources
        this.currentState = {
          template: desiredState,
          resources: {
            ...(this.currentState?.resources ?? {}),
            ...(
              await Promise.all(
                Object.keys(desiredState.Resources).map(async (logicalId) => {
                  const resource = await this.updateResource(state, logicalId)
                    .resource;
                  return resource
                    ? {
                        [logicalId]: resource,
                      }
                    : undefined;
                })
              )
            )
              .filter(<T>(a: T): a is Exclude<T, undefined> => a !== undefined)
              .reduce((a, b) => ({ ...a, ...b }), {}),
          },
        };

        // clear tasks
        state.tasks = {};

        // delete orhpanned resources
        const orhpannedLogicalIds =
          previousState === undefined
            ? []
            : discoverOrphanedDependencies(previousState, desiredState);

        await this.deleteResources(orhpannedLogicalIds, state);

        for (const orphanedLogicalId of orhpannedLogicalIds) {
          delete this.currentState?.resources[orphanedLogicalId];
        }

        return this.currentState;
      },
    };

    return state;
  }

  /**
   * Deploy a {@link LogicalResource} to AWS.
   *
   * This Function will recursively deploy any dependent resoruces.
   *
   * TODO: intelligently support rollbacks.
   *
   * @param state the {@link UpdateState} being evaluated.
   * @param logicalId Logical ID of the {@link LogicalResource} to deploy.
   * @returns data describing the {@link PhysicalResource}.
   */
  private updateResource(state: UpdateState, logicalId: string): Task {
    const logicalResource = this.getLogicalResource(logicalId, state);

    if (logicalId in state.tasks) {
      return state.tasks[logicalId];
    } else {
      const cancellationToken = new CancellationToken();

      return (state.tasks[logicalId] = {
        cancellationToken,
        resource: (async () => {
          if (logicalResource.Condition) {
            const conditionRule =
              state.desiredState?.Conditions?.[logicalResource.Condition];
            if (conditionRule === undefined) {
              throw new Error(
                `Condition '${logicalResource.Condition}' does not exist`
              );
            }
            const shouldCreate = await this.evaluateRuleExpressionToBoolean(
              conditionRule,
              state
            );
            if (!shouldCreate) {
              return undefined;
            }
          }

          const properties = (
            await Promise.all(
              Object.entries(logicalResource.Properties).map(
                async ([propName, propExpr]) => {
                  return {
                    [propName]: await this.evaluateExpr(propExpr, state),
                  };
                }
              )
            )
          ).reduce((a, b) => ({ ...a, ...b }), {});

          if (cancellationToken.isCancelled) {
            // check if we should cancel before intiitating CRUD on the resource.
            return cancellationToken.cancelled();
          }

          const physicalResource = this.getPhysicalResource(logicalId);
          let controlApiResult;
          if (physicalResource === undefined) {
            console.log(`Creating ${logicalId} (${logicalResource.Type})`);
            controlApiResult = await this.controlClient.send(
              new control.CreateResourceCommand({
                TypeName: logicalResource.Type,
                DesiredState: JSON.stringify(properties),
              })
            );
          } else {
            const patch = compare(physicalResource.InputProperties, properties);
            if (patch.length === 0) {
              console.log(
                `Skipping Update of ${logicalId} (${logicalResource.Type})`
              );
              return physicalResource;
            }
            console.log(`Updating ${logicalId} (${logicalResource.Type})`);
            controlApiResult = await this.controlClient.send(
              new control.UpdateResourceCommand({
                TypeName: logicalResource.Type,
                PatchDocument: JSON.stringify(patch),
                Identifier: physicalResource.PhysicalId,
              })
            );
          }
          const progress = controlApiResult.ProgressEvent;

          if (progress === undefined) {
            throw new Error(
              `DeleteResourceCommand returned an unefined ProgressEvent`
            );
          }

          return this.waitForProgress(
            logicalId,
            logicalResource.Type,
            properties,
            progress,
            cancellationToken
          );
        })(),
      });
    }
  }

  /**
   * Wait for the Resource Create/Update/Delete request to conclude.
   *
   * @param logicalId ID of the {@link LogicalResource}.
   * @param type the {@link LogicalResource} Type.
   * @param properties the input {@link PhysicalProperties}
   * @param progress a {@link control.ProgressEvent}
   * @param cancellationToken a {@link CancellationToken} for interrupting this task midway through completion.
   * @returns the {@link PhysicalResource} if the task completes successfully, otherwise `undefined`.
   */
  private async waitForProgress(
    logicalId: string,
    type: ResourceType,
    properties: PhysicalProperties,
    progress: control.ProgressEvent,
    cancellationToken?: CancellationToken
  ): Promise<PhysicalResource | undefined> {
    do {
      const opStatus = progress?.OperationStatus;
      if (opStatus === "SUCCESS") {
        console.log(`${progress.Operation} Success: ${logicalId} (${type})`);
        const attributes =
          progress.Operation === "DELETE"
            ? undefined
            : (
                await this.controlClient.send(
                  new control.GetResourceCommand({
                    TypeName: progress.TypeName,
                    Identifier: progress.Identifier!,
                  })
                )
              ).ResourceDescription?.Properties;

        return {
          Type: type,
          PhysicalId: progress?.Identifier!,
          InputProperties: properties,
          Attributes: attributes ? JSON.parse(attributes) : {},
        };
      } else if (opStatus === "FAILED") {
        const errorMessage = `Failed to ${
          progress.Operation ?? "Update"
        } ${logicalId} (${type})${
          progress.StatusMessage ? ` ${progress.StatusMessage}` : ""
        }`;
        console.log(errorMessage);
        throw new Error(errorMessage);
      }

      try {
        progress = (
          await this.controlClient.send(
            new control.GetResourceRequestStatusCommand({
              RequestToken: progress?.RequestToken,
            })
          )
        ).ProgressEvent!;
      } catch (err) {
        console.error(err);
        throw err;
      }

      if (cancellationToken?.isCancelled) {
        // try and cancel the operation before giving the task more time to finish
        const cancelEvent = (
          await this.controlClient.send(
            new control.CancelResourceRequestCommand({
              RequestToken: progress?.RequestToken,
            })
          )
        ).ProgressEvent;

        if (cancelEvent) {
          try {
            await this.waitForProgress(
              logicalId,
              type,
              properties,
              cancelEvent
            );
          } catch (err) {
            // what to do?
            throw err;
          }
        } else {
          //
        }
      }

      const retryAfter = progress?.RetryAfter?.getTime();
      const waitTime = Math.max(
        retryAfter ? retryAfter - Date.now() : 1000,
        1000
      );
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    } while (true);
  }

  /**
   * Evaluates an {@link Expression} to a {@link PhysicalProperty}.
   *
   * This property may come from evaluating an intrinsic function or by fetching
   * an attribute from a physically deployed resource.
   *
   * @param expr expression to evaluate
   * @param state the {@link UpdateState} being evaluated
   * @returns the physical property as a primitive JSON object
   */
  private async evaluateExpr(
    expr: Expression,
    state: UpdateState
  ): Promise<Value> {
    if (expr === undefined || expr === null) {
      return expr;
    } else if (isIntrinsicFunction(expr)) {
      return this.evaluateIntrinsicFunction(state, expr);
    } else if (typeof expr === "string") {
      if (isRefString(expr)) {
        return this.evaluateIntrinsicFunction(state, parseRefString(expr));
      } else if (isPseudoParameter(expr)) {
        return this.evaluatePseudoParameter(expr);
      } else {
        return expr;
      }
    } else if (Array.isArray(expr)) {
      return Promise.all(expr.map((e) => this.evaluateExpr(e, state)));
    } else if (typeof expr === "object") {
      return (
        await Promise.all(
          Object.entries(expr).map(async ([k, v]) => ({
            [k]: await this.evaluateExpr(v, state),
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
    state: UpdateState,
    expr: IntrinsicFunction
  ): Promise<Value> {
    const parameters = state.desiredState?.Parameters ?? {};
    const parameterValues = state.parameterValues ?? {};

    if (isRef(expr)) {
      const paramDef = parameters[expr.Ref];
      if (paramDef !== undefined) {
        return this.evaluateParameter(state, expr.Ref, paramDef);
      } else {
        return (await this.updateResource(state, expr.Ref).resource)
          ?.PhysicalId;
      }
    } else if (isFnGetAtt(expr)) {
      const [logicalId, attributeName] = expr["Fn::GetAtt"];
      const resource = await this.updateResource(state, logicalId).resource;
      if (resource === undefined) {
        throw new Error(
          `Resource '${logicalId}' does not exist, perhaps a Condition is preventing it from being created?`
        );
      }
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
          values.map((value) => this.evaluateExpr(value, state))
        )
      ).join(delimiter);
    } else if (isFnSelect(expr)) {
      const [index, listOfObjects] = expr["Fn::Select"];
      if (index in listOfObjects) {
        return this.evaluateExpr(listOfObjects[index], state);
      } else {
        throw new Error(
          `index ${index} out of bounds in list: ${listOfObjects}`
        );
      }
    } else if (isFnSplit(expr)) {
      const [delimiter, sourceStringExpr] = expr["Fn::Split"];
      const sourceString = await this.evaluateExpr(sourceStringExpr, state);
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
          const resolvedVal = await this.evaluateExpr(varVal, state);
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
      const exprVal = await this.evaluateExpr(expr["Fn::Base64"], state);
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
        this.evaluateExpr(topLevelKeyExpr, state),
        this.evaluateExpr(secondLevelKeyExpr, state),
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
        state.desiredState?.Mappings?.[mapName]?.[topLevelKey]?.[
          secondLevelKey
        ];
      if (value === undefined) {
        throw new Error(
          `Could not find map value: ${mapName}.${topLevelKey}.${secondLevelKey}`
        );
      }
      return value;
    } else if (isFnRefAll(expr)) {
      return Object.entries(parameters)
        .map(([paramName, paramDef]) =>
          paramDef.Type === expr["Fn::RefAll"]
            ? parameterValues[paramName]
            : undefined
        )
        .filter((paramVal) => paramVal !== undefined);
    } else if (isFnEquals(expr)) {
      const [left, right] = await Promise.all(
        expr["Fn::Equals"].map((expr) => this.evaluateExpr(expr, state))
      );
      return isDeepEqual(left, right);
    } else if (isFnNot(expr)) {
      const [condition] = await Promise.all(
        expr["Fn::Not"].map((expr) => this.evaluateExpr(expr, state))
      );
      if (typeof condition === "boolean") {
        return !condition;
      } else {
        throw new Error(
          `Malformed input to Fn::Not - expected a boolean but received ${typeof condition}`
        );
      }
    } else if (isFnAnd(expr)) {
      if (expr["Fn::And"].length === 0) {
        throw new Error(
          `Malformed input to Fn::And - your must provide at least one [{condition}].`
        );
      }
      return (
        await Promise.all(
          expr["Fn::And"].map((expr) => this.evaluateExpr(expr, state))
        )
      ).reduce((a, b) => {
        if (typeof b !== "boolean") {
          throw new Error(
            `Malformed input to Fn::And - expected a boolean but received ${typeof b}`
          );
        }
        return a && b;
      }, true);
    } else if (isFnOr(expr)) {
      if (expr["Fn::Or"].length === 0) {
        throw new Error(
          `Malformed input to Fn::Or - your must provide at least one [{condition}].`
        );
      }
      return (
        await Promise.all(
          expr["Fn::Or"].map((expr) => this.evaluateExpr(expr, state))
        )
      ).reduce((a, b) => {
        if (typeof b !== "boolean") {
          throw new Error(
            `Malformed input to Fn::Or - expected a boolean but received ${typeof b}`
          );
        }
        return a || b;
      }, false);
    } else if (isFnContains(expr)) {
      const [listOfStrings, string] = await Promise.all(
        expr["Fn::Contains"].map((expr) => this.evaluateExpr(expr, state))
      );

      assertIsListOfStrings(listOfStrings, "listOfStrings");
      assertIsString(string, "string");

      return listOfStrings.includes(string);
    } else if (isFnEachMemberEquals(expr)) {
      const [listOfStrings, string] = await Promise.all(
        expr["Fn::EachMemberEquals"].map((expr) =>
          this.evaluateExpr(expr, state)
        )
      );

      assertIsListOfStrings(listOfStrings, "listOfStrings");
      assertIsString(string, "string");

      return listOfStrings.find((s) => s !== string) === undefined;
    } else if (isFnEachMemberIn(expr)) {
      const [stringsToCheck, stringsToMatch] = await Promise.all(
        expr["Fn::EachMemberIn"].map((expr) => this.evaluateExpr(expr, state))
      );

      assertIsListOfStrings(stringsToCheck, "stringsToCheck");
      assertIsListOfStrings(stringsToMatch, "stringsToMatch");

      return stringsToCheck.find(
        (check) => stringsToMatch.find((match) => check === match) !== undefined
      );
    } else if (isFnValueOf(expr)) {
      throw new Error("Fn::ValueOf is not yet supported");
    } else if (isFnValueOfAll(expr)) {
      throw new Error("Fn::ValueOfAll is not yet supported");
    } else if (isFnIf(expr)) {
      const [whenExpr, thenExpr, elseExpr] = expr["Fn::If"];

      const when = await this.evaluateExpr(whenExpr, state);
      if (when === true) {
        return this.evaluateExpr(thenExpr, state);
      } else if (when === false) {
        return this.evaluateExpr(elseExpr, state);
      } else {
        throw new Error(`invalid value for 'condition' in Fn:If: ${whenExpr}`);
      }
    }

    throw new Error(
      `expression not implemented: ${Object.keys(expr).join(",")}`
    );
  }

  /**
   * Evaluate a {@link PseudoParameter} and return its value.
   *
   * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/pseudo-parameter-reference.html
   */
  private evaluatePseudoParameter(expr: PseudoParameter) {
    if (expr === "AWS::AccountId") {
      return this.account;
    } else if (expr === "AWS::NoValue") {
      return null;
    } else if (expr === "AWS::Region") {
      return this.region;
    } else if (expr === "AWS::Partition") {
      // gov regions are not supported
      return "aws";
    } else if (expr === "AWS::NotificationARNs") {
      // don't yet support sending notifications to SNS
      // on top of supporting this, we could also provide native JS hooks into the engine
      return [];
    } else if (expr === "AWS::StackId") {
      return this.stackName;
    } else if (expr === "AWS::StackName") {
      return this.stackName;
    } else {
      throw new Error(`unsupported Pseudo Parameter '${expr}'`);
    }
  }

  /**
   * Determine the value of a {@link paramName}.
   *
   * If the {@link Parameter} is a {@link SSMParameterType} then the value is fetched
   * from AWS Systems Manager Parameter Store.
   *
   * The {@link CloudFormationTemplate}'s {@link Parameter}s and the input {@link ParameterValues}
   * are assumed to be valid because the {@link validateParameters} function is called by
   * {@link updateStack}.
   *
   * @param state {@link UpdateState} being evaluated.
   * @param paramName name of the {@link Parameter}.
   * @param paramDef the {@link Parameter} definition in the source {@link CloudFormationTemplate}.
   */
  private async evaluateParameter(
    state: UpdateState,
    paramName: string,
    paramDef: Parameter
  ): Promise<Value> {
    let paramVal = state.parameterValues?.[paramName];
    if (paramVal === undefined) {
      if (paramDef.Default !== undefined) {
        paramVal = paramDef.Default;
      } else {
        throw new Error(`Missing required input-Parameter ${paramName}`);
      }
    }

    const type = paramDef.Type;

    if (type === "String" || type === "Number") {
      return paramVal;
    } else if (type === "CommaDelimitedList") {
      return (paramVal as string).split(",");
    } else if (type === "List<Number>") {
      return (paramVal as string).split(",").map((s) => parseInt(s, 10));
    } else if (
      type.startsWith("AWS::EC2") ||
      type.startsWith("AWS::Route53") ||
      type.startsWith("List<AWS::EC2") ||
      type.startsWith("List<AWS::Route53")
    ) {
      return paramVal;
    } else if (type.startsWith("AWS::SSM")) {
      try {
        const ssmParamVal = await this.ssmClient.send(
          new ssm.GetParameterCommand({
            Name: paramVal as string,
            WithDecryption: true,
          })
        );

        if (
          ssmParamVal.Parameter?.Name === undefined ||
          ssmParamVal.Parameter.Value === undefined
        ) {
          throw new Error(`GetParameter '${paramVal}' returned undefined`);
        }

        if (type === "AWS::SSM::Parameter::Name") {
          return ssmParamVal.Parameter.Name;
        } else if (type === "AWS::SSM::Parameter::Value<String>") {
          if (ssmParamVal.Parameter.Type !== "String") {
            throw new Error(
              `Expected SSM Parameter ${paramVal} to be ${type} but was ${ssmParamVal.Parameter.Type}`
            );
          }
          return ssmParamVal.Parameter.Value;
        } else if (
          type === "AWS::SSM::Parameter::Value<List<String>>" ||
          type.startsWith("AWS::SSM::Parameter::Value<List<")
        ) {
          if (ssmParamVal.Parameter.Type !== "StringList") {
            throw new Error(
              `Expected SSM Parameter ${paramVal} to be ${type} but was ${ssmParamVal.Parameter.Type}`
            );
          }
          return ssmParamVal.Parameter.Value.split(",");
        } else {
        }
      } catch (err) {
        throw err;
      }
    }

    return paramVal;
  }

  /**
   * Validate the {@link parameterValues} against the {@link Parameter} defintiions in the {@link template}.
   *
   * @param template the {@link CloudFormationTemplate}
   * @param parameterValues input {@link ParameterValues}.
   */
  private async validateParameters(
    template: CloudFormationTemplate,
    parameterValues: ParameterValues | undefined
  ) {
    if (template.Parameters === undefined) {
      if (
        parameterValues !== undefined &&
        Object.keys(parameterValues).length > 0
      ) {
        throw new Error(
          `the template accepts no Parameters, but Parameters were passed to the Template`
        );
      }
    } else {
      for (const [paramName, paramDef] of Object.entries(template.Parameters)) {
        const paramVal = parameterValues?.[paramName];

        validateParameter(paramName, paramDef, paramVal);
      }
    }
  }

  /**
   * Validate the {@link Rules} section of a {@link CloudFormationTemplate}.
   *
   * For each {@link Rule}, validate that the {@link parameterValues} comply with the {@link Assertions}.
   *
   * @param rules the {@link Rules} section of a {@link CloudFormationTemplate}.
   * @param state the {@link UpdateState} of the current evaluation.
   */
  private async validateRules(rules: Rules, state: UpdateState) {
    const errors = (
      await Promise.all(
        Object.entries(rules).map(async ([ruleId, rule]) =>
          (
            await this.evaluateRule(rule, state)
          ).map(
            (errorMessage) =>
              `Rule '${ruleId}' failed vaidation: ${errorMessage}`
          )
        )
      )
    ).reduce((a, b) => a.concat(b), []);

    if (errors.length > 0) {
      throw new Error(errors.join("\n"));
    }
  }

  /**
   * Evaluates a {@link Rule} and returns an array of {@link Assertion} errors.
   *
   * @param rule the {@link Rule} to evaluate.
   * @param state the {@link UpdateState} of the current evaluation.
   * @returns an array of {@link Assertion} errors.
   */
  private async evaluateRule(
    rule: Rule,
    state: UpdateState
  ): Promise<string[]> {
    if (
      rule.RuleCondition === undefined ||
      (await this.evaluateRuleExpressionToBoolean(rule.RuleCondition, state))
    ) {
      return (
        await Promise.all(
          rule.Assertions.map(async (assertion) => {
            const error = await this.evaluateAssertion(assertion, state);
            return error ? [error] : [];
          })
        )
      ).reduce((a, b) => a.concat(b), []);
    } else {
      return [];
    }
  }

  /**
   * Evalautes an {@link Assertion} against a {@link CloudFormationTemplate}'s {@link Parameters}.
   *
   * @param assertion the {@link Assertion} condition to evaluate.
   * @param state the {@link UpdateState} of the current evaluation.
   * @returns an array of {@link Assertion} errors.
   */
  private async evaluateAssertion(
    assertion: Assertion,
    state: UpdateState
  ): Promise<string | undefined> {
    if (
      !(await this.evaluateRuleExpressionToBoolean(assertion.Assert, state))
    ) {
      return assertion.AssertDescription ?? JSON.stringify(assertion.Assert);
    } else {
      return undefined;
    }
  }

  /**
   * Evaluate a {@link RuleFunction} to a `boolean`.
   *
   * @param rule the {@link RuleFunction} to evaluate.
   * @param state the {@link UpdateState} of the current evaluation.
   * @returns the evaluated `boolean` value of the {@link rule}.
   * @throws an Error if the {@link rule} does not evaluate to a `boolean`.
   */
  private async evaluateRuleExpressionToBoolean(
    rule: RuleFunction,
    state: UpdateState
  ): Promise<boolean> {
    const result = await this.evaluateExpr(rule, state);
    if (typeof result === "boolean") {
      return result;
    } else {
      throw new Error(
        `rule must evaluate to a Boolean, but evalauted to ${typeof result}`
      );
    }
  }
}

function assertIsString(
  string: any,
  argumentName: string
): asserts string is string {
  if (typeof string !== "string") {
    throw new Error(
      `The ${argumentName} must be a string, but was ${typeof string}`
    );
  }
}

function assertIsListOfStrings(
  strings: any,
  argumentName: string
): asserts strings is string[] {
  if (
    !Array.isArray(strings) ||
    strings.find((s) => typeof s !== "string") !== undefined
  ) {
    throw new Error(
      `The ${argumentName} argument must be a list of strings, but was ${typeof strings}`
    );
  } else if (strings.length === 0) {
    throw new Error(`The ${argumentName} cannot be empty.`);
  }
}
