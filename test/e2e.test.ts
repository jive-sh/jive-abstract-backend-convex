/**
 * Runs all six hooks of the built `jive-backend-convex` CLI against the fixture backend in `test/fixture`,
 * on a throwaway Convex project in the fixture's team, which is deleted afterwards. The fixture's client
 * is published to an npm registry this test serves itself, never to npm. The same process plays GitHub's
 * ID-token endpoint and a Jive server's `packages:provision` for the deploy-key run, whose client publish goes
 * through provisioning.
 *
 * Needs CONVEX_TEAM_ACCESS_TOKEN (a token for the fixture's team) and a prior `bun run jive:cicd:build`,
 * which installs the CLI this test runs.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";

const REPO_ROOT = resolve(import.meta.dir, "..");
const CLI = resolve(REPO_ROOT, "node_modules/.bin/jive-backend-convex");
const MANAGEMENT_API = "https://api.convex.dev/v1";
const STALE_PROJECT_AGE_MS = 2 * 60 * 60 * 1000;
const PROJECT_PREFIX = "jive-abstract-backend-convex-e2e-";
const HOOK_TIMEOUT_MS = 10 * 60 * 1000;

const token = process.env["CONVEX_TEAM_ACCESS_TOKEN"];
if (token === undefined || token === "") {
  throw new Error("CONVEX_TEAM_ACCESS_TOKEN is not set; the end-to-end test needs a Convex team access token for the fixture's team");
}
if (!existsSync(CLI)) throw new Error(`${CLI} does not exist; run \`bun run jive:cicd:build\` first`);

const fixtureManifest = JSON.parse(readFileSync(resolve(import.meta.dir, "fixture/package.json"), "utf-8"));
const team: number = fixtureManifest.jive["backend-convex"].team;
const fixtureClientName: string = fixtureManifest.jive["backend-convex"].clientPackageName;
const project = `${PROJECT_PREFIX}${randomBytes(4).toString("hex")}`;
const sha = randomBytes(20).toString("hex");
const workDir = mkdtempSync(join(tmpdir(), "jive-backend-convex-e2e-"));

/** The parts of npm's registry protocol `npm publish` and `npm view` (the deploy's version check) use. */
const published = new Map<string, { distTags: Record<string, string>; tarballs: Map<string, Buffer> }>();
/** What the fake Jive server and registry were asked, in order, to check provisioning comes before the publish. */
const events: Array<string> = [];
const registry = Bun.serve({
  port: 0,
  async fetch(request) {
    const path = decodeURIComponent(new URL(request.url).pathname.slice(1));
    if (path === "-/github-id-token") return Response.json({ value: "e2e-github-id-token" });
    if (path === "api/action" && request.method === "POST") {
      const call = await request.json() as { path: string; args: { packageName: string } };
      events.push(`${call.path} ${call.args.packageName}`);
      return Response.json({ status: "success", value: { status: "ready" }, logLines: [] });
    }
    if (request.method === "PUT") {
      const body = await request.json() as { name: string; "dist-tags": Record<string, string>; _attachments: Record<string, { data: string }>; versions: Record<string, unknown> };
      const entry = published.get(body.name) ?? { distTags: {}, tarballs: new Map() };
      const [version] = Object.keys(body.versions);
      const [attachment] = Object.values(body._attachments);
      entry.tarballs.set(version!, Buffer.from(attachment!.data, "base64"));
      events.push(`publish ${body.name}@${version}`);
      Object.assign(entry.distTags, body["dist-tags"]);
      published.set(body.name, entry);
      return new Response("{}", { status: 201 });
    }
    const document = published.get(path);
    if (document !== undefined) {
      const versions = Object.fromEntries([...document.tarballs.keys()].map((version) => [
        version,
        { name: path, version, dist: { tarball: `${registryUrl}/${path}/-/${version}.tgz` } },
      ]));
      return Response.json({ name: path, "dist-tags": document.distTags, versions });
    }
    const slash = path.lastIndexOf("/");
    const entry = published.get(path.slice(0, slash));
    return entry?.tarballs.has(path.slice(slash + 1)) ? new Response("{}") : new Response("{}", { status: 404 });
  },
});
const registryUrl = `http://127.0.0.1:${registry.port}`;

function writeManifest(version: string): void {
  const manifest = structuredClone(fixtureManifest);
  manifest.version = version;
  manifest.jive["backend-convex"].project = project;
  manifest.publishConfig = { registry: registryUrl };
  writeFileSync(join(workDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * The fixture as a package deploying with a production deploy key: one environment, `latest`, no previews or
 * custom domains (a deploy key cannot reach the Management API that makes them), and its client publish provisioned
 * by the fake Jive server.
 */
function writeDeployKeyManifest(version: string): void {
  const manifest = structuredClone(fixtureManifest);
  manifest.version = version;
  manifest.publishConfig = { registry: registryUrl };
  manifest.jive.cicd.deploy = { ...manifest.jive.cicd.deploy, branches: { main: ["latest"] }, previews: false };
  manifest.jive.cicd.requiredSecrets = ["CONVEX_DEPLOY_KEY"];
  const backend = manifest.jive["backend-convex"];
  backend.project = project;
  backend.environments = {
    latest: { environmentVariables: { GREETING: { value: "hello from latest" }, CONNECTION_KEY: backend.environments.Staging.environmentVariables.CONNECTION_KEY }, customDomains: [] },
  };
  backend.provisionWithJive = { serverUrl: registryUrl };
  writeFileSync(join(workDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * The actions this abstract's README says a production deploy key needs
 * (https://docs.convex.dev/team-management/role-actions#data-plane-and-runtime); the deploy-key run proves they suffice.
 */
const DEPLOY_KEY_ACTIONS = [
  "deployment:deploy",
  "deployment:env:view",
  "deployment:env:write",
  "deployment:functions:runInternalQueries",
  "deployment:functions:runInternalMutations",
  "deployment:functions:runInternalActions",
];

async function mintProductionDeployKey(deployment: Deployment, name: string): Promise<string> {
  const { deployKey } = await management<{ deployKey: string }>("POST", `/deployments/${deployment.name}/create_deploy_key`, {
    name,
    expiresAt: Date.now() + 40 * 60_000,
    allowedActions: DEPLOY_KEY_ACTIONS,
  });
  return deployKey;
}

function context(event: object, sourceCommitSha = sha) {
  return JSON.stringify({ provider: "Github", repository: { owner: "jive-sh", name: "jive-abstract-backend-convex" }, sourceBranch: "main", sourceCommitSha, event });
}

async function hook(name: string, env: Record<string, string> = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([CLI, "cicd", name], {
    cwd: workDir,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  process.stderr.write(`--- ${name} (exit ${exitCode})\n${stderr}`);
  return { exitCode, stdout, stderr };
}

async function management<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${MANAGEMENT_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  const text = await response.text();
  return (text === "" ? null : JSON.parse(text)) as T;
}

interface Deployment { name: string; deploymentType: string; reference: string; previewIdentifier?: string | null; deploymentUrl: string }

async function deployments(): Promise<Deployment[]> {
  const found = await management<{ id: number }>("GET", `/teams/${team}/projects/${project}`);
  return management<Deployment[]>("GET", `/projects/${found.id}/list_deployments`);
}

async function environmentVariables(deployment: Deployment): Promise<Record<string, string>> {
  const response = await fetch(`${deployment.deploymentUrl}/api/v1/list_environment_variables`, { headers: { Authorization: `Convex ${token}` } });
  return ((await response.json()) as { environmentVariables: Record<string, string> }).environmentVariables;
}

async function latestDeploy(convexUrl: string): Promise<{ sourceCommitSha: string; environment: string; greeting: string }> {
  const response = await fetch(`${convexUrl}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "deploys:latest", args: {}, format: "json" }),
  });
  const reply = await response.json() as { status: string; value: { sourceCommitSha: string; environment: string; greeting: string } };
  expect(reply.status).toBe("success");
  return reply.value;
}

/** Unpacks one file from a published tarball (npm's tarballs are gzipped tar with a `package/` root). */
function fileInTarball(tarball: Buffer, path: string): string {
  const tar = gunzipSync(tarball);
  for (let offset = 0; offset + 512 <= tar.length;) {
    const name = tar.subarray(offset, offset + 100).toString().replace(/\0.*$/s, "");
    const size = Number.parseInt(tar.subarray(offset + 124, offset + 136).toString().replace(/\0.*$/s, "").trim() || "0", 8);
    if (name === `package/${path}`) return tar.subarray(offset + 512, offset + 512 + size).toString();
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${path} is not in the tarball`);
}

/** Deletes projects earlier runs of this test left behind when they died before cleaning up. */
async function deleteStaleProjects(): Promise<void> {
  const { items } = await management<{ items: Array<{ id: number; slug: string; createTime: number }> }>("GET", `/teams/${team}/projects`);
  for (const stale of items.filter((p) => p.slug.startsWith(PROJECT_PREFIX) && Date.now() - p.createTime > STALE_PROJECT_AGE_MS)) {
    await management("POST", `/projects/${stale.id}/delete`);
  }
}

beforeAll(async () => {
  await deleteStaleProjects();
  cpSync(resolve(import.meta.dir, "fixture"), workDir, { recursive: true, filter: (source) => !source.includes("node_modules") });
  writeFileSync(join(workDir, ".npmrc"), `//127.0.0.1:${registry.port}/:_authToken=e2e\n`);
  writeManifest("0.0.1");
  const install = Bun.spawnSync(["bun", "install"], { cwd: workDir, stdout: "inherit", stderr: "inherit" });
  if (install.exitCode !== 0) throw new Error("bun install failed in the fixture copy");
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  registry.stop(true);
  try {
    const found = await management<{ id: number }>("GET", `/teams/${team}/projects/${project}`);
    await management("POST", `/projects/${found.id}/delete`);
  } catch (error) {
    if (!String(error).includes("404")) throw error;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}, HOOK_TIMEOUT_MS);

test("get-config prints the validated jive block and nothing else on stdout", async () => {
  const { exitCode, stdout } = await hook("get-config");
  expect(exitCode).toBe(0);
  expect(JSON.parse(stdout)["backend-convex"].project).toBe(project);
}, HOOK_TIMEOUT_MS);

test("build checks static codegen and typechecks the functions", async () => {
  expect((await hook("build")).exitCode).toBe(0);
}, HOOK_TIMEOUT_MS);

test("deploy-plan creates the project and Staging deployment and plans a deploy to its HTTP actions URL", async () => {
  const { exitCode, stdout } = await hook("deploy-plan", { JIVE_DEPLOY_ENVIRONMENT: "Staging", JIVE_PIPELINE_CONTEXT: context({ type: "COMMIT" }) });
  expect(exitCode).toBe(0);
  const staging = (await deployments()).find((d) => d.reference === "staging")!;
  expect(JSON.parse(stdout)).toEqual({ deploy: true, url: staging.deploymentUrl.replace(".convex.cloud", ".convex.site") });
}, HOOK_TIMEOUT_MS);

let firstKeys: Record<string, string | undefined> = {};

test("deploy sets variables, pushes, runs afterDeploy, adds the domain and publishes the client", async () => {
  const { exitCode, stderr } = await hook("deploy", { JIVE_DEPLOY_ENVIRONMENT: "Staging", JIVE_PIPELINE_CONTEXT: context({ type: "COMMIT" }) });
  expect(exitCode).toBe(0);
  // The canonical domain is not verified (nobody can create example.com's records), so it must not become canonical.
  expect(stderr).toContain("is not verified yet");

  const staging = (await deployments()).find((d) => d.reference === "staging")!;
  const variables = await environmentVariables(staging);
  expect(variables["GREETING"]).toBe("hello from Staging");
  expect(variables["CONNECTION_KEY"]).toMatch(/^1:[A-Za-z0-9+/]{43}=$/);
  expect(variables["JWT_JWKS"]).toStartWith("data:text/plain;charset=utf-8;base64,");
  firstKeys = { CONNECTION_KEY: variables["CONNECTION_KEY"], JWT_PRIVATE_KEY: variables["JWT_PRIVATE_KEY"] };

  expect(await latestDeploy(staging.deploymentUrl)).toEqual({ sourceCommitSha: sha, environment: "Staging", greeting: "hello from Staging" });

  const domains = await management<{ domains: Array<{ domain: string }> }>("GET", `/deployments/${staging.name}/custom_domains`);
  expect(domains.domains.map((d) => d.domain)).toEqual(["jive-abstract-backend-convex-e2e.example.com"]);
  const keys = await management<Array<{ name: string }>>("GET", `/deployments/${staging.name}/list_deploy_keys`);
  expect(keys.filter((key) => key.name.startsWith("jive "))).toEqual([]);

  const client = published.get(fixtureClientName)!;
  expect(client.distTags["Staging"]).toBe("0.0.1-Staging");
  const index = fileInTarball(client.tarballs.get("0.0.1-Staging")!, "index.js");
  expect(index).toContain(`export const convexUrl = ${JSON.stringify(staging.deploymentUrl)};`);
  expect(fileInTarball(client.tarballs.get("0.0.1-Staging")!, "_generated/api.d.ts")).toContain("latest: FunctionReference<");
}, HOOK_TIMEOUT_MS);

test("a later commit with no version bump deploys its functions and leaves the published client alone", async () => {
  const laterSha = randomBytes(20).toString("hex");
  const client = published.get(fixtureClientName)!;
  const clientBefore = client.tarballs.get("0.0.1-Staging")!;
  const { exitCode, stderr } = await hook("deploy", { JIVE_DEPLOY_ENVIRONMENT: "Staging", JIVE_PIPELINE_CONTEXT: context({ type: "COMMIT" }, laterSha) });
  expect(exitCode).toBe(0);
  expect(stderr).toContain(`${fixtureClientName}@0.0.1-Staging is already on ${registryUrl}`);
  expect(stderr).toContain("Not publishing the client");

  const staging = (await deployments()).find((d) => d.reference === "staging")!;
  expect((await latestDeploy(staging.deploymentUrl)).sourceCommitSha).toBe(laterSha);
  expect([...client.tarballs.keys()]).toEqual(["0.0.1-Staging"]);
  expect(client.tarballs.get("0.0.1-Staging")).toBe(clientBefore);
}, HOOK_TIMEOUT_MS);

test("a later deploy keeps generate-once keys and updates the rest", async () => {
  writeManifest("0.0.2");
  expect((await hook("deploy", { JIVE_DEPLOY_ENVIRONMENT: "Staging", JIVE_PIPELINE_CONTEXT: context({ type: "COMMIT" }) })).exitCode).toBe(0);
  const staging = (await deployments()).find((d) => d.reference === "staging")!;
  const variables = await environmentVariables(staging);
  const kept: Record<string, string | undefined> = { CONNECTION_KEY: variables["CONNECTION_KEY"], JWT_PRIVATE_KEY: variables["JWT_PRIVATE_KEY"] };
  expect(kept).toEqual(firstKeys);
}, HOOK_TIMEOUT_MS);

test("Preview deploys a pull request to its own preview deployment and client tag", async () => {
  const event = { type: "PULL_REQUEST", id: "7", destinationBranch: "main" };
  expect((await hook("deploy-plan", { JIVE_DEPLOY_ENVIRONMENT: "Preview", JIVE_PIPELINE_CONTEXT: context(event) })).exitCode).toBe(0);
  expect((await hook("deploy", { JIVE_DEPLOY_ENVIRONMENT: "Preview", JIVE_PIPELINE_CONTEXT: context(event) })).exitCode).toBe(0);

  const preview = (await deployments()).find((d) => d.previewIdentifier === "pr-7")!;
  expect(preview.deploymentType).toBe("preview");
  expect((await latestDeploy(preview.deploymentUrl)).greeting).toBe("hello from Preview");
  const tag = `preview-${sha.slice(0, 8)}`;
  expect(published.get(fixtureClientName)!.distTags[tag]).toBe(`0.0.2-${tag}`);
}, HOOK_TIMEOUT_MS);

test("upload-artifacts and audit succeed without doing anything", async () => {
  expect((await hook("upload-artifacts", { JIVE_PIPELINE_CONTEXT: context({ type: "COMMIT" }) })).exitCode).toBe(0);
  expect((await hook("audit")).exitCode).toBe(0);
}, HOOK_TIMEOUT_MS);

test("with only a production deploy key, the hooks deploy to the key's deployment and the client publish is provisioned first", async () => {
  const found = await management<{ id: number }>("GET", `/teams/${team}/projects/${project}`);
  const latest = await management<Deployment>("POST", `/projects/${found.id}/create_deployment`, {
    type: "prod",
    reference: "latest",
    region: fixtureManifest.jive["backend-convex"].region,
  });
  const deployKey = await mintProductionDeployKey(latest, "e2e production deploy key");
  expect(deployKey.startsWith(`prod:${latest.name}|`)).toBe(true);

  writeDeployKeyManifest("0.0.3");
  const env = {
    CONVEX_TEAM_ACCESS_TOKEN: "",
    CONVEX_DEPLOY_KEY: deployKey,
    JIVE_DEPLOY_ENVIRONMENT: "latest",
    JIVE_PIPELINE_CONTEXT: context({ type: "COMMIT" }),
    ACTIONS_ID_TOKEN_REQUEST_URL: `${registryUrl}/-/github-id-token?api-version=2.0`,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "e2e",
  };
  const plan = await hook("deploy-plan", env);
  expect(plan.exitCode).toBe(0);
  expect(JSON.parse(plan.stdout)).toEqual({ deploy: true, url: latest.deploymentUrl.replace(".convex.cloud", ".convex.site") });

  events.length = 0;
  const { exitCode, stderr } = await hook("deploy", env);
  expect(exitCode).toBe(0);
  expect(stderr).toContain(`the deployment CONVEX_DEPLOY_KEY names`);
  expect(await latestDeploy(latest.deploymentUrl)).toEqual({ sourceCommitSha: sha, environment: "latest", greeting: "hello from latest" });
  const variables = await environmentVariables(latest);
  expect(variables["CONNECTION_KEY"]).toMatch(/^1:[A-Za-z0-9+/]{43}=$/);
  const keys = await management<Array<{ name: string }>>("GET", `/deployments/${latest.name}/list_deploy_keys`);
  expect(keys.map((key) => key.name).filter((name) => name.startsWith("jive "))).toEqual([]);
  expect(events).toEqual([`packages:provision ${fixtureClientName}`, `publish ${fixtureClientName}@0.0.3`]);
  expect(published.get(fixtureClientName)!.distTags["latest"]).toBe("0.0.3");
}, HOOK_TIMEOUT_MS);

test("a production deploy key for another environment's deployment is refused before anything changes", async () => {
  const staging = (await deployments()).find((d) => d.reference === "staging")!;
  const stagingKey = await mintProductionDeployKey(staging, "e2e staging deploy key");
  const before = await latestDeploy(staging.deploymentUrl);
  const { exitCode, stderr } = await hook("deploy", {
    CONVEX_TEAM_ACCESS_TOKEN: "",
    CONVEX_DEPLOY_KEY: stagingKey,
    JIVE_DEPLOY_ENVIRONMENT: "latest",
    JIVE_PIPELINE_CONTEXT: context({ type: "COMMIT" }, randomBytes(20).toString("hex")),
  });
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain(`reference "staging", not "latest"`);
  expect(await latestDeploy(staging.deploymentUrl)).toEqual(before);
}, HOOK_TIMEOUT_MS);
