import { IntrinsicFunction } from "./function";

/**
 * An Expression which evaluates to a string value.
 */
export type Expression =
  | IntrinsicFunction
  | null
  | string
  | number
  | boolean
  | Expression[]
  | {
      [key: string]: Expression;
    };

/**
 * A {@link EvaluatedExpression} is a raw JSON value that contains no un-evaluated {@link Expression}s
 */
export type EvaluatedExpression =
  | undefined
  | null
  | boolean
  | number
  | string
  | EvaluatedExpression[]
  | {
      [key: string]: EvaluatedExpression;
    };
