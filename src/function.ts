import { Expression } from "./expression";
import { Parameters } from "./parameter";
import { guard } from "./util";

export function isIntrinsicFunction(a: any): a is IntrinsicFunction {
  return (
    isRef(a) ||
    isFnGetAtt(a) ||
    isFnGetAZs(a) ||
    isFnImportValue(a) ||
    isFnJoin(a) ||
    isFnSelect(a) ||
    isFnSplit(a) ||
    isFnSub(a) ||
    isFnTransform(a) ||
    isFnBase64(a) ||
    isFnCidr(a) ||
    isFnFindInMap(a)
  );
}

export type IntrinsicFunction =
  | FnBase64
  | FnCidr
  | FnFindInMap
  | FnGetAtt
  | FnGetAZs
  | FnImportValue
  | FnJoin
  | FnSelect
  | FnSplit
  | FnSub
  | FnTransform
  | Ref;

export const isRef = guard<Ref>("Ref");

/**
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/intrinsic-function-reference-ref.html
 */
export interface Ref {
  Ref: string;
}

export const isFnGetAtt = guard<FnGetAtt>("Fn::GetAtt");

/**
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/intrinsic-function-reference-getatt.html
 */
export interface FnGetAtt {
  "Fn::GetAtt": [logicalNameOfResource: string, attributeName: string];
}

export const isFnGetAZs = guard<FnGetAZs>("Fn::GetAZs");

/**
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/intrinsic-function-reference-getavailabilityzones.html
 */
export interface FnGetAZs {
  "Fn::GetAZs": string;
}

export const isFnImportValue = guard<FnImportValue>("Fn::ImportValue");

/**
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/intrinsic-function-reference-importvalue.html
 */
export interface FnImportValue {
  "Fn::ImportValue": Expression;
}

export const isFnJoin = guard<FnJoin>("Fn::Join");

/**
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/intrinsic-function-reference-join.html
 */
export interface FnJoin {
  "Fn::Join": [delimiter: string, values: Expression[]];
}

export const isFnSelect = guard<FnSelect>("Fn::Select");

/**
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/intrinsic-function-reference-select.html
 */
export interface FnSelect {
  "Fn::Select": [index: number, listOfObjects: Expression[]];
}

export const isFnSplit = guard<FnSplit>("Fn::Split");

/**
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/intrinsic-function-reference-split.html
 */
export interface FnSplit {
  "Fn::Split": [delimiter: string, sourceString: Expression];
}

export const isFnSub = guard<FnSub>("Fn::Sub");

/**
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/intrinsic-function-reference-sub.html
 */
export interface FnSub {
  "Fn::Sub": [string: string, variables: { [varName: string]: Expression }];
}

export const isFnTransform = guard<FnTransform>("Fn::Transform");

/**
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/intrinsic-function-reference-transform.html
 */
export interface FnTransform {
  "Fn::Transform": {
    /**
     * The name of the macro you want to perform the processing.
     */
    Name: string;
    /**
     * The list parameters, specified as key-value pairs, to pass to the macro.
     */
    Parameters: Parameters;
  };
}

export const isFnBase64 = guard<FnBase64>("Fn::Base64");

/**
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/intrinsic-function-reference-base64.html
 */
export interface FnBase64 {
  "Fn::Base64": Expression;
}

export const isFnCidr = guard<FnCidr>("Fn::Cidr");

/**
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/intrinsic-function-reference-cidr.html
 */
export interface FnCidr {
  "Fn::Cidr": [
    // The user-specified CIDR address block to be split into smaller CIDR blocks.
    ipBlock: string,
    // The number of CIDRs to generate. Valid range is between 1 and 256.
    count: number,
    // The number of subnet bits for the CIDR. For example, specifying a value "8" for this parameter will create a CIDR with a mask of "/24".
    cidrBits: number
  ];
}

export const isFnFindInMap = guard<FnFindInMap>("Fn::FindInMap");

/**
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/intrinsic-function-reference-findinmap.html
 */
export interface FnFindInMap {
  "Fn::FindInMap": [
    // The logical name of a mapping declared in the Mappings section that contains the keys and values.
    MapName: string,
    // The top-level key name. Its value is a list of key-value pairs.
    TopLevelKey: Expression,
    // The second-level key name, which is set to one of the keys from the list assigned to TopLevelKey.
    SecondLevelKey: Expression
  ];
}
