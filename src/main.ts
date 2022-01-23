#!/usr/bin/env node

import { Stack } from "./stack";
import { CloudFormationTemplate } from "./template";

export async function main() {
  const deployer = new Stack("my-stack");

  let state = await deployer.updateStack(template);
  console.log(state);
  await deployer.deleteStack();
}

const template: CloudFormationTemplate = {
  AWSTemplateFormatVersion: "2010-09-09",
  Resources: {
    MyStream: {
      Type: "AWS::Kinesis::Stream",
      Properties: {
        Name: "MyKinesisStream",
        RetentionPeriodHours: 168,
        ShardCount: 1,
        // StreamEncryption: {
        //   EncryptionType: "KMS",
        //   KeyId: "!Ref myKey",
        // },
        Tags: [
          {
            Key: "Environment",
            Value: "Production",
          },
        ],
      },
    },
  },
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
