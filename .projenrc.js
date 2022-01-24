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
    "fast-json-patch",
    "immutable",
  ],
  devDeps: ["@types/immutable", "ts-node"],
  eslintOptions: {
    prettier: true,
  },
});

project.eslint.addOverride({
  rules: {
    "typescript-eslint/no-shadow": "off",
  },
});

project.synth();
