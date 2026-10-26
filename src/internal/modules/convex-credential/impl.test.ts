import { describe, expect, test } from "bun:test";
import { Effect, Exit, Layer, Option, Redacted, pipe } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { effunct } from "effective-modules";
import { backendModules } from "../index";
import { PackageImpl } from "../package/impl";
import { ConvexCredentialImpl, credentialFrom, productionDeployKeyName } from "./impl";

const PROD_KEY = "prod:happy-otter-123|secret-part";

async function failure(effect: Effect.Effect<unknown, string>): Promise<string> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) throw new Error("expected a failure");
  return JSON.stringify(exit.cause);
}

describe("credentialFrom", () => {
  test("a team access token the manifest names", async () => {
    const credential = await Effect.runPromise(credentialFrom("CONVEX_TEAM_ACCESS_TOKEN", { CONVEX_TEAM_ACCESS_TOKEN: "team-token" }));
    expect(credential._tag).toBe("TeamAccessToken");
    expect(credential._tag === "TeamAccessToken" && Redacted.value(credential.token)).toBe("team-token");
  });

  test("a production deploy key the manifest names, with the deployment it names", async () => {
    const credential = await Effect.runPromise(credentialFrom("CONVEX_DEPLOY_KEY", { CONVEX_DEPLOY_KEY: PROD_KEY }));
    expect(credential).toMatchObject({ _tag: "DeployKey", deploymentName: "happy-otter-123" });
  });

  test("both set is refused, whichever the manifest names", async () => {
    const both = { CONVEX_TEAM_ACCESS_TOKEN: "team-token", CONVEX_DEPLOY_KEY: PROD_KEY };
    expect(await failure(credentialFrom("CONVEX_TEAM_ACCESS_TOKEN", both))).toContain("Both CONVEX_TEAM_ACCESS_TOKEN and CONVEX_DEPLOY_KEY are set");
    expect(await failure(credentialFrom("CONVEX_DEPLOY_KEY", both))).toContain("unset CONVEX_TEAM_ACCESS_TOKEN");
  });

  test("the named credential unset is refused, even when the other one is set", async () => {
    expect(await failure(credentialFrom("CONVEX_DEPLOY_KEY", {}))).toContain("CONVEX_DEPLOY_KEY is not set");
    expect(await failure(credentialFrom("CONVEX_DEPLOY_KEY", { CONVEX_TEAM_ACCESS_TOKEN: "team-token" }))).toContain("CONVEX_DEPLOY_KEY is not set");
    expect(await failure(credentialFrom("CONVEX_TEAM_ACCESS_TOKEN", { CONVEX_TEAM_ACCESS_TOKEN: "" }))).toContain("CONVEX_TEAM_ACCESS_TOKEN is not set");
  });

  test("a dev or preview deploy key is refused without echoing it", async () => {
    for (const key of ["dev:joyful-jaguar-123|secret-part", "preview:team:project|secret-part", "happy-otter-123|secret-part"]) {
      const message = await failure(credentialFrom("CONVEX_DEPLOY_KEY", { CONVEX_DEPLOY_KEY: key }));
      expect(message).toContain("not a production deploy key");
      expect(message).not.toContain("secret-part");
    }
  });
});

test("productionDeployKeyName reads the deployment from a prod key only", () => {
  expect(productionDeployKeyName(PROD_KEY)).toEqual(Option.some("happy-otter-123"));
  expect(productionDeployKeyName("dev:happy-otter-123|x")).toEqual(Option.none());
});

describe("deployKeyDeployment", () => {
  const asked: Array<{ url: string; body: string }> = [];
  const fakeConvex = HttpClient.make((request) => Effect.gen(function* () {
    const body = request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
    asked.push({ url: request.url, body });
    const reply = request.url.endsWith("/deployment/url_for_key")
      ? JSON.stringify("https://happy-otter-123.convex.cloud")
      : JSON.stringify({ team: "jive", project: "jive-server", teamId: 551884, projectId: 1, deploymentId: 2, reference: "latest", isDefault: true });
    return HttpClientResponse.fromWeb(request, new Response(reply, { status: 200 }));
  }));
  const layer = pipe(
    ConvexCredentialImpl.Layer,
    Layer.provideMerge(PackageImpl.mockLayer({})),
    Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, fakeConvex)),
  );

  test("asks Convex, with the key alone, for the deployment's URL, team, project and reference", async () => {
    const named = await Effect.runPromise(pipe(
      effunct(function* () {
        return yield* (yield* backendModules.ConvexCredential).deployKeyDeployment({ key: Redacted.make(PROD_KEY), deploymentName: "happy-otter-123" });
      })(),
      Effect.provide(layer),
    ));
    expect(named).toEqual({
      deployment: { name: "happy-otter-123", cloudUrl: "https://happy-otter-123.convex.cloud" },
      teamId: 551884,
      projectSlug: "jive-server",
      reference: Option.some("latest"),
    });
    expect(asked.map((call) => call.url)).toEqual([
      "https://api.convex.dev/api/deployment/url_for_key",
      "https://api.convex.dev/api/deployment/team_and_project_for_key",
    ]);
    expect(asked.every((call) => JSON.parse(call.body).deployKey === PROD_KEY)).toBe(true);
  });
});
