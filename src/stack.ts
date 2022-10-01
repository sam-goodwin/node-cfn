/* eslint-disable @typescript-eslint/no-shadow */
import * as control from "@aws-sdk/client-cloudcontrol";
import * as ssm from "@aws-sdk/client-ssm";
import * as events from "@aws-sdk/client-eventbridge";
import * as sqs from "@aws-sdk/client-sqs";
import * as iam from "@aws-sdk/client-iam";

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
  ResourceType,
  DeletionPolicy,
  PhysicalProperties,
} from "./resource";
import { Assertion, Rule, RuleFunction, Rules } from "./rule";

import { CloudFormationTemplate } from "./template";
import { isDeepEqual } from "./util";
import { Value } from "./value";
import { AssetManifest, AssetPublishing } from "cdk-assets";
import AwsClient from "./aws";
import {
  EventBusRuleResource,
  ManagedPolicyResource,
  PolicyResource,
  SQSQueuePolicyResource,
} from "./resource-types";

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
  /**
   * Outputs of the stack
   */
  outputs: Record<string, string>;
}

export interface Module {
  // the process which when complete, evaluates the resource
  resource: Promise<PhysicalResource | undefined>;
  operation?: "UPDATE" | "CREATE" | "DELETE";
  processTime?: number;
  start?: Date;
  end?: Date;
  dependencies: string[];
  type?: string;
  name: string;
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
   * Map of `logicalId` to a task ({@link Promise}) resolving the new state of the {@link PhysicalResource}.
   */
  modules: {
    [logicalId: string]: Module;
  };
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
  /**
   * SDK config used to create new clients.
   *
   * TODO: fix this...
   */
  readonly sdkConfig?: any;
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
  readonly eventBridgeClient: events.EventBridgeClient;
  readonly sqsClient: sqs.SQSClient;
  readonly iamClient: iam.IAMClient;

  /**
   * Current {@link StackState} of the {@link Stack}.
   */
  private state: StackState | undefined;

  private awsClient: AwsClient;

  constructor(props: StackProps) {
    this.awsClient = new AwsClient(
      props.account,
      props.region,
      props.sdkConfig
    );
    this.account = props.account;
    this.region = props.region;
    this.stackName = props.stackName;
    this.state = props.previousState;
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
    this.eventBridgeClient = new events.EventBridgeClient(props.sdkConfig);
    this.iamClient = new iam.IAMClient(props.sdkConfig);
    this.sqsClient = new sqs.SQSClient(props.sdkConfig);
  }

  /**
   * @returns the current {@link StackState}.
   */
  public getState() {
    return this.state;
  }

  /**
   * Get the {@link PhysicalResource} by its {@link logicalId}.
   *
   * @returns the {@link PhysicalResource} if it exists, otherwise `undefined`.
   */
  private getPhysicalResource(logicalId: string): PhysicalResource | undefined {
    return this.state?.resources[logicalId];
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
    return resource;
  }

  /**
   * Delete all resources in this Stack.
   */
  public async deleteStack(): Promise<void> {
    if (this.state === undefined) {
      throw new Error(
        `Cannot delete stack '${this.stackName}' since it does not exist.`
      );
    }
    const state: UpdateState = {
      previousState: this.state.template,
      previousDependencyGraph: buildDependencyGraph(this.state.template),
      desiredState: undefined,
      desiredDependencyGraph: undefined,
      modules: {}, // initialize with empty state
    };

    // delete all resources in the stack
    await this.deleteResources(Object.keys(this.state.resources), state);

    // set the state to `undefined` - this stack is goneskies
    this.state = undefined;
  }

  /**
   * Delete the Resources identified by {@link logicalIds} in order of their dependencies.
   *
   * @param logicalIds list of logicalIds to delete
   * @param state {@link UpdateState} for this Stack Update operation.
   */
  private async deleteResources(logicalIds: string[], state: UpdateState) {
    const allowedLogicalIds = new Set(logicalIds);
    return logicalIds.map((logicalId) =>
      this.deleteResource(logicalId, state, allowedLogicalIds)
    );
  }

  private startProcessModule(
    logicalId: string,
    operation: "UPDATE" | "CREATE" | "DELETE" | undefined,
    state: UpdateState,
    type: string | undefined,
    operationTask: (start: Date) => Promise<{
      processTime: number;
      resource: PhysicalResource | undefined;
    }>
  ): Module {
    if (state.modules[logicalId]) {
      throw new Error("LogcalId started with two operations.");
    } else {
      const start = new Date();
      return (state.modules[logicalId] = {
        start: start,
        resource: operationTask(start).then((x) => {
          state.modules[logicalId] = {
            ...state.modules[logicalId],
            end: new Date(),
            processTime: x.processTime,
          };
          return x.resource;
        }),
        dependencies: [],
        operation,
        type,
        name: logicalId,
      });
    }
  }

  /**
   * Padding module is used to delay the completion of the deployment until after X time
   * after a resource which may not be complete.
   *
   * Each call to this function will force the deployment to end at LEAST {@link paddingMillis}
   * from this point in time.
   *
   * If the current padding is longer than the added padding, nothing will change, if the current padding is shorter, the process will
   * end at least {@link paddingMillis} from this point in time.
   */
  private addModulePadding(
    paddingMillis: number,
    state: UpdateState,
    name: string = "PADDING"
  ) {
    if (state.modules[name]) {
      state.modules[name] = {
        ...state.modules[name],
        resource: Promise.all([
          state.modules[name].resource,
          wait(paddingMillis),
        ]) as any,
      };
    } else {
      state.modules[name] = {
        dependencies: [],
        resource: wait(paddingMillis) as any,
        name,
      };
    }
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
  private async deleteResource(
    logicalId: string,
    state: UpdateState,
    allowedLogicalIds: Set<String>
  ): Promise<PhysicalResource | undefined> {
    if (logicalId in state.modules) {
      return state.modules[logicalId].resource;
    } else {
      const process = async () => {
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
                logicalResource.Properties?.DBClusterIdentifier === undefined)))
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
            dependencies.map((dependency) =>
              this.deleteResource(dependency, state, allowedLogicalIds)
            )
          );

          if (allowedLogicalIds?.has(logicalId) ?? true) {
            // if this logicalId is allowed to be deleted, then delete it
            // nite: we always transit dependencies BEFORE any other action is taken
            const progress = (
              await awsSDKRetry(() =>
                this.controlClient.send(
                  new control.DeleteResourceCommand({
                    TypeName: physicalResource.Type,
                    Identifier: physicalResource.PhysicalId,
                  })
                )
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
      };

      return this.startProcessModule(
        logicalId,
        "DELETE",
        state,
        state.desiredState?.Resources[logicalId].Type,
        async (start) => {
          console.log("Add DELETE: " + logicalId);
          return {
            resource: await process(),
            processTime: new Date().getTime() - start.getTime(),
          };
        }
      ).resource;
    }
  }

  /**
   * Deploy all {@link LogicalResource}s in this {@link CloudFormationStack}
   *
   * @param desiredState a {@link CloudFormationTemplate} describing the Desired State of this {@link Stack}.
   * @param parameterValues input values of the {@link Parameters}.
   * @returns the new {@link StackState}.
   */
  public async updateStack(
    desiredState: CloudFormationTemplate,
    parameterValues?: ParameterValues,
    assetManifestFile?: string
  ): Promise<StackState> {
    const previousState = this.state?.template;

    const assetManifest = assetManifestFile
      ? AssetManifest.fromFile(assetManifestFile)
      : undefined;

    const publisher = assetManifest
      ? new AssetPublishing(assetManifest, {
          aws: this.awsClient,
          buildAssets: false,
        })
      : undefined;

    await Promise.all(
      assetManifest?.entries.map(async (a) => {
        console.log("publishing " + a.id);
        // @ts-ignore
        await publisher.publishAsset(a);
      }) ?? []
    );

    if (publisher?.hasFailures) {
      throw new Error(
        publisher.failures
          .map((f) => `Asset Error ${f.asset.id} ${f.error}`)
          .join("\n")
      );
    }

    const state: UpdateState = {
      previousState: this.state?.template,
      previousDependencyGraph: this.state?.template
        ? buildDependencyGraph(this.state.template)
        : undefined,
      desiredState: desiredState,
      desiredDependencyGraph: buildDependencyGraph(desiredState),
      parameterValues,
      modules: {},
    };
    try {
      await this.validateParameters(desiredState, parameterValues);
      if (desiredState.Rules) {
        await this.validateRules(desiredState.Rules, state);
      }

      const resourceResults = await Promise.allSettled(
        Object.keys(desiredState.Resources).map(async (logicalId) => {
          const resource = await this.updateResource(state, logicalId);
          return resource
            ? {
                [logicalId]: resource,
              }
            : undefined;
        })
      );
      const resourceFailed = resourceResults.filter(
        (r): r is PromiseRejectedResult => r.status === "rejected"
      );
      if (resourceFailed.length > 0) {
        throw new Error(
          "One or more resources failed:\n" +
            resourceFailed.map((r) => r.reason).join("\n")
        );
      }
      const resultValues = resourceResults
        .map(
          (r) =>
            (<Exclude<typeof resourceResults[number], PromiseRejectedResult>>r)
              .value
        )
        .filter(<T>(a: T): a is Exclude<T, undefined> => a !== undefined)
        .reduce((a, b) => ({ ...a, ...b }), {});

      // create new resources
      this.state = {
        template: desiredState,
        resources: {
          ...(this.state?.resources ?? {}),
          ...resultValues,
        },
        outputs: Object.fromEntries(
          await Promise.all(
            Object.entries(desiredState.Outputs ?? {}).map(
              async ([name, value]) => [
                name,
                // @ts-ignore
                await this.evaluateExpr(value, state).then((x) => x.Value),
              ]
            )
          )
        ),
      };

      // delete orphaned resources
      const orphanedLogicalIds =
        previousState === undefined
          ? []
          : discoverOrphanedDependencies(previousState, desiredState);

      await this.deleteResources(orphanedLogicalIds, state);

      for (const orphanedLogicalId of orphanedLogicalIds) {
        delete this.state?.resources[orphanedLogicalId];
      }

      return this.state;
    } finally {
      console.log("Cleaning Up");

      console.log(
        Object.keys(state.modules).length,
        Object.keys(state.modules)
      );

      // await any leaf tasks not awaited already
      const completedModules = await Promise.allSettled(
        Object.values(state.modules).map(async (x) => ({
          resource: await x.resource,
          module: x,
        }))
      );

      const failedMessage = completedModules
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => "Resource failed: " + r.reason)
        .join("\n");
      const succeededModules = completedModules.filter(
        (
          r
        ): r is Exclude<
          typeof completedModules[number],
          PromiseRejectedResult
        > => r.status === "fulfilled"
      );
      const succeededMessage = succeededModules
        .map((r) => {
          // TODO: output in a consumable form
          return `Resource complete: ${r.value.module.name} - (${
            r.value.module.type
          }) - T: ${
            r.value.module.end && r.value.module.start
              ? r.value.module.end.getTime() - r.value.module.start.getTime()
              : "NA"
          } P: ${r.value.module.processTime ?? "NA"}`;
        })
        .join("\n");
      const typeMetrics = succeededModules.reduce(
        (metrics: Record<string, { avgProcessTime: number; n: number }>, m) => {
          const processTime = m.value.module.processTime;
          const type = m.value.module.type;
          if (!type || !processTime) {
            return metrics;
          }
          const record = metrics[type] ?? { avgProcessTime: 0, n: 0 };
          return {
            ...metrics,
            [type]: {
              avgProcessTime:
                (record.avgProcessTime * record.n + processTime) /
                (record.n + 1),
              n: record.n + 1,
            },
          };
        },
        {}
      );
      const metricsMessage = Object.entries(typeMetrics)
        .map(
          (metric) =>
            `${metric[0]} - P: ${metric[1].avgProcessTime} N: ${metric[1].n}`
        )
        .join("\n");

      console.log(`SUCCEEDED:
${succeededMessage}

FAILURES:
${failedMessage}

AGGREGATED METRICS:
${metricsMessage}`);

      // clear tasks
      state.modules = {};
    }
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
  private async updateResource(
    state: UpdateState,
    logicalId: string
  ): Promise<PhysicalResource | undefined> {
    const logicalResource = this.getLogicalResource(logicalId, state);
    if (logicalId in state.modules) {
      console.log("Task Cache Hit: " + logicalId);
      return state.modules[logicalId].resource;
    } else {
      console.log("Add UPDATE: " + logicalId);
      const physicalResource = this.getPhysicalResource(logicalId);
      const update = physicalResource !== undefined;

      return this.startProcessModule(
        logicalId,
        update ? "UPDATE" : "CREATE",
        state,
        state.desiredState?.Resources[logicalId].Type,
        async () => {
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
              return { resource: undefined, processTime: 0 };
            }
          }

          const properties = logicalResource.Properties
            ? Object.fromEntries(
                await Promise.all(
                  Object.entries(logicalResource.Properties).map(
                    async ([propName, propExpr]) => [
                      propName,
                      await this.evaluateExpr(propExpr, state),
                    ]
                  )
                )
              )
            : {};

          if (logicalResource.DependsOn) {
            const results = await Promise.allSettled(
              logicalResource.DependsOn.map((logicalDep) =>
                this.updateResource(state, logicalDep)
              )
            );
            const failed = results.filter((s) => s.status === "rejected");
            if (failed.length > 0) {
              throw new Error(`Dependency of ${logicalId} failed, aborting.`);
            }
          }

          const startTime = new Date();

          try {
            if (logicalResource.Type === "AWS::Events::EventBus") {
              let result: { arn: string };
              try {
                const r = await awsSDKRetry(() =>
                  this.eventBridgeClient.send(
                    new events.CreateEventBusCommand(
                      properties as unknown as events.CreateEventBusCommandInput
                    )
                  )
                );
                if (!r.EventBusArn) {
                  throw new Error("Expected event arn");
                }
                result = {
                  arn: r.EventBusArn,
                };
              } catch (err) {
                // TODO: support updates.
                if (err instanceof events.ResourceAlreadyExistsException) {
                  result = {
                    arn: `arn:aws:events:${this.region}:${this.account}:event-bus/${properties.Name}`,
                  };
                } else {
                  throw err;
                }
              }
              return {
                resource: {
                  PhysicalId: result.arn,
                  Attributes: {
                    Arn: result.arn,
                  },
                  InputProperties: properties,
                  Type: logicalResource.Type,
                },
                processTime: new Date().getTime() - startTime.getTime(),
              };
            } else if (logicalResource.Type === "AWS::Events::Rule") {
              const props = properties as unknown as EventBusRuleResource;
              const input = {
                Name: logicalId,
                ...props,
                EventPattern: JSON.stringify(props.EventPattern),
              };
              const r = await this.eventBridgeClient.send(
                new events.PutRuleCommand(input)
              );

              if (!r.RuleArn) {
                throw new Error("Expected rule arn");
              }
              return {
                resource: {
                  PhysicalId: r.RuleArn!,
                  InputProperties: properties as unknown as PhysicalProperties,
                  Type: logicalResource.Type,
                  Attributes: { Arn: r.RuleArn!, Id: input.Name },
                },
                processTime: new Date().getTime() - startTime.getTime(),
              };
            } else if (logicalResource.Type === "AWS::IAM::Policy") {
              const props = properties as PolicyResource;
              const policyDocument = JSON.stringify(props.PolicyDocument);
              const roles = props.Roles?.map((r) =>
                awsSDKRetry(() =>
                  this.iamClient.send(
                    new iam.PutRolePolicyCommand({
                      PolicyDocument: policyDocument,
                      PolicyName: props.PolicyName,
                      RoleName: r,
                    })
                  )
                )
              );
              const groups = props.Groups?.map((g) =>
                awsSDKRetry(() =>
                  this.iamClient.send(
                    new iam.PutGroupPolicyCommand({
                      PolicyDocument: policyDocument,
                      PolicyName: props.PolicyName,
                      GroupName: g,
                    })
                  )
                )
              );
              const users = props.Users?.map((u) =>
                awsSDKRetry(() =>
                  this.iamClient.send(
                    new iam.PutUserPolicyCommand({
                      PolicyDocument: policyDocument,
                      PolicyName: props.PolicyName,
                      UserName: u,
                    })
                  )
                )
              );

              await Promise.all([
                ...(groups ?? []),
                ...(users ?? []),
                ...(roles ?? []),
              ]);

              // add a max of 10 second padding after adding any policy
              this.addModulePadding(10000, state);

              return {
                resource: {
                  PhysicalId: undefined,
                  Attributes: {},
                  InputProperties: properties,
                  Type: logicalResource.Type,
                },
                processTime: new Date().getTime() - startTime.getTime(),
              };
            } else if (logicalResource.Type === "AWS::IAM::ManagedPolicy") {
              const props = properties as ManagedPolicyResource;
              // create the role
              let result: {
                arn: string;
                groups: string[];
                roles: string[];
                users: string[];
              };
              try {
                const r = await awsSDKRetry(() =>
                  this.iamClient.send(
                    new iam.CreatePolicyCommand({
                      PolicyDocument: JSON.stringify(props.PolicyDocument),
                      // fix name
                      PolicyName: props.ManagedPolicyName ?? logicalId,
                      Description: props.Description,
                      Path: props.Path,
                    })
                  )
                );
                if (!r.Policy || !r.Policy.Arn) {
                  throw new Error("Expected policy");
                }
                iam.waitUntilPolicyExists(
                  { client: this.iamClient, maxWaitTime: 10 },
                  { PolicyArn: r.Policy.Arn }
                );
                result = {
                  arn: r.Policy.Arn,
                  groups: [],
                  roles: [],
                  users: [],
                };
              } catch (err) {
                let _err = err as { name: string };
                // if the entity exists, just provide the arn and move on.
                // TODO: check if the role attachments need to change.
                if (_err.name === "EntityAlreadyExists") {
                  // todoL managed policy name must be more unique
                  const name = props.ManagedPolicyName ?? logicalId;

                  const arn = `arn:aws:iam::${this.account}:policy/${name}`;
                  let entities: Pick<
                    iam.ListEntitiesForPolicyCommandOutput,
                    "PolicyGroups" | "PolicyRoles" | "PolicyUsers"
                  > = {};
                  let response: iam.ListEntitiesForPolicyCommandOutput = {
                    IsTruncated: true,
                    $metadata: {},
                  };
                  const versions = await awsSDKRetry(() =>
                    this.iamClient.send(
                      new iam.ListPolicyVersionsCommand({ PolicyArn: arn })
                    )
                  );
                  // prune
                  if (versions.Versions && versions.Versions.length >= 5) {
                    const nonDefaultVersions = versions.Versions.filter(
                      (v) => !v.IsDefaultVersion
                    );
                    const oldestDate = Math.min(
                      ...nonDefaultVersions.map(
                        (v) =>
                          v.CreateDate?.getTime() ?? Number.MAX_SAFE_INTEGER
                      )
                    );
                    const oldest = nonDefaultVersions.find(
                      (v) => v.CreateDate?.getTime() === oldestDate
                    )!;
                    await awsSDKRetry(() =>
                      this.iamClient.send(
                        new iam.DeletePolicyVersionCommand({
                          PolicyArn: arn,
                          VersionId: oldest.VersionId,
                        })
                      )
                    );
                  }
                  await awsSDKRetry(() =>
                    this.iamClient.send(
                      new iam.CreatePolicyVersionCommand({
                        PolicyArn: arn,
                        PolicyDocument: JSON.stringify(props.PolicyDocument),
                        SetAsDefault: true,
                      })
                    )
                  );
                  while (response.IsTruncated) {
                    response = await awsSDKRetry(() =>
                      this.iamClient.send(
                        new iam.ListEntitiesForPolicyCommand({ PolicyArn: arn })
                      )
                    );
                    entities = {
                      PolicyGroups: [
                        ...(entities.PolicyGroups ?? []),
                        ...(response.PolicyGroups ?? []),
                      ],
                      PolicyRoles: [
                        ...(entities.PolicyRoles ?? []),
                        ...(response.PolicyRoles ?? []),
                      ],
                      PolicyUsers: [
                        ...(entities.PolicyUsers ?? []),
                        ...(response.PolicyUsers ?? []),
                      ],
                    };
                  }

                  result = {
                    arn,
                    groups: (entities.PolicyGroups ?? [])
                      .map((g) => g.GroupName)
                      .filter((g): g is string => !!g),
                    roles: (entities.PolicyRoles ?? [])
                      .map((r) => r.RoleName)
                      .filter((r): r is string => !!r),
                    users: (entities.PolicyUsers ?? [])
                      .map((u) => u.UserName)
                      .filter((u): u is string => !!u),
                  };
                } else {
                  throw err;
                }
              }
              const addGroups = (props.Groups ?? []).filter(
                (g) => !result.groups.includes(g)
              );
              // then attach the groups and roles and users
              const attachGroups = addGroups.map((group) =>
                awsSDKRetry(() =>
                  this.iamClient.send(
                    new iam.AttachGroupPolicyCommand({
                      GroupName: group,
                      PolicyArn: result.arn,
                    })
                  )
                )
              );
              const removeGroups = props.Groups
                ? result.groups.filter((g) => !props.Groups!.includes(g))
                : [];
              const detachGroups = removeGroups.map((g) =>
                awsSDKRetry(() =>
                  this.iamClient.send(
                    new iam.DetachGroupPolicyCommand({
                      GroupName: g,
                      PolicyArn: result.arn,
                    })
                  )
                )
              );
              const addRoles = (props.Roles ?? []).filter(
                (r) => !result.roles.includes(r)
              );
              const attachRoles = addRoles.map((role) =>
                awsSDKRetry(() =>
                  this.iamClient.send(
                    new iam.AttachRolePolicyCommand({
                      RoleName: role,
                      PolicyArn: result.arn,
                    })
                  )
                )
              );
              const removeRoles = props.Roles
                ? result.roles.filter((r) => !props.Roles!.includes(r))
                : [];
              const detachRoles = removeRoles.map((r) =>
                awsSDKRetry(() =>
                  this.iamClient.send(
                    new iam.DetachRolePolicyCommand({
                      RoleName: r,
                      PolicyArn: result.arn,
                    })
                  )
                )
              );
              const addUsers = (props.Users ?? []).filter(
                (r) => !result.users.includes(r)
              );
              const attachUser = addUsers.map((user) =>
                awsSDKRetry(() =>
                  this.iamClient.send(
                    new iam.AttachUserPolicyCommand({
                      UserName: user,
                      PolicyArn: result.arn,
                    })
                  )
                )
              );
              const removeUsers = props.Users
                ? result.users.filter((u) => !props.Users!.includes(u))
                : [];
              const detachUsers = removeUsers.map((u) =>
                awsSDKRetry(() =>
                  this.iamClient.send(
                    new iam.DetachUserPolicyCommand({
                      UserName: u,
                      PolicyArn: result.arn,
                    })
                  )
                )
              );

              const attachResults = await Promise.allSettled([
                ...attachGroups,
                ...detachGroups,
                ...attachRoles,
                ...detachRoles,
                ...attachUser,
                ...detachUsers,
              ]);

              // add a max of 10 second padding after adding any managed policy
              this.addModulePadding(10000, state);

              const failedAttaches = attachResults.filter(
                (a): a is PromiseRejectedResult => a.status === "rejected"
              );
              if (failedAttaches.length > 1) {
                throw new Error(
                  `Attaching or detaching roles, groups, or users of a Policy failed: ${failedAttaches
                    .map((a) => a.reason)
                    .join("\n")}`
                );
              }

              return {
                resource: {
                  PhysicalId: result.arn,
                  Type: logicalResource.Type,
                  InputProperties: properties,
                  Attributes: {
                    Arn: result.arn,
                  },
                },
                processTime: new Date().getTime() - startTime.getTime(),
              };
            } else if (logicalResource.Type === "AWS::SQS::QueuePolicy") {
              const props = properties as unknown as SQSQueuePolicyResource;

              const result = await Promise.allSettled(
                props.Queues.map((q) =>
                  this.sqsClient.send(
                    new sqs.SetQueueAttributesCommand({
                      Attributes: {
                        Policy: JSON.stringify(props.PolicyDocument),
                      },
                      QueueUrl: q,
                    })
                  )
                )
              );
              const failures = result.filter(
                (x): x is PromiseRejectedResult => x.status === "rejected"
              );
              if (failures.length > 0) {
                throw new Error(
                  `Queue Policy failed to update (${logicalId}): ${failures
                    .map((f) => f.reason)
                    .join("\n")}`
                );
              }
              return {
                resource: {
                  PhysicalId: undefined,
                  Attributes: {},
                  Type: logicalResource.Type,
                  InputProperties: props as unknown as PhysicalProperties,
                },
                processTime: new Date().getTime() - startTime.getTime(),
              };
            } else {
              let controlApiResult;
              if (!update) {
                console.log(`Creating ${logicalId} (${logicalResource.Type})`);
                const props = (() => {
                  if (logicalResource.Type === "AWS::DynamoDB::Table") {
                    // dynamo table pay_per_request fails when ProvisionedThroughput is present.
                    if (properties.BillingMode === "PAY_PER_REQUEST ") {
                      const { ProvisionedThroughput, ...props } = properties;
                      return props;
                    }
                  }
                  return properties;
                })();
                try {
                  console.log(
                    `Starting Create for ${logicalResource.Type}: ${logicalId}`
                  );
                  controlApiResult = await awsSDKRetry(() =>
                    this.controlClient.send(
                      new control.CreateResourceCommand({
                        TypeName: logicalResource.Type,
                        DesiredState: JSON.stringify(props),
                      })
                    )
                  );
                } catch (err) {
                  console.error(
                    `error while deploying (${
                      (<any>err).message
                    }) ${JSON.stringify(
                      logicalResource,
                      null,
                      2
                    )} with props ${JSON.stringify(props, null, 2)}`
                  );
                  throw err;
                }
              } else {
                const patch = compare(
                  physicalResource.InputProperties,
                  properties
                );
                if (patch.length === 0) {
                  console.log(
                    `Skipping Update of ${logicalId} (${logicalResource.Type})`
                  );
                  return {
                    resource: physicalResource,
                    processTime: new Date().getTime() - startTime.getTime(),
                  };
                }
                console.log(`Updating ${logicalId} (${logicalResource.Type})`);
                controlApiResult = await awsSDKRetry(() =>
                  this.controlClient.send(
                    new control.UpdateResourceCommand({
                      TypeName: logicalResource.Type,
                      PatchDocument: JSON.stringify(patch),
                      Identifier: physicalResource.PhysicalId,
                    })
                  )
                );
              }

              const progress = controlApiResult.ProgressEvent;

              if (progress === undefined) {
                throw new Error(
                  `DeleteResourceCommand returned an undefined ProgressEvent`
                );
              }

              const waitStart = new Date();

              const resource = await this.waitForProgress(
                logicalId,
                logicalResource.Type,
                properties,
                progress
              );

              return {
                resource,
                processTime: new Date().getTime() - waitStart.getTime(),
              };
            }
          } catch (err) {
            console.error(err);
            throw new Error(
              `Error while ${update ? "updating" : "creating"} ${logicalId}: ${
                (<any>err).message
              }`
            );
          }
        }
      ).resource;
    }
  }

  private async waitForProgress(
    logicalId: string,
    type: ResourceType,
    properties: PhysicalProperties,
    progress: control.ProgressEvent
  ): Promise<PhysicalResource> {
    do {
      const opStatus = progress?.OperationStatus;
      if (opStatus === "SUCCESS") {
        console.log(`${progress.Operation} Success: ${logicalId} (${type})`);
        try {
          const attributes =
            progress.Operation === "DELETE"
              ? undefined
              : (
                  await awsSDKRetry(() =>
                    this.controlClient.send(
                      new control.GetResourceCommand({
                        TypeName: progress.TypeName,
                        Identifier: progress.Identifier!,
                      })
                    )
                  )
                ).ResourceDescription?.Properties;

          return {
            Type: type,
            PhysicalId: progress?.Identifier!,
            InputProperties: properties,
            Attributes: attributes ? JSON.parse(attributes) : {},
          };
        } catch (err) {
          // some resources fail when calling GET even after succeeding
          return {
            Type: type,
            PhysicalId: progress?.Identifier!,
            InputProperties: properties,
            Attributes: {},
          };
        }
      } else if (opStatus === "FAILED") {
        const errorMessage = `Failed to ${
          progress.Operation ?? "Update"
        } ${logicalId} (${type})${
          progress.StatusMessage ? ` ${progress.StatusMessage}` : ""
        }`;
        console.log(errorMessage);
        throw new Error(errorMessage);
      }

      const retryAfter = progress?.RetryAfter?.getTime();
      const waitTime = Math.max(retryAfter ? retryAfter - Date.now() : 50, 50);
      console.log(`Waiting for (${waitTime}): ${logicalId}`);
      await new Promise((resolve) => setTimeout(resolve, waitTime));

      try {
        progress = (
          await awsSDKRetry(() =>
            this.controlClient.send(
              new control.GetResourceRequestStatusCommand({
                RequestToken: progress?.RequestToken,
              })
            )
          )
        ).ProgressEvent!;
      } catch (err) {
        console.error("error waiting for ", logicalId, err);
        throw err;
      }
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
      return Promise.all(
        expr
          // hack to remove NoValue from an array
          .filter(
            (v) =>
              !(
                v &&
                typeof v === "object" &&
                "Ref" in v &&
                v.Ref === "AWS::NoValue"
              )
          )
          .map((e) => this.evaluateExpr(e, state))
      );
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
      if (isPseudoParameter(expr.Ref)) {
        return this.evaluatePseudoParameter(expr.Ref);
      }
      const paramDef = parameters[expr.Ref];
      if (paramDef !== undefined) {
        return this.evaluateParameter(state, expr.Ref, paramDef);
      } else {
        const resource = await this.updateResource(state, expr.Ref);
        if (resource?.Type === "AWS::SQS::Queue") {
          return resource.Attributes.QueueUrl;
        }
        return resource?.PhysicalId;
      }
    } else if (isFnGetAtt(expr)) {
      const [logicalId, attributeName] = expr["Fn::GetAtt"];
      const resource = await this.updateResource(state, logicalId);
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
      if (isIntrinsicFunction(listOfObjects)) {
        const evaled = await this.evaluateIntrinsicFunction(
          state,
          listOfObjects
        );
        if (!Array.isArray(evaled)) {
          throw new Error(`Expected an array, found: ${evaled}`);
        } else if (index in evaled) {
          return evaled[index];
        } else {
          throw new Error(`index ${index} out of bounds in list: ${evaled}`);
        }
      }
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
      const [string, variables] =
        typeof expr["Fn::Sub"] === "string"
          ? [expr["Fn::Sub"], {}]
          : expr["Fn::Sub"];
      const resolvedValues = Object.fromEntries(
        await Promise.all(
          Object.entries(variables).map(async ([varName, varVal]) => [
            varName,
            await this.evaluateExpr(varVal, state),
          ])
        )
      );

      // match "something ${this} something"
      return string.replace(/\$\{([^\}]*)\}/g, (_, varName) => {
        const varVal =
          varName in resolvedValues
            ? resolvedValues[varName]
            : isPseudoParameter(varName)
            ? this.evaluatePseudoParameter(varName)
            : undefined;
        if (
          typeof varVal === "string" ||
          typeof varVal === "number" ||
          typeof varVal === "boolean"
        ) {
          return `${varVal}`;
        } else {
          throw new Error(
            `Variable '${varName}' in Fn::Sub did not resolve to a String, Number or Boolean: ${varVal}`
          );
        }
      });
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

async function awsSDKRetry<T>(call: () => T): Promise<Awaited<T>> {
  return await retry(
    call,
    (err) => (err as any).name === "ThrottlingException",
    () => true,
    5,
    1000,
    2
  );
}

const wait = (waitMillis: number) =>
  new Promise((resolve) => setTimeout(resolve, waitMillis));

export const retry = async <T>(
  call: () => T | Promise<T>,
  errorPredicate: (err: unknown) => boolean,
  predicate: (val: T) => boolean,
  attempts: number,
  waitMillis: number,
  factor: number
): Promise<Awaited<T>> => {
  try {
    const item = await call();
    if (!predicate(item)) {
      if (attempts) {
        await wait(waitMillis);
        return retry(
          call,
          errorPredicate,
          predicate,
          attempts - 1,
          waitMillis * factor,
          factor
        );
      } else {
        throw Error("Retry attempts exhausted");
      }
    }
    return item;
  } catch (err) {
    if (errorPredicate(err)) {
      if (attempts) {
        await wait(waitMillis);
        return retry(
          call,
          errorPredicate,
          predicate,
          attempts - 1,
          waitMillis * factor,
          factor
        );
      } else {
        console.error(`Retry attempts exhausted ${(<any>err).message}`);
        throw err;
      }
    }
    throw err;
  }
};
