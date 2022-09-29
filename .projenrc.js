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
    "fast-json-patch",
    "immutable",
    "cdk-assets",
    "aws-sdk",
  ],
  devDeps: ["@types/immutable", "ts-node"],
  eslintOptions: {
    prettier: true,
  },
  releaseToNpm: true,
  docgen: true,
  gitignore: [".DS_Store"],
  tsconfig: {
    compilerOptions: { target: "es2020", lib: ["es2020"] },
  },
});

project.synth();
