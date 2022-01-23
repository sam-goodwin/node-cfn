const { typescript } = require("projen");
const project = new typescript.TypeScriptProject({
  defaultReleaseBranch: "main",
  name: "node-cfn",
  bin: {
    "node-cfn": "lib/main.js",
  },
  deps: ["@aws-sdk/client-cloudcontrol", "fast-json-patch", "immutable"],
  devDeps: ["@types/immutable", "ts-node"],
  eslintOptions: {
    prettier: true,
  },
});
project.synth();
