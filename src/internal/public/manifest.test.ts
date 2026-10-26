import { expect, test } from "bun:test";
import { Schema } from "effect";
import { PackageJsonSchema } from "./manifest";

function manifest(overrides: { branches?: Record<string, string[]>; previews?: boolean; environments?: Record<string, unknown>; requiredSecrets?: string[] } = {}) {
  return {
    $schema: "./package.schema.json",
    name: "@example/server",
    version: "0.1.0",
    license: "MIT",
    scripts: Object.fromEntries([
      "jive:cicd:get-config", "jive:cicd:build", "jive:cicd:audit",
      "jive:cicd:deploy:plan", "jive:cicd:upload-artifacts", "jive:cicd:deploy",
    ].map((hook) => [hook, "x"])),
    jive: {
      cicd: {
        deploy: { verb: "Deploy to", branches: overrides.branches ?? { main: ["latest"] }, previews: overrides.previews ?? false, sequentially: true },
        runsOnPullRequests: true,
        runsOn: "ubuntu-latest",
        requiredSecrets: overrides.requiredSecrets ?? ["CONVEX_TEAM_ACCESS_TOKEN"],
      },
      "backend-convex": {
        team: 1,
        project: "example",
        region: "aws-us-east-1",
        environments: overrides.environments ?? { latest: { environmentVariables: {}, customDomains: [] } },
        afterDeploy: null,
      },
    },
  };
}

const empty = { environmentVariables: {}, customDomains: [] };
const decode = (value: unknown) => Schema.decodeUnknownSync(PackageJsonSchema)(value);

test("a package whose environments match its deploy targets decodes", () => {
  expect(decode(manifest()).jive["backend-convex"].project).toBe("example");
});

test("every deploy target needs an environment entry, and Preview does when previews are on", () => {
  expect(() => decode(manifest({ branches: { main: ["latest", "Staging"] } }))).toThrow(/no entry for "Staging"/);
  expect(() => decode(manifest({ previews: true }))).toThrow(/no entry for "Preview"/);
});

test("an environment nothing deploys to is rejected rather than ignored", () => {
  expect(() => decode(manifest({ environments: { latest: empty, Staging: empty } }))).toThrow(/"Staging" is not a deploy target/);
});

test("environment names must be usable as Convex deployment references", () => {
  expect(() => decode(manifest({ branches: { main: ["dev"] }, environments: { dev: empty } }))).toThrow(/reserves/);
  expect(() => decode(manifest({ branches: { main: ["QA"] }, environments: { QA: empty } }))).toThrow(/3 to 100/);
  expect(() => decode(manifest({ branches: { main: ["happy-otter-123"] }, environments: { "happy-otter-123": empty } }))).toThrow(/deployment name/);
});

test("Preview cannot have custom domains", () => {
  const domain = { domain: "api.example.com", destination: "convexSite", canonical: false };
  expect(() => decode(manifest({ previews: true, environments: { latest: empty, Preview: { environmentVariables: {}, customDomains: [domain] } } })))
    .toThrow(/cannot have custom domains/);
});

test("at most one canonical domain per destination", () => {
  const domains = ["a.example.com", "b.example.com"].map((domain) => ({ domain, destination: "convexCloud", canonical: true }));
  expect(() => decode(manifest({ environments: { latest: { environmentVariables: {}, customDomains: domains } } }))).toThrow(/at most one/);
});

test("a key pair's public variable cannot also be declared", () => {
  const environmentVariables = {
    JWT_PRIVATE_KEY: { generateOnce: { type: "es256KeyPair", publicJwksVariable: "JWT_JWKS" } },
    JWT_JWKS: { value: "x" },
  };
  expect(() => decode(manifest({ environments: { latest: { environmentVariables, customDomains: [] } } }))).toThrow(/written by JWT_PRIVATE_KEY/);
});

test("the team access token must be a required secret, since every deploy hook needs it", () => {
  expect(() => decode(manifest({ requiredSecrets: [] }))).toThrow(/CONVEX_TEAM_ACCESS_TOKEN/);
});
