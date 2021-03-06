// @ts-ignore - imported for type-doc
import type {
  CreateResourceCommand,
  UpdateResourceCommand,
} from "@aws-sdk/client-cloudcontrol";

// @ts-ignore - imported for type-doc
import { Expression } from "./expression";
// @ts-ignore - imported for type-doc
import type { IntrinsicFunction } from "./function";

import { Value } from "./value";

/**
 * The required {@link Resources} section declares the AWS resources that you want to include in the stack, such as an Amazon EC2 instance or an Amazon S3 bucket.
 *
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/resources-section-structure.html
 */
export interface Resources {
  /**
   * The logical ID must be alphanumeric `(A-Za-z0-9)` and unique within the template. Use the logical name to reference the resource in other parts of the template. For example, if you want to map an Amazon Elastic Block Store volume to an Amazon EC2 instance, you reference the logical IDs to associate the block stores with the instance.
   *
   * In addition to the logical ID, certain resources also have a physical ID, which is the actual assigned name for that resource, such as an EC2 instance ID or an S3 bucket name. Use the physical IDs to identify resources outside of AWS CloudFormation templates, but only after the resources have been created. For example, suppose you give an EC2 instance resource a logical ID of MyEC2Instance. When AWS CloudFormation creates the instance, AWS CloudFormation automatically generates and assigns a physical ID (such as i-28f9ba55) to the instance. You can use this physical ID to identify the instance and view its properties (such as the DNS name) by using the Amazon EC2 console. For resources that support custom names, you can assign your own names (physical IDs) to help you quickly identify resources. For example, you can name an S3 bucket that stores logs as MyPerformanceLogs.
   */
  [logicalId: string]: LogicalResource;
}

/**
 * Resource Type Name.
 *
 * @see https://docs.aws.amazon.com/cloudcontrolapi/latest/userguide/supported-resources.html
 */
export type ResourceType = string;

/**
 * A {@link LogicalResource} is a description of a resource containing its {@link Type}
 * and set of {@link LogicalProperties}.
 *
 * By "Logical", we mean that its {@link Properties} may contain {@link Expresion}s that
 * must be evaluated to values during Stack Update.
 */
export interface LogicalResource {
  Type: ResourceType;
  /**
   * The Resource's {@link LogicalProperties} configuration.
   */
  Properties: LogicalProperties;
  /**
   * With the DeletionPolicy attribute you can preserve, and in some cases, backup a resource when its stack is deleted.
   */
  DeletionPolicy?: DeletionPolicy;
  /**
   * You can use {@link IntrinsicFunction}s to conditionally create stack resources.
   *
   * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/intrinsic-function-reference-conditions.html
   */
  Condition?: string;
}

/**
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-attribute-deletionpolicy.html
 */
export enum DeletionPolicy {
  Delete = "Delete",
  Retain = "Retain",
  Snapshot = "Snapshot",
}

/**
 * Map of `propertyName` to its {@link Expression}.
 *
 * These properties will be evaluated at deploy-time and resolved to raw JSON values.
 */
export interface LogicalProperties {
  [propertyName: string]: Expression;
}

/**
 * Map of a {@link LogicalResource}'s `logicalId` to its {@link PhysicalResource}.
 */
export interface PhysicalResources {
  [logicalId: string]: PhysicalResource;
}

/**
 * A {@link PhysicalResource} provisioned in an AWS account.
 */
export interface PhysicalResource {
  /**
   * Name of the {@link ResourceType}.
   */
  Type: ResourceType;
  /**
   * Physical ID of the {@link PhysicalResource}.
   */
  PhysicalId: string;
  /**
   * Input Properties passed to {@link CreateResourceCommand} and {@link UpdateResourceCommand}.
   */
  InputProperties: PhysicalProperties;
  /**
   * Attributes exported by the {@link PhysicalResource}.
   */
  Attributes: PhysicalProperties;
}

/**
 * Map of `propertyName` to its {@link EvaluatedExpression} value.
 */
export interface PhysicalProperties {
  [propertyName: string]: Value;
}
