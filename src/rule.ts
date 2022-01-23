import { Expression } from "./expression";
import { AwsParameterType } from "./parameter";
import { guard } from "./util";

/**
 * The optional {@link Rules} section validates a parameter or a combination of parameters passed to a template during a stack creation or stack update. To use template rules, explicitly declare {@link Rules} in your template followed by an assertion. Use the rules section to validate parameter values before creating or updating resources.
 *
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/rules-section-structure.html
 */
export interface Rules {
  [ruleId: string]: Rule;
}

/**
 * A rule can include a {@link RuleCondition} property and must include an {@link Assertions} property. For each rule, you can define only one rule condition. You can define one or more asserts within the Assertions property. If you don't define a rule condition, the rule's assertions always take effect.
 *
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/rules-section-structure.html#rules-specific-intrinsic-section-structure
 */
export interface Rule {
  /**
   * Describes what values users can specify for a particular parameter.
   */
  Assertions: Assertion[];
  RuleCondition?: RuleCondition;
}

export interface Assertion {
  Assert: RuleCondition;
  AssertDescription?: string;
}

export type RuleCondition =
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

export const isFnEquals = guard<FnEquals>("Fn::Equals");

/**
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/intrinsic-function-reference-rules.html#fn-equals
 */
export interface FnEquals {
  "Fn::Equals": [left: Expression, right: Expression];
}

export const isFnNot = guard<FnNot>("Fn::Not");

/**
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/intrinsic-function-reference-rules.html#fn-not
 */
export interface FnNot {
  "Fn::Not": RuleCondition[];
}

export const isFnAnd = guard<FnAnd>("Fn::And");

/**
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/intrinsic-function-reference-rules.html#fn-and
 */
export interface FnAnd {
  "Fn::And": RuleCondition[];
}

export const isFnOr = guard<FnOr>("Fn::Or");

/**
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/intrinsic-function-reference-rules.html#fn-or
 */
export interface FnOr {
  "Fn::Or": RuleCondition[];
}

export const isFnContains = guard<FnContains>("Fn::Contains");

/**
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/intrinsic-function-reference-rules.html#fn-contains
 */
export interface FnContains {
  "Fn::Contains": [
    // A list of strings, such as "A", "B", "C"
    list_of_strings: Expression[],
    // A string, such as "A", that you want to compare against a list of strings.
    string: Expression
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
    list_of_strings: Expression[],
    // A string, such as "A", that you want to compare against a list of strings.
    string: Expression
  ];
}

export const isFnEachMemberIn = guard<FnEachMemberIn>("Fn::EachMemberIn");

/**
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/intrinsic-function-reference-rules.html#fn-eachmemberin
 */
export interface FnEachMemberIn {
  "Fn::EachMemberIn": [
    // A list of strings, such as "A", "B", "C". CloudFormation checks whether each member in the strings_to_check parameter is in the strings_to_match parameter.
    strings_to_check: Expression[],
    // A list of strings, such as "A", "B", "C". Each member in the strings_to_match parameter is compared against the members of the strings_to_check parameter.
    strings_to_match: Expression[]
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
    attribute: Expression
  ];
}

export const isFnValueOfAll = guard<FnValueOfAll>("Fn::ValueOfAll");

/**
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/intrinsic-function-reference-rules.html#fn-valueofall
 */
export interface FnValueOfAll {
  "Fn::ValueOfAll": [parameter_type: string, attribute: Expression];
}
