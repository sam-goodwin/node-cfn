import {
  CreateRequest,
  DeleteRequest,
  ResourceProvider,
  ResourceProviderProps,
  UpdateRequest,
} from "../resource-provider";
import { PhysicalResource } from "../resource";
import * as events from "@aws-sdk/client-eventbridge";

export interface EventBusRuleResource {
  Description?: string;
  EventBusName?: string;
  EventPattern: object;
  Name?: string;
  RoleArn: string;
  ScheduleExpression?: string;
  State?: string;
  Targets?: EventBusRuleTarget[];
}

export interface EventBusRuleTarget {
  Arn: string;
  BatchParameters?: EventBusRuleBatchParameters;
  DeadLetterConfig?: {
    Arn: string;
  };
  EcsParameters?: EventBusRuleEcsParameters;
  HttpParameters?: {
    HeaderParameters?: Record<string, string>;
    PathParameterValues?: string[];
    QueryStringParameters?: Record<string, string>;
  };
  Id: string;
  Input?: string;
  InputPath?: string;
  InputTransformer?: {
    InputPathsMap?: Record<string, string>;
    InputTemplate: string;
  };
  KinesisParameters?: {
    PartitionKeyPath: String;
  };
  RedshiftDataParameters?: {
    Database: string;
    DbUser?: string;
    SecretManagerArn?: string;
    Sql: string;
    StatementName?: string;
    WithEvent?: boolean;
  };
  RetryPolicy?: {
    MaximumEventAgeInSeconds?: number;
    MaximumRetryAttempts?: number;
  };
  RoleArn?: string;
  RunCommandParameters?: {
    RunCommandTargets: {
      Key: string;
      Values: string[];
    }[];
  };
  SageMakerPipelineParameters?: {
    PipelineParameterList: {
      Name: string;
      Value: string;
    }[];
  };
  SqsParameters?: {
    MessageGroupId: string;
  };
}

export interface EventBusRuleBatchParameters {
  ArrayProperties: {
    Size: number;
  };
  JobDefinition: String;
  JobName: String;
  RetryStrategy: {
    Attempts: number;
  };
}

export interface EventBusRuleEcsParameters {
  CapacityProviderStrategy?: {
    Base: number;
    CapacityProvider: String;
    Weight: number;
  }[];
  EnableECSManagedTags?: boolean;
  EnableExecuteCommand?: boolean;
  Group?: string;
  LaunchType?: string;
  NetworkConfiguration?: {
    AwsVpcConfiguration?: {
      AssignPublicIp?: string;
      SecurityGroups?: string[];
      Subnets: string[];
    };
  };
  PlacementConstraints?: {
    Expression: string;
    Type: string;
  }[];
  PlacementStrategies?: {
    Field?: string;
    Type?: string;
  }[];
  PlatformVersion?: string;
  PropagateTags?: string;
  ReferenceId?: string;
  TagList?: {
    Key?: string;
    Value?: string;
  }[];
  TaskCount?: number;
  TaskDefinitionArn: string;
}

export class EventBusRuleProvider
  implements ResourceProvider<EventBusRuleResource>
{
  private eventBridgeClient: events.EventBridgeClient;
  readonly Type = "AWS::Events::Rule";

  constructor(props: ResourceProviderProps) {
    this.eventBridgeClient = new events.EventBridgeClient(props.sdkConfig);
  }

  async create(
    request: CreateRequest<EventBusRuleResource>
  ): Promise<PhysicalResource<EventBusRuleResource>> {
    return this.createUpdate(request.logicalId, request.definition);
  }
  update(request: UpdateRequest<EventBusRuleResource>): Promise<
    | PhysicalResource<EventBusRuleResource>
    | {
        paddingMillis: number;
        resource: PhysicalResource<EventBusRuleResource>;
      }
  > {
    return this.createUpdate(request.logicalId, request.definition);
  }
  delete(_request: DeleteRequest<EventBusRuleResource>): Promise<void> {
    throw new Error("Method not implemented.");
  }
  async createUpdate(logicalId: string, definition: EventBusRuleResource) {
    const input = {
      Name: logicalId,
      ...definition,
      EventPattern: JSON.stringify(definition.EventPattern),
    };
    const r = await this.eventBridgeClient.send(
      new events.PutRuleCommand(input)
    );

    if (!r.RuleArn) {
      throw new Error("Expected rule arn");
    }
    return {
      PhysicalId: r.RuleArn!,
      InputProperties: definition,
      Type: this.Type,
      Attributes: { Arn: r.RuleArn!, Id: input.Name },
    };
  }
}
