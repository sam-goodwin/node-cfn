import { Properties } from "./property";

/**
 * The required Resources section declares the AWS resources that you want to include in the stack, such as an Amazon EC2 instance or an Amazon S3 bucket.
 *
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/resources-section-structure.html
 */
export interface Resources {
  /**
   * The logical ID must be alphanumeric (A-Za-z0-9) and unique within the template. Use the logical name to reference the resource in other parts of the template. For example, if you want to map an Amazon Elastic Block Store volume to an Amazon EC2 instance, you reference the logical IDs to associate the block stores with the instance.
   *
   * In addition to the logical ID, certain resources also have a physical ID, which is the actual assigned name for that resource, such as an EC2 instance ID or an S3 bucket name. Use the physical IDs to identify resources outside of AWS CloudFormation templates, but only after the resources have been created. For example, suppose you give an EC2 instance resource a logical ID of MyEC2Instance. When AWS CloudFormation creates the instance, AWS CloudFormation automatically generates and assigns a physical ID (such as i-28f9ba55) to the instance. You can use this physical ID to identify the instance and view its properties (such as the DNS name) by using the Amazon EC2 console. For resources that support custom names, you can assign your own names (physical IDs) to help you quickly identify resources. For example, you can name an S3 bucket that stores logs as MyPerformanceLogs. For more information, see Name type.
   */
  [logicalId: string]: Resource;
}

export interface Resource {
  Type: string;
  Properties: Properties;
}

export interface PhysicalResources {
  [logicalId: string]: PhysicalResource;
}

export interface PhysicalResource {
  Type: string;
  PhysicalId: string;
  Attributes: PhysicalProperties;
}

export type PhysicalProperty =
  | undefined
  | null
  | boolean
  | number
  | string
  | PhysicalProperty[]
  | {
      [key: string]: PhysicalProperty;
    };

export interface PhysicalProperties {
  [key: string]: PhysicalProperty;
}
