import { beforeEach, describe, expect, test } from "bun:test";
import { Effect, Exit, Layer, Option, Redacted, Schema, pipe } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { effunct } from "effective-modules";
import type { PipelineContext } from "jive-abstract-library";
import { PackageJsonSchema, type PackageJson } from "../../public/manifest";
import { ClientPackageImpl } from "../client-package/impl";
import { ConvexCliImpl } from "../convex-cli/impl";
import { ConvexCredential } from "../convex-credential/interface";
import { ConvexCredentialImpl } from "../convex-credential/impl";
import { ConvexDeploymentApiImpl } from "../convex-deployment-api/impl";
import { ConvexHttpImpl } from "../convex-http/impl";
import { ConvexManagementApiImpl } from "../convex-management-api/impl";
import type { ConvexDeployment } from "../convex-management-api/interface";
import { EnvironmentVariablesImpl } from "../environment-variables/impl";
import { backendModules } from "../index";
import { PackageImpl } from "../package/impl";
import { BackendImpl } from "./impl";

/**
 * The deploy hook's flow under each credential, every module but Backend replaced by a fake that logs its call.
 * Nothing here reaches Convex or npm.
 */

const context: PipelineContext = {
  provider: "Github",
  repository: { owner: "jive-sh", name: "server" },
  sourceBranch: "main",
  sourceCommitSha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  event: { type: "COMMIT" },
};

/** A manifest decoded by the real schema; Preview is a second environment when `previews` is on. */
function packageJson(input: { previews?: boolean } = {}): PackageJson {
  const environment = { environmentVariables: {}, customDomains: [] };
  return Schema.decodeUnknownSync(PackageJsonSchema)({
    $schema: "./package.schema.json",
    name: "@jive-sh/server",
    version: "0.1.0",
    license: "MIT",
    scripts: Object.fromEntries([
      "jive:cicd:get-config", "jive:cicd:build", "jive:cicd:audit", "jive:cicd:deploy:plan", "jive:cicd:upload-artifacts", "jive:cicd:deploy",
    ].map((hook) => [hook, "x"])),
    jive: {
      cicd: {
        deploy: { verb: "Deploy to", branches: { main: ["latest"] }, previews: input.previews ?? false, sequentially: true },
        runsOnPullRequests: true,
        runsOn: "ubuntu-latest",
        requiredSecrets: ["CONVEX_TEAM_ACCESS_TOKEN"],
      },
      "backend-convex": {
        team: 551884,
        project: "jive-server",
        region: "aws-us-east-1",
        environments: input.previews === true ? { latest: environment, Preview: environment } : { latest: environment },
        afterDeploy: { function: "deploys:record" },
      },
    },
  });
}

const KEY_DEPLOYMENT: ConvexDeployment = { name: "happy-otter-123", cloudUrl: "https://happy-otter-123.convex.cloud" };
const MINTED_DEPLOYMENT: ConvexDeployment = { name: "minted-deployment-1", cloudUrl: "https://minted-deployment-1.convex.cloud" };

let calls: Array<string> = [];
beforeEach(() => { calls = []; });

function layerFor(input: {
  credential: ConvexCredential;
  named?: { teamId: number; projectSlug: string; reference: Option.Option<string> };
  manifest?: PackageJson;
}) {
  const named = input.named ?? { teamId: 551884, projectSlug: "jive-server", reference: Option.some("latest") };
  return pipe(
    BackendImpl.Layer,
    Layer.provideMerge(Layer.mergeAll(
      PackageImpl.mockLayer({ *load() { return input.manifest ?? packageJson(); } }),
      ConvexCredentialImpl.mockLayer({
        *current() { return input.credential; },
        *deployKeyDeployment() {
          calls.push("ask which deployment the key names");
          return { deployment: KEY_DEPLOYMENT, ...named };
        },
      }),
      ConvexManagementApiImpl.mockLayer({
        *ensureProject() { calls.push("ensure project"); return { id: 1, slug: "jive-server", teamId: 551884 }; },
        *ensureDeployment() { calls.push("ensure deployment"); return MINTED_DEPLOYMENT; },
        *createDeployKey() { calls.push("mint deploy key"); return Redacted.make("minted-key"); },
        *deleteDeployKey() { calls.push("delete deploy key"); },
        *listCustomDomains() { calls.push("list custom domains"); return []; },
        *createCustomDomain() { calls.push("create custom domain"); },
      }),
      ConvexDeploymentApiImpl.mockLayer({
        *getCanonicalUrls(deployment) { return { convexCloud: deployment.cloudUrl, convexSite: deployment.cloudUrl.replace(".cloud", ".site") }; },
        *setCanonicalUrl() { calls.push("set canonical url"); },
      }),
      EnvironmentVariablesImpl.mockLayer({ *apply({ deployment }) { calls.push(`apply variables on ${deployment.name}`); } }),
      ConvexCliImpl.mockLayer({
        *deploy({ deployKey }) { calls.push(`push with ${Redacted.value(deployKey)}`); },
        *run({ deployKey, functionName }) { calls.push(`run ${functionName} with ${Redacted.value(deployKey)}`); },
      }),
      ClientPackageImpl.mockLayer({
        *checkPublishable() {},
        *plan() { return { deploy: false } as const; },
        *publish() { calls.push("publish client"); },
      }),
    )),
  );
}

function deploy(layer: ReturnType<typeof layerFor>, environment = "latest"): Promise<Exit.Exit<void, string>> {
  return Effect.runPromiseExit(pipe(
    effunct(function* () {
      yield* (yield* backendModules.Backend).deploy({ environment, context });
    })(),
    Effect.provide(layer),
  ));
}

const teamToken = ConvexCredential.TeamAccessToken({ token: Redacted.make("team-token") });
const deployKey = ConvexCredential.DeployKey({ key: Redacted.make("prod:happy-otter-123|secret"), deploymentName: "happy-otter-123" });

describe("with a team access token", () => {
  test("ensures the project and deployment, pushes with a key minted for the run, deletes it, and manages custom domains", async () => {
    expect(Exit.isSuccess(await deploy(layerFor({ credential: teamToken })))).toBe(true);
    expect(calls).toEqual([
      "ensure project",
      "ensure deployment",
      "apply variables on minted-deployment-1",
      "mint deploy key",
      "push with minted-key",
      "run deploys:record with minted-key",
      "delete deploy key",
      "list custom domains",
      "list custom domains",
    ]);
  });
});

describe("with a production deploy key", () => {
  test("deploys to the key's deployment with the key itself, touching no Management API", async () => {
    expect(Exit.isSuccess(await deploy(layerFor({ credential: deployKey })))).toBe(true);
    expect(calls).toEqual([
      "ask which deployment the key names",
      "apply variables on happy-otter-123",
      "push with prod:happy-otter-123|secret",
      "run deploys:record with prod:happy-otter-123|secret",
    ]);
  });

  async function refusal(input: Parameters<typeof layerFor>[0], environment?: string): Promise<string> {
    const exit = await deploy(layerFor(input), environment);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(calls.filter((call) => call !== "ask which deployment the key names")).toEqual([]);
    return JSON.stringify(exit);
  }

  test("refuses a key whose deployment is another team's, project's or environment's, before changing anything", async () => {
    expect(await refusal({ credential: deployKey, named: { teamId: 1, projectSlug: "jive-server", reference: Option.some("latest") } }))
      .toContain("team 1, not 551884");
    expect(await refusal({ credential: deployKey, named: { teamId: 551884, projectSlug: "other", reference: Option.some("latest") } }))
      .toContain('project \\"other\\", not \\"jive-server\\"');
    expect(await refusal({ credential: deployKey, named: { teamId: 551884, projectSlug: "jive-server", reference: Option.some("production") } }))
      .toContain('reference \\"production\\", not \\"latest\\"');
    expect(await refusal({ credential: deployKey, named: { teamId: 551884, projectSlug: "jive-server", reference: Option.none() } }))
      .toContain("reference");
  });

  test("refuses a Preview environment, which only a team access token can create", async () => {
    expect(await refusal({ credential: deployKey, manifest: packageJson({ previews: true }) }, "Preview")).toContain("only CONVEX_TEAM_ACCESS_TOKEN can create");
  });
});

describe("Convex HTTP under a deploy key", () => {
  test("a Management API call fails naming its step, before anything is sent; a deployment API call carries the key", async () => {
    const sent: Array<string> = [];
    const fakeConvex = HttpClient.make((request) => Effect.sync(() => {
      sent.push(`${request.url} ${request.headers["authorization"]}`);
      return HttpClientResponse.fromWeb(request, new Response(JSON.stringify({ convexCloudUrl: "c", convexSiteUrl: "s" }), { status: 200 }));
    }));
    const layer = pipe(
      ConvexHttpImpl.Layer,
      Layer.provideMerge(ConvexCredentialImpl.mockLayer({ *current() { return deployKey; } })),
      Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, fakeConvex)),
    );
    const management = await Effect.runPromiseExit(pipe(
      effunct(function* () {
        yield* (yield* backendModules.ConvexHttp).sendWithoutReply({ method: "POST", url: "https://api.convex.dev/v1/projects/1/create_deployment", auth: "Bearer", purpose: "create deployment \"latest\"" });
      })(),
      Effect.provide(layer),
    ));
    expect(JSON.stringify(management)).toContain("Could not create deployment \\\"latest\\\": that is a Management API call");
    expect(sent).toEqual([]);

    const deploymentApi = await Effect.runPromiseExit(pipe(
      effunct(function* () {
        yield* (yield* backendModules.ConvexHttp).sendWithoutReply({ method: "GET", url: "https://happy-otter-123.convex.cloud/api/v1/get_canonical_urls", auth: "Convex", purpose: "read" });
      })(),
      Effect.provide(layer),
    ));
    expect(Exit.isSuccess(deploymentApi)).toBe(true);
    expect(sent).toEqual(["https://happy-otter-123.convex.cloud/api/v1/get_canonical_urls Convex prod:happy-otter-123|secret"]);
  });
});
