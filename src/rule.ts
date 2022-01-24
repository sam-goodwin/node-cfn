import { EvaluatedExpression } from "./expression";
import { isRef, isRefString, parseRefString, Ref } from "./function";
import { AwsParameterType, ParameterValues, Parameters } from "./parameter";
import { guard, isDeepEqual } from "./util";

/**
 * The optional {@link Rules} section validates a parameter or a combination of parameters passed to a template during a stack creation or stack update. To use template rules, explicitly declare {@link Rules} in your template followed by an assertion. Use the rules section to validate parameter values before creating or updating resources.
 *
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/rules-section-structure.html
 */
export interface Rules {
  [ruleId: string]: Rule;
}

/**
 * Validate the {@link Rules} section of a {@link CloudFormationTemplate}.
 *
 * For each {@link Rule}, validate that the {@link parameterValues} comply with the {@link Assertions}.
 *
 * @param rules the {@link Rules} section of a {@link CloudFormationTemplate}.
 * @param parameters the {@link Parameter} definitions from the {@link CloudFormationTemplate}.
 * @param parameterValues the input {@link ParameterValues}.
 */
export function validateRules(
  rules: Rules,
  parameters: Parameters,
  parameterValues: ParameterValues
) {
  const errors = Object.entries(rules).reduce(
    (errors: string[], [ruleId, rule]) =>
      errors.concat(
        evaluateRule(rule, parameters, parameterValues).map(
          (errorMessage) => `Rule '${ruleId}' failed vaidation: ${errorMessage}`
        )
      ),
    []
  );

  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
}

/**
 * A {@link Rule} can include a {@link RuleFunction} property and must include an {@link Assertions} property. For each {@link RUle}, you can define only one {@link RuleFunction}. You can define one or more asserts within the Assertions property. If you don't define a {@link RuleFunction}, the {@link Rule}'s {@link Assertion}s always take effect.
 *
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/rules-section-structure.html#rules-specific-intrinsic-section-structure
 */
export interface Rule {
  /**
   * Describes what values users can specify for a particular {@link Parameter}.
   */
  Assertions: Assertion[];
  /**
   * Determines when a {@link Rule} takes effect.
   */
  RuleCondition?: RuleFunction;
}

/**
 * Evaluates a {@link Rule} and returns an array of {@link Assertion} errors.
 *
 * @param rule the {@link Rule} to evaluate.
 * @param parameters the {@link CloudFormationTemplate}'s {@link Parameters}.
 * @param parameterValues input values of the {@link ParameterValues}.
 * @returns an array of {@link Assertion} errors.
 */
export function evaluateRule(
  rule: Rule,
  parameters: Parameters,
  parameterValues: ParameterValues
): string[] {
  if (
    rule.RuleCondition === undefined ||
    evaluateRuleExpressionToBoolean(
      rule.RuleCondition,
      parameters,
      parameterValues
    )
  ) {
    return rule.Assertions.reduce((errors: string[], assertion) => {
      const error = evaluateAssertion(assertion, parameters, parameterValues);
      return error === undefined ? errors : [...errors, error];
    }, []);
  } else {
    return [];
  }
}

/**
 * An {@link Assertion} applies a {@link RuleFunction} to the {@link Stack}'s {@link ParameterValues}.
 */
export interface Assertion {
  /**
   * A {@link RuleFunction} to validate the {@link ParameterValues} input to the {@link Stack}.
   */
  Assert: RuleFunction;
  /**
   * A custom description to output when {@link Assert} evaluates to `false`.
   *
   * @default - generic message derived from the Assertion.
   */
  AssertDescription?: string;
}

/**
 * Evalautes an {@link Assertion} against a {@link CloudFormationTemplate}'s {@link Parameters}.
 *
 * @param assertion the {@link Assertion} condition to evaluate.
 * @param parameters the {@link CloudFormationTemplate}'s {@link Parameters}.
 * @param parameterValues input values of the {@link ParameterValues}.
 * @returns an array of {@link Assertion} errors.
 */
export function evaluateAssertion(
  assertion: Assertion,
  parameters: Parameters,
  parameterValues: ParameterValues
): string | undefined {
  if (
    !evaluateRuleExpressionToBoolean(
      assertion.Assert,
      parameters,
      parameterValues
    )
  ) {
    return assertion.AssertDescription ?? JSON.stringify(assertion.Assert);
  } else {
    return undefined;
  }
}

/**
 * A {@link RuleFunction} is an Intrinsic Function which evaluates to a Boolean value.
 *
 * {@link RuleFunction}s are used within {@link Rule}s and {@link Assertion}s during {@link Stack} deployment.
 *
 * @see {@link Rule}
 * @see {@link FnAnd}
 * @see {@link FnContains}
 * @see {@link FnEachMemberEquals}
 * @see {@link FnEachMemberIn}
 * @see {@link FnEquals}
 * @see {@link FnNot}
 * @see {@link FnOr}
 * @see {@link FnRefAll}
 * @see {@link FnValueOf}
 * @see {@link FnValueOfAll}
 */
export type RuleFunction =
  | FnAnd
  | FnContains
  | FnEachMemberEquals
  | FnEachMemberIn
  | FnEquals
  | FnNot
  | FnOr
  | FnRefAll
  | FnValueOf
  | FnValueOfAll;

/**
 * You can't use another function within the Fn::ValueOf and Fn::ValueOfAll functions. However, you can use the {@link Ref} within all other {@link RuleFunction}s.
 *
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/intrinsic-function-reference-rules.html#supported-rule-functions
 */
export type RuleExpression = RuleFunction | Ref | EvaluatedExpression;

/**
 * Evaluate a {@link RuleFunction} to a `boolean`.
 *
 * @param rule the {@link RuleFunction} to evaluate.
 * @param parameters the {@link CloudFormationTemplate}'s {@link Parameters}.
 * @param parameterValues input values of the {@link ParameterValues}.
 * @returns the evaluated `boolean` value of the {@link rule}.
 * @throws an Error if the {@link rule} does not evaluate to a `boolean`.
 */
function evaluateRuleExpressionToBoolean(
  rule: RuleFunction,
  parameters: Parameters,
  parameterValues: ParameterValues
): boolean {
  const result = evaluateRuleExpression(rule, parameters, parameterValues);
  if (typeof result === "boolean") {
    return result;
  } else {
    throw new Error(
      `rule must evaluate to a Boolean, but evalauted to ${typeof result}`
    );
  }
}

/**
 * Evaluate the {@link expr} against the input {@link parameterValues}.
 *
 * @param expr the {@link RuleExpression} to evaluate.
 * @param parameters the {@link Parameter} definitions.
 * @param parameterValues the input {@link ParameterValues}.
 */
export function evaluateRuleExpression(
  expr: RuleExpression,
  parameters: Parameters,
  parameterValues: ParameterValues
): EvaluatedExpression {
  if (
    expr === null ||
    expr === undefined ||
    typeof expr === "boolean" ||
    typeof expr === "number"
  ) {
    return expr;
  } else if (Array.isArray(expr)) {
    return expr.map(evaluate);
  } else if (typeof expr === "string") {
    if (isRefString(expr)) {
      return evaluate(parseRefString(expr));
    } else {
      return expr;
    }
  } else if (isRef(expr)) {
    if (expr.Ref in parameters) {
      const paramVal =
        parameterValues[expr.Ref] ?? parameters[expr.Ref].Default;
      if (paramVal === undefined) {
        throw new Error(`undefined parameter value ${expr.Ref}`);
      }
      return paramVal;
    } else {
      throw new Error(
        `Logical ID ${expr.Ref} is not a Parameter. Rule Functions can only reference the Parameters.`
      );
    }
  } else if (isFnRefAll(expr)) {
    return Object.entries(parameters)
      .map(([paramName, paramDef]) =>
        paramDef.Type === expr["Fn::RefAll"]
          ? parameterValues[paramName]
          : undefined
      )
      .filter((paramVal) => paramVal !== undefined);
  } else if (isFnEquals(expr)) {
    const [left, right] = expr["Fn::Equals"].map(evaluate);
    return isDeepEqual(left, right);
  } else if (isFnNot(expr)) {
    const [condition] = expr["Fn::Not"].map(evaluate);
    if (typeof condition === "boolean") {
      return condition;
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
    return expr["Fn::And"].map(evaluate).reduce((a, b) => {
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
    return expr["Fn::Or"].map(evaluate).reduce((a, b) => {
      if (typeof b !== "boolean") {
        throw new Error(
          `Malformed input to Fn::Or - expected a boolean but received ${typeof b}`
        );
      }
      return a || b;
    }, false);
  } else if (isFnContains(expr)) {
    const [listOfStrings, string] = expr["Fn::Contains"].map(evaluate);

    assertIsListOfStrings(listOfStrings, "listOfStrings");
    assertIsString(string, "string");

    return listOfStrings.includes(string);
  } else if (isFnEachMemberEquals(expr)) {
    const [listOfStrings, string] = expr["Fn::EachMemberEquals"].map(evaluate);

    assertIsListOfStrings(listOfStrings, "listOfStrings");
    assertIsString(string, "string");

    return listOfStrings.find((s) => s !== string) === undefined;
  } else if (isFnEachMemberIn(expr)) {
    const [stringsToCheck, stringsToMatch] =
      expr["Fn::EachMemberIn"].map(evaluate);

    assertIsListOfStrings(stringsToCheck, "stringsToCheck");
    assertIsListOfStrings(stringsToMatch, "stringsToMatch");

    return stringsToCheck.find(
      (check) => stringsToMatch.find((match) => check === match) !== undefined
    );
  } else if (isFnValueOf(expr)) {
    throw new Error("Fn::ValueOf is not yet supported");
  } else if (isFnValueOfAll(expr)) {
    throw new Error("Fn::ValueOfAll is not yet supported");
  } else {
    return expr;
  }

  function evaluate(e: RuleExpression[] | RuleExpression): EvaluatedExpression {
    return evaluateRuleExpression(e as any, parameters, parameterValues) as any;
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

export const isFnEquals = guard<FnEquals>("Fn::Equals");

/**
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/intrinsic-function-reference-rules.html#fn-equals
 */
export interface FnEquals {
  "Fn::Equals": [left: RuleExpression, right: RuleExpression];
}

export const isFnNot = guard<FnNot>("Fn::Not");

/**
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/intrinsic-function-reference-rules.html#fn-not
 */
export interface FnNot {
  "Fn::Not": [RuleFunction];
}

export const isFnAnd = guard<FnAnd>("Fn::And");

/**
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/intrinsic-function-reference-rules.html#fn-and
 */
export interface FnAnd {
  "Fn::And": RuleFunction[];
}

export const isFnOr = guard<FnOr>("Fn::Or");

/**
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/intrinsic-function-reference-rules.html#fn-or
 */
export interface FnOr {
  "Fn::Or": RuleFunction[];
}

export const isFnContains = guard<FnContains>("Fn::Contains");

/**
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/intrinsic-function-reference-rules.html#fn-contains
 */
export interface FnContains {
  "Fn::Contains": [
    // A list of strings, such as "A", "B", "C"
    list_of_strings: RuleExpression[],
    // A string, such as "A", that you want to compare against a list of strings.
    string: RuleExpression
  ];
}

export const isFnEachMemberEquals = guard<FnEachMemberEquals>(
  "Fn::EachMemberEquals"
);

/**
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/intrinsic-function-reference-rules.html#fn-eachmemberequals
 */
export interface FnEachMemberEquals {
  "Fn::EachMemberEquals": [
    // A list of strings, such as "A", "B", "C".
    list_of_strings: RuleExpression[],
    // A string, such as "A", that you want to compare against a list of strings.
    string: RuleExpression
  ];
}

export const isFnEachMemberIn = guard<FnEachMemberIn>("Fn::EachMemberIn");

/**
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/intrinsic-function-reference-rules.html#fn-eachmemberin
 */
export interface FnEachMemberIn {
  "Fn::EachMemberIn": [
    // A list of strings, such as "A", "B", "C". CloudFormation checks whether each member in the strings_to_check parameter is in the strings_to_match parameter.
    strings_to_check: RuleExpression[],
    // A list of strings, such as "A", "B", "C". Each member in the strings_to_match parameter is compared against the members of the strings_to_check parameter.
    strings_to_match: RuleExpression[]
  ];
}

export const isFnRefAll = guard<FnRefAll>("Fn::RefAll");

/**
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/intrinsic-function-reference-rules.html#fn-refall
 */
export interface FnRefAll {
  /**
   * An AWS-specific parameter type, such as AWS::EC2::SecurityGroup::Id or AWS::EC2::VPC::Id. For more information, see {@link AwsParameterType}.
   */
  "Fn::RefAll": AwsParameterType;
}

export const isFnValueOf = guard<FnValueOf>("Fn::ValueOf");

/**
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/intrinsic-function-reference-rules.html#fn-valueof
 */
export interface FnValueOf {
  "Fn::ValueOf": [
    // The name of a parameter for which you want to retrieve attribute values. The parameter must be declared in the Parameters section of the template.
    parameter_logical_id: string,
    // The name of an attribute from which you want to retrieve a value. For more information about attributes, see Supported Attributes.
    attribute: RuleExpression
  ];
}

export const isFnValueOfAll = guard<FnValueOfAll>("Fn::ValueOfAll");

/**
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/intrinsic-function-reference-rules.html#fn-valueofall
 */
export interface FnValueOfAll {
  "Fn::ValueOfAll": [parameter_type: string, attribute: RuleExpression];
}
