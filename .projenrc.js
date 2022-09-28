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
    "fast-json-patch",
    "immutable",
  ],
  devDeps: ["@types/immutable", "ts-node"],
  eslintOptions: {
    prettier: true,
  },
  releaseToNpm: true,
  docgen: true,
  gitignore: [".DS_Store"],
});

project.synth();
