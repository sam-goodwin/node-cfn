// need to define how to create/update/delete a resource of type X when encountered.
/**
 * registration and discovery - For now, manually register.
 *  Default deploy registers, collection of key to object with interfaces.
 *   Can use object with more definitions.
 * Separate promise for
 */

import { CloudControlHandler } from "./module-handlers/cloud-control";
import { EventBusModuleHandler } from "./module-handlers/event-bus";
import { InlinePolicyHandler } from "./module-handlers/inline-policy";
import { ManagedPolicyHandler } from "./module-handlers/managed-policy";
import { QueuePolicyHandler } from "./module-handlers/queue-policy";
import type { PhysicalResource, ResourceType } from "./resource";

export interface CreateRequest<Properties> {
  logicalId: string;
  resourceType: ResourceType;
  definition: Properties;
}

export interface UpdateRequest<Properties> extends CreateRequest<Properties> {
  previous: PhysicalResource<Properties>;
}

export interface DeleteRequest<Properties> {
  logicalId: string;
  resourceType: ResourceType;
  physicalId: string;
  previous: PhysicalResource<Properties>;
  /**
   * True when the resource was already snapshot before the delete.
   */
  snapshotDone: boolean;
}

export interface ModuleOperationResultMetadata {
  /**
   * Minimum milliseconds to wait after all deployment operations are complete.
   *
   * If it takes around 10s for a Policy update (paddingMillis: 10000) to be reflected (consistency), but
   * the rest of the deployment only takes 5s, we will wait at least 5s before completing the deployment.
   *
   * TODO: replace with a consistent vs referable API.
   */
  paddingMillis?: number;
}

export type ModuleOperationResult<Properties = any> = Promise<
  | PhysicalResource<Properties>
  | ({ resource: PhysicalResource<Properties> } & ModuleOperationResultMetadata)
>;

/**
 * TODO: support optional snapshot.
 */
export interface ModuleHandler<Properties = any> {
  create(request: CreateRequest<Properties>): ModuleOperationResult<Properties>;
  update(request: UpdateRequest<Properties>): ModuleOperationResult<Properties>;
  delete(
    request: DeleteRequest<Properties>
  ): Promise<void | ModuleOperationResultMetadata>;
}

export type ModuleHandlerInitializer<Properties = any> = (
  props: ModuleHandlerProps
) => ModuleHandler<Properties>;

export const DEFAULT_MODULE_HANDLER_KEY = "FORMLESS_DEFAULT";

export const DefaultModuleHandlers: Record<
  string,
  ModuleHandler | ModuleHandlerInitializer
> = {
  "AWS::Events::EventBus": (props) => new EventBusModuleHandler(props),
  "AWS::Events::Rule": (props) => new EventBusModuleHandler(props),
  "AWS::IAM::Policy": (props) => new InlinePolicyHandler(props),
  "AWS::IAM::ManagedPolicy": (props) => new ManagedPolicyHandler(props),
  "AWS::SQS::QueuePolicy": (props) => new QueuePolicyHandler(props),
  [DEFAULT_MODULE_HANDLER_KEY]: (props) => new CloudControlHandler(props),
};

export interface ModuleHandlerProps {
  sdkConfig: any;
  account: string;
  region: string;
}

export function initModuleHandlers(
  props: ModuleHandlerProps,
  moduleHandlers: Record<string, ModuleHandler | ModuleHandlerInitializer>
): Record<string, ModuleHandler> {
  return Object.fromEntries(
    Object.entries(moduleHandlers).map(([key, handler]) => [
      key,
      typeof handler === "function" ? handler(props) : handler,
    ])
  );
}

export class ModuleHandlerProvider {
  private readonly __cache: Record<string, ModuleHandler>;
  constructor(
    private props: ModuleHandlerProps,
    private moduleHandlers: Record<
      string,
      ModuleHandler | ModuleHandlerInitializer
    >
  ) {
    this.__cache = {};
  }

  getHandler(key: string): ModuleHandler<any> {
    if (key in this.__cache) {
      return this.__cache[key];
    } else if (key in this.moduleHandlers) {
      const handler = this.moduleHandlers[key];
      return (this.__cache[key] =
        typeof handler === "function" ? handler(this.props) : handler);
    } else if (DEFAULT_MODULE_HANDLER_KEY in this.moduleHandlers) {
      return this.getHandler(DEFAULT_MODULE_HANDLER_KEY);
    } else {
      throw new Error(
        `No handler was found for ${key} and no default handler (${DEFAULT_MODULE_HANDLER_KEY}) was provided.`
      );
    }
  }
}
