import * as control from "@aws-sdk/client-cloudcontrol";
import * as ssm from "@aws-sdk/client-ssm";

import { compare } from "fast-json-patch";
import { EvaluatedExpression, Expression } from "./expression";
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
  // @ts-ignore - imported for typedoc
  SSMParameterType,
  Parameter,
  ParameterValues,
  validateParameters,
} from "./parameter";
import {
  PhysicalResource,
  PhysicalResources,
  LogicalResource,
  PhysicalProperties,
  ResourceType,
  DeletionPolicy,
} from "./resource";
import { CloudFormationTemplate } from "./template";

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
   * The new {@link CloudFormationTemplate} which triggered the `Update`.
   *
   * For the `Create`/`Update` operations, this is the (new) desired state of the {@link Stack}.
   *
   * For the `Delete` operation, this refers to the template which last Created/Updated the {@link Stack}.
   */
  template: CloudFormationTemplate;
  /**
   * The {@link template}'s {@link DependencyGraph}.
   */
  dependencyGraph: DependencyGraph;
  /**
   * Input {@link ParameterValues} for the {@link template}'s {@link Parameters}.
   */
  parameterValues?: ParameterValues;
  /**
   * Map of `logicalId` to a task ({@link Promise}) resolving the new state of the {@link PhysicalResource}.
   */
  tasks: {
    [logicalId: string]: Promise<PhysicalResource>;
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
  private state: StackState | undefined;

  constructor(props: StackProps) {
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
    state: UpdateState,
    logicalId: string
  ): LogicalResource {
    const resource = state.template.Resources[logicalId];
    if (resource === undefined) {
      throw new Error(`resource does not exist: '${logicalId}'`);
    }
    if (resource.Type === "AWS::DynamoDB::Table") {
      // CloudControl API doesn't support AWS::DynamoDB::Table
      // so as a quick hack, we map it to AWS::DynamoDB::GlobalTable which does.
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
   * Get the {@link Parameter} definition by its {@link parameterName}.
   *
   * @param state current {@link UpdateState} being evaluated.
   * @param parameterName name of the parameter to lookup.
   * @returns the value of the {@link Parameter} if it exists, otherwise `undefined`.
   */
  private getParameterDefinition(
    state: UpdateState,
    parameterName: string
  ): Parameter | undefined {
    return state.template.Parameters?.[parameterName];
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
    const dependencyGraph = buildDependencyGraph(this.state!.template);
    const deleteState: UpdateState = {
      template: this.state.template,
      dependencyGraph,
      tasks: {}, // initialize with empty state
    };
    await Promise.all(
      Object.keys(this.state.resources).map(async (logicalId) => {
        deleteState.tasks[logicalId] = this.deleteResource(
          logicalId,
          deleteState
        );
      })
    );
    this.state = undefined;
  }

  private async deleteResource(
    logicalId: string,
    state: UpdateState
  ): Promise<PhysicalResource> {
    if (logicalId in state.tasks) {
      return state.tasks[logicalId];
    }

    const physicalResource = this.getPhysicalResource(logicalId);
    const logicalResource = this.getLogicalResource(state, logicalId);

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
      const dependencies = state.dependencyGraph[logicalId];
      // wait for dependencies to delete before deleting this resource
      await Promise.all(
        dependencies.map((dependency) => this.deleteResource(dependency, state))
      );

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
    } else if (deletionPolicy === DeletionPolicy.Retain) {
      return physicalResource;
    } else {
      // should never reach here
      throw new Error(`Unsupported: DeletionPolicy.${deletionPolicy}`);
    }
  }

  /**
   * Deploy all {@link LogicalResource}s in this {@link CloudFormationStack}
   *
   * @returns the new {@link StackState}.
   */
  public async updateStack(
    template: CloudFormationTemplate,
    parameterValues?: ParameterValues
  ): Promise<StackState> {
    validateParameters(template, parameterValues);

    const updateState: UpdateState = {
      template,
      dependencyGraph: buildDependencyGraph(template),
      parameterValues,
      tasks: {},
    };
    return (this.state = {
      template,
      resources: (
        await Promise.all(
          Object.keys(template.Resources).map(async (logicalId) => ({
            [logicalId]: await this.updateResource(updateState, logicalId),
          }))
        )
      ).reduce((a, b) => ({ ...a, ...b }), {}),
    });
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
  ): Promise<PhysicalResource> {
    const logicalResource = this.getLogicalResource(state, logicalId);
    if (logicalId in state.tasks) {
      return state.tasks[logicalId];
    } else {
      return (state.tasks[logicalId] = (async () => {
        const properties = (
          await Promise.all(
            Object.entries(logicalResource.Properties).map(
              async ([propName, propExpr]) => {
                return {
                  [propName]: await this.evaluateExpr(state, propExpr),
                };
              }
            )
          )
        ).reduce((a, b) => ({ ...a, ...b }), {});

        const physicalResource = this.getPhysicalResource(logicalId);
        let controlApiResult;
        if (physicalResource === undefined) {
          controlApiResult = await this.controlClient.send(
            new control.CreateResourceCommand({
              TypeName: logicalResource.Type,
              DesiredState: JSON.stringify(properties),
            })
          );
        } else {
          const patch = compare(physicalResource.InputProperties, properties);
          if (patch.length === 0) {
            return physicalResource;
          }
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
          progress
        );
      })());
    }
  }

  private async waitForProgress(
    logicalId: string,
    type: ResourceType,
    properties: PhysicalProperties,
    progress: control.ProgressEvent
  ): Promise<PhysicalResource> {
    do {
      console.log(
        `${progress.OperationStatus} ${logicalId} ${progress.StatusMessage}`
      );
      const opStatus = progress?.OperationStatus;
      if (opStatus === "SUCCESS") {
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
        throw new Error(
          progress?.StatusMessage ?? `failed to deploy resource: '${logicalId}'`
        );
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
   * @param state the {@link UpdateState} being evaluated
   * @param expr expression to evaluate
   * @returns the physical property as a primitive JSON object
   */
  private async evaluateExpr(
    state: UpdateState,
    expr: Expression
  ): Promise<EvaluatedExpression> {
    if (expr === undefined || expr === null) {
      return expr;
    } else if (isIntrinsicFunction(expr)) {
      return this.evaluateIntrinsicFunction(state, expr);
    } else if (typeof expr === "string" && expr.startsWith("!Ref ")) {
      return this.evaluateIntrinsicFunction(state, {
        Ref: expr.substring("!Ref ".length),
      });
    } else if (Array.isArray(expr)) {
      return Promise.all(expr.map((e) => this.evaluateExpr(state, e)));
    } else if (typeof expr === "object") {
      return (
        await Promise.all(
          Object.entries(expr).map(async ([k, v]) => ({
            [k]: await this.evaluateExpr(state, v),
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
  ): Promise<EvaluatedExpression> {
    if (isRef(expr)) {
      const paramDef = this.getParameterDefinition(state, expr.Ref);
      if (paramDef !== undefined) {
        return this.evaluateParameter(state, expr.Ref, paramDef);
      } else {
        return (await this.updateResource(state, expr.Ref)).PhysicalId;
      }
    } else if (isFnGetAtt(expr)) {
      const [logicalId, attributeName] = expr["Fn::GetAtt"];
      const resource = await this.updateResource(state, logicalId);
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
          values.map((value) => this.evaluateExpr(state, value))
        )
      ).join(delimiter);
    } else if (isFnSelect(expr)) {
      const [index, listOfObjects] = expr["Fn::Select"];
      if (index in listOfObjects) {
        return this.evaluateExpr(state, listOfObjects[index]);
      } else {
        throw new Error(
          `index ${index} out of bounds in list: ${listOfObjects}`
        );
      }
    } else if (isFnSplit(expr)) {
      const [delimiter, sourceStringExpr] = expr["Fn::Split"];
      const sourceString = await this.evaluateExpr(state, sourceStringExpr);
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
          const resolvedVal = await this.evaluateExpr(state, varVal);
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
      const exprVal = await this.evaluateExpr(state, expr["Fn::Base64"]);
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
        this.evaluateExpr(state, topLevelKeyExpr),
        this.evaluateExpr(state, secondLevelKeyExpr),
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
        state.template.Mappings?.[mapName]?.[topLevelKey]?.[secondLevelKey];
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
  ): Promise<EvaluatedExpression> {
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
}
