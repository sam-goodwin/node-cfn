const { typescript } = require("projen");
const project = new typescript.TypeScriptProject({
  defaultReleaseBranch: "main",
  name: "node-cfn",
  bin: {
    "node-cfn": "lib/main.js",
  },
  deps: [
    "@aws-sdk/client-cloudcontrol",
    "@aws-sdk/client-ssm",
    "@aws-sdk/client-eventbridge",
    "@aws-sdk/client-iam",
    "@aws-sdk/client-sts",
    "@aws-sdk/client-sqs",
    "@aws-sdk/client-secrets-manager",
    "@aws-sdk/client-lambda",
    "chalk@4",
    "short-uuid",
    "commander",
    "fast-json-patch",
    "immutable",
    "cdk-assets",
    "aws-sdk",
  ],
  devDeps: ["@types/immutable", "ts-node", "@types/node"],
  eslintOptions: {
    prettier: true,
  },
  releaseToNpm: true,
  docgen: true,
  minNodeVersion: "16.0.0",
  gitignore: [".DS_Store"],
  tsconfig: {
    compilerOptions: { target: "es2020", lib: ["es2020"] },
  },
});

project.synth();
