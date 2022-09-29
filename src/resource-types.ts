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

export interface SQSQueuePolicyResource {
  PolicyDocument: object;
  Queues: string[];
}

export interface BasePolicyResource {
  Groups?: string[];
  PolicyDocument: any;
  Roles?: string[];
  Users?: string[];
}

export interface ManagedPolicyResource extends BasePolicyResource {
  Description?: string;
  ManagedPolicyName?: string;
  Path?: string;
}

export interface PolicyResource extends BasePolicyResource {
  PolicyName: string;
}
