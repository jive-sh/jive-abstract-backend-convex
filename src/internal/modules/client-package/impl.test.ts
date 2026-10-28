import { afterAll, beforeAll, expect, test } from "bun:test";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, Exit, Layer, Schema, pipe } from "effect";
import { effunct } from "effective-modules";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PackageJsonSchema } from "../../public/manifest";
import { backendModules } from "../index";
import { ClientPackageImpl } from "./impl";

/**
 * The client publish goes through Jive's provisioning when the manifest says so. One fake process plays GitHub's
 * ID-token endpoint, a Jive server whose `packages:provision` refuses, and the npm registry, which the manifest
 * names in `publishConfig.registry` so that no publish can reach npm whatever the code under test does.
 */

const requests: Array<{ path: string; method: string; body: string }> = [];
const fake = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    requests.push({ path: url.pathname, method: request.method, body: await request.text() });
    if (url.pathname === "/token") return Response.json({ value: "github-id-token" });
    if (url.pathname === "/api/action") {
      return Response.json({ status: "success", value: { status: "refused", reason: "the test's Jive server refuses" }, logLines: [] });
    }
    return new Response("{}", { status: 404 });
  },
});
const FAKE = `http://127.0.0.1:${fake.port}`;

const workDir = mkdtempSync(join(tmpdir(), "jive-backend-convex-client-"));
const originalDir = process.cwd();
const originalEnv = { url: process.env["ACTIONS_ID_TOKEN_REQUEST_URL"], token: process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"] };

beforeAll(() => {
  mkdirSync(join(workDir, "convex/_generated"), { recursive: true });
  for (const file of ["api.js", "api.d.ts", "dataModel.d.ts"]) writeFileSync(join(workDir, "convex/_generated", file), "export {};\n");
  process.chdir(workDir);
  process.env["ACTIONS_ID_TOKEN_REQUEST_URL"] = `${FAKE}/token?api-version=2.0`;
  process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"] = "request-token";
});

afterAll(() => {
  process.chdir(originalDir);
  for (const [name, value] of [["ACTIONS_ID_TOKEN_REQUEST_URL", originalEnv.url], ["ACTIONS_ID_TOKEN_REQUEST_TOKEN", originalEnv.token]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(workDir, { recursive: true, force: true });
  fake.stop(true);
});

const packageJson = Schema.decodeUnknownSync(PackageJsonSchema)({
  $schema: "./package.schema.json",
  name: "@example/server",
  version: "0.1.0",
  license: "MIT",
  scripts: Object.fromEntries([
    "jive:cicd:get-config", "jive:cicd:build", "jive:cicd:audit", "jive:cicd:deploy:plan", "jive:cicd:upload-artifacts", "jive:cicd:deploy",
  ].map((hook) => [hook, "x"])),
  dependencies: { convex: "^1.48.0" },
  publishConfig: { registry: `${FAKE}/` },
  jive: {
    cicd: {
      deploy: { verb: "Deploy to", branches: { main: ["latest"] }, previews: false, sequentially: true },
      runsOnPullRequests: true,
      runsOn: "ubuntu-latest",
      requiredSecrets: ["CONVEX_DEPLOY_KEY"],
    },
    "backend-convex": {
      team: 1,
      project: "example",
      clientPackageName: "@example/server-client",
      region: "aws-us-east-1",
      environments: { latest: { environmentVariables: {}, customDomains: [] } },
      afterDeploy: null,
      provisionWithJive: { serverUrl: FAKE },
    },
  },
});

test("a refusal from Jive stops the client publish before anything is packed or published", async () => {
  const exit = await Effect.runPromiseExit(pipe(
    effunct(function* () {
      yield* (yield* backendModules.ClientPackage).publish({
        packageJson,
        environment: "latest",
        context: { provider: "Github", repository: { owner: "o", name: "r" }, sourceBranch: "main", sourceCommitSha: "a".repeat(40), event: { type: "COMMIT" } },
        urls: { convexCloud: "https://example.convex.cloud", convexSite: "https://example.convex.site" },
      });
    })(),
    Effect.provide(pipe(ClientPackageImpl.Layer, Layer.provideMerge(BunFileSystem.layer))),
  ));
  expect(Exit.isFailure(exit)).toBe(true);
  expect(JSON.stringify(exit)).toContain("Jive refused to provision the npm package @example/server-client, so nothing was published: the test's Jive server refuses");

  const provision = requests.find((request) => request.path === "/api/action");
  expect(JSON.parse(provision!.body)).toMatchObject({ path: "packages:provision", args: { registry: "npm", packageName: "@example/server-client" } });
  expect(requests.filter((request) => request.method === "PUT")).toEqual([]);
}, 120_000);
