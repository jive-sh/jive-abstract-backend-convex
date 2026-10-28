# jive-abstract-backend-convex

A Jive abstract for [Convex](https://www.convex.dev) backends. A package that extends it gets its CI/CD from
Jive's reusable pipeline with no workflow code of its own. Each deploy produces two outputs from the same
commit:

- **The functions**, pushed to one Convex deployment per environment.
- **The client**, published to npm under the name set in `clientPackageName`, carrying the generated `api` and the URL of
  that environment's deployment. Callers install the client and connect without configuring a URL, and its
  version names the deploy it matches.

The abstract itself is an ordinary library: it builds and publishes through
[`jive-abstract-library`](https://github.com/jive-sh/jive-abstract-library).

## Vocabulary

- **Environment**: a deploy target named in `jive.cicd.deploy.branches` (for example `latest` or `Staging`),
  plus `Preview` when previews are on. See Jive's [CI/CD contract](https://github.com/jive-sh/jive/blob/main/CICD_API.md).
- **Deployment**: a Convex backend instance in a project. Every named environment gets its own production-type
  deployment whose [reference](https://docs.convex.dev/production/multiple-deployments) is the environment name
  in lowercase. `Preview` gets a [preview deployment](https://docs.convex.dev/production/multiple-deployments#preview)
  per pull request (`pr-<number>`), which Convex deletes after its retention period.
- **Credential**: what every hook authenticates to Convex with. A package lists exactly one of two in
  `jive.cicd.requiredSecrets`, and that one is used:
  - **Team access token** (`CONVEX_TEAM_ACCESS_TOKEN`): a Convex [team token](https://docs.convex.dev/management-api#authorization),
    the only credential the Management API takes. The hooks create the project and deployments, add custom domains,
    and for each push mint a [deploy key](https://docs.convex.dev/cli/deploy-key-types) for that one deployment,
    deleted when the push finishes and expiring on its own after 35 minutes regardless.
  - **Production deploy key** (`CONVEX_DEPLOY_KEY`): a key of the form `prod:<deployment-name>|…` that "grants
    permissions to deploy code to" one deployment ([production deploy keys](https://docs.convex.dev/cli/deploy-key-types#production-deploy-keys)),
    made in the Convex dashboard under that deployment's settings, where you "choose which actions it's allowed to
    perform" ([from the dashboard](https://docs.convex.dev/cli/deploy-key-types#from-the-dashboard)). It reaches that
    deployment's own API too ([authorization](https://docs.convex.dev/deployment-platform-api#authorization)), but
    not the Management API, so the deployment must already exist and the package can have neither previews nor
    custom domains (see below).

## Extending it

```jsonc
{
  "$schema": "./package.schema.json",
  "name": "@example/server",
  "version": "0.1.0",
  "license": "MIT",
  "type": "module",
  "scripts": {
    "jive:cicd:get-config": "jive-backend-convex cicd get-config",
    "jive:cicd:build": "jive-backend-convex cicd build",
    "jive:cicd:audit": "bun test",
    "jive:cicd:deploy:plan": "jive-backend-convex cicd deploy-plan",
    "jive:cicd:upload-artifacts": "jive-backend-convex cicd upload-artifacts",
    "jive:cicd:deploy": "jive-backend-convex cicd deploy",
    "dev": "jive-backend-convex dev"
  },
  "dependencies": { "convex": "^1.48.0" },
  "devDependencies": { "jive-abstract-backend-convex": "^0.1.0", "@types/node": "^22", "typescript": "^5.9.3" },
  "jive": {
    "cicd": {
      "deploy": { "verb": "Deploy to", "branches": { "main": ["latest"] }, "previews": false, "sequentially": true },
      "runsOnPullRequests": true,
      "runsOn": "ubuntu-latest",
      "requiredSecrets": ["CONVEX_TEAM_ACCESS_TOKEN"]  // or ["CONVEX_DEPLOY_KEY"], never both
    },
    "backend-convex": {
      "team": 551884,
      "project": "example-server",
      "clientPackageName": "@example/server-client",
      "region": "aws-us-east-1",
      "environments": {
        "latest": {
          "environmentVariables": {
            "WEBSITE_DOMAIN": { "value": "example.com" },
            "CONNECTION_KEY": { "generateOnce": { "type": "randomBytes", "bytes": 32, "prefix": "1:" } },
            "JWT_PRIVATE_KEY": { "generateOnce": { "type": "es256KeyPair", "publicJwksVariable": "JWT_JWKS" } }
          },
          "customDomains": [
            { "domain": "api.example.com", "destination": "convexCloud", "canonical": true }
          ]
        }
      },
      "afterDeploy": { "function": "deploys:record" },
      "provisionWithJive": null
    }
  }
}
```

and a `convex.json` asking for static code generation, so the client's types stand alone without the
backend's source ([convex.json](https://docs.convex.dev/config/convex.json)):

```json
{ "codegen": { "staticApi": true, "staticDataModel": true } }
```

Commit `convex/_generated`, as Convex recommends: `build` typechecks against it, and code generation needs a
deployment, which `build` does not have.

`package.schema.json` is generated by `jive-backend-convex dev` and should be gitignored; the editor uses it to
validate the manifest as you type. Every field is required, so the schema lists everything configurable.

### The `backend-convex` block

| Field | Meaning |
| --- | --- |
| `team` | Numeric id of the Convex team. The Management API takes ids, not slugs. |
| `project` | Slug of the project; created with that name on the first deploy (with a team access token; with a deploy key it must exist). |
| `clientPackageName` | The npm name the client is published under, such as `@example/server-client`. Its version check, its `provisionWithJive` call and its publish all use this name. |
| `region` | Region for deployments the abstract creates. An existing deployment never moves. |
| `environments` | One entry per environment, no more and no fewer; checked when the manifest is read. |
| `environments.*.environmentVariables` | `{ "value": "…" }` is written on every deploy. `{ "generateOnce": … }` is generated only when the deployment provably lacks it (below). Variables not declared here are left alone and listed by name in the log. |
| `environments.*.customDomains` | `domain`, `destination` (`convexCloud` for the client API, `convexSite` for HTTP actions, see [custom domains](https://docs.convex.dev/production/custom-domains)) and `canonical`. Must be empty for `Preview`. |
| `afterDeploy` | A function run after every push with `{ "sourceCommitSha", "environment" }`, or `null`. It may be internal. |
| `provisionWithJive` | `null` to publish the client as before, or `{ "serverUrl": … }` to have the deploy call that Jive server's `packages:provision` with the job's GitHub OIDC token right before publishing the client; a refusal fails the deploy with the client unpublished (the functions are already pushed). The same setting, and schema, as `jive-abstract-library`'s `jive.library.provisionWithJive`, passed to its `publishPackage`. Needs `id-token: write`, which the deploy job of Jive's reusable pipeline has. |

`generateOnce` types:

- `randomBytes`: `bytes` random bytes, standard base64, after `prefix`.
- `es256KeyPair`: a P-256 private key as JWK JSON in the declared variable, and its public half in
  `publicJwksVariable` as the JWKS data URI that Convex's
  [custom JWT provider](https://docs.convex.dev/auth/advanced/custom-jwt#server-side-integration) accepts in
  `auth.config.ts` (`jwks: process.env.JWT_JWKS`). Both share one `kid`, the key's RFC 7638 thumbprint.

## What each hook does

| Hook | Behavior |
| --- | --- |
| `get-config` | Prints the validated `jive` block. |
| `build` | Checks `convex.json` asks for static codegen and `convex` is a dependency, then typechecks `convex/` with `tsc`. No push. |
| `audit` | Nothing; replace it with the package's own tests. |
| `deploy-plan` | Ensures the project and the environment's deployment exist, then plans a deploy (`{"deploy":true,"url":…}`) to the first `convexSite` custom domain, else the deployment's `.convex.site` URL. |
| `upload-artifacts` | Nothing. |
| `deploy` | In order: checks whether this environment's client version is already on the registry; ensures the project and deployment; applies environment variables; mints a deploy key and runs `convex deploy`, then `afterDeploy`; deletes the key; adds missing custom domains and sets canonical URLs; publishes the client, unless its version was already on the registry. |

### Deploying with a production deploy key

With `CONVEX_DEPLOY_KEY` in `requiredSecrets`, each step uses the key, or cannot run:

| Step | With a deploy key | Source |
| --- | --- | --- |
| Find the deployment | Asked of Convex with the key alone, as the `convex` CLI does (`deployment/url_for_key`, `deployment/team_and_project_for_key`; undocumented, read from convex 1.48.0's `deploymentSelection.ts`). The deploy stops unless its team id, project slug and reference are the manifest's team, project and the environment's name in lowercase. | CLI source |
| Create the project or a deployment | Cannot: Management API. The deployment must exist, with that reference. | [Management API authorization](https://docs.convex.dev/management-api#authorization) |
| Preview deployments | Cannot: one is created per pull request. `previews` must be false. | same |
| Environment variables, canonical URLs | Through the deployment's own API with `Convex <key>`. | [Deployment API authorization](https://docs.convex.dev/deployment-platform-api#authorization) |
| Push and `afterDeploy` | `convex deploy` and `convex run` with the key itself; no key is minted or deleted. | [Production deploy keys](https://docs.convex.dev/cli/deploy-key-types#production-deploy-keys) |
| Custom domains | Cannot list or add them: Management API. `customDomains` must be empty; canonical URLs are left as they are. | [Management API authorization](https://docs.convex.dev/management-api#authorization) |

**The deployment and the key, set up once.** The deployment's reference must be the environment's name in
lowercase (`latest` for `latest`). A project's default production deployment has reference `production`
([deployment types](https://docs.convex.dev/production/multiple-deployments#deployment-types)), so either create
the deployment with that reference, `npx convex deployment create latest --type=prod`
([from a script](https://docs.convex.dev/production/multiple-deployments#from-a-script)), or change an existing
one's reference with the Management API's update-deployment call (`PATCH /v1/deployments/<name>` with
`{ "reference": "latest" }`; spec at https://api.convex.dev/v1/openapi.json, gated by `deployment:updateReference`,
[role actions](https://docs.convex.dev/team-management/role-actions#lifecycle-and-configuration)). The key must be
allowed every action the hooks take ([role actions](https://docs.convex.dev/team-management/role-actions#data-plane-and-runtime)):

| Action | Needed for |
| --- | --- |
| `deployment:deploy` | `convex deploy` |
| `deployment:env:view` | Reading the variables first; without it no `generateOnce` key can be proven absent, so the deploy stops |
| `deployment:env:write` | Setting the declared variables |
| `deployment:functions:runInternalQueries`, `runInternalMutations`, `runInternalActions` | `afterDeploy`, when it names an internal function |

Convex's docs name no action for reading the canonical URLs, which `deploy-plan` and the client publish need;
this repo's end-to-end test mints a key with exactly the actions above and runs every hook with it, so a key with
them is known to be enough.

A key that is not a production key (`dev:`, `preview:`) is refused. If the variable the manifest does not list is
set as well, every hook refuses rather than guess which credential acts; Jive's pipeline only exports the secrets
`requiredSecrets` lists, so this guards local runs and misconfigured environments. A Management API call made under
a deploy key fails naming its step, never silently.

Environment variables are applied before the push, so the pushed code, including an `auth.config.ts` that
reads deployment variables (as in Convex's [Clerk guide](https://docs.convex.dev/auth/clerk#configuring-the-backend)),
sees them from its first request.

### Generate-once keys

A key like `CONNECTION_KEY` seals data; replacing it makes that data unreadable. So the deploy generates one
only after reading the deployment's variables successfully and finding it absent. If the list cannot be read,
the deploy stops. A key pair whose two variables are half present stops the deploy rather than generating the
other half. The deployment holds the only copy of a generated key.

### Custom domains

The deploy adds each declared domain the deployment lacks and reports whether Convex has verified it. Creating
the DNS records (a `CNAME` to `convex.domains` and the `TXT` record at `_convex_domains.<domain>` shown in the
Convex dashboard, per [abuse protection](https://docs.convex.dev/production/abuse-protection#setup)) is not done
here. A domain marked `canonical` becomes the deployment's canonical URL only once Convex reports it verified:
Convex accepts an unverified domain as canonical, and the published client would then point at a host that does
not answer. A domain removed from the manifest is reported, not deleted.

### The published client

Published under `clientPackageName`, with the version and dist-tag `jive-abstract-library` uses: environment
`latest` publishes the bare version under `latest`; any other environment `<version>-<environment>` under
`<environment>`; Preview `<version>-preview-<sha>` under `preview-<sha>`. Name the production environment
`latest` so `npm install @example/server-client` resolves to it. A deploy whose version is already on the registry, such as
a push without a version bump, still deploys the functions but leaves the published client alone, so bump `version`
whenever callers need a new client (a changed `api`, or new URLs).

```ts
import { ConvexClient } from "convex/browser";
import { api, convexUrl } from "@example/server-client";

const client = new ConvexClient(convexUrl);
const latest = await client.query(api.deploys.latest, {});
```

Publishing goes through `jive-abstract-library`'s `publishPackage`, the same npm path a library's release
takes: it authenticates with `NPM_TOKEN` when that secret is set, and otherwise relies on npm
[trusted publishing](https://docs.npmjs.com/trusted-publishers), which needs a trusted publisher on the package
naming the caller workflow `pipeline.yml` and the environment being deployed, with publishing allowed. npm
configures trusted publishers in a package's own settings page, so the first publish of a new client uses
`NPM_TOKEN` (listed in `requiredSecrets`); remove it once the trusted publisher is in place.

The package exports `api`, the types `DataModel`, `Doc`, `Id` and `TableNames`, `convexUrl` (the canonical
client API URL), `convexSiteUrl`, and `deployment` (`environment`, `sourceCommitSha`, `version`). It declares
`convex` as a peer dependency with the backend's own range.

## Limitations and open questions

- **Old clients against new functions.** A deploy replaces the functions an already-installed client calls.
  Nothing yet stops a change that breaks those callers.
- **Self-hosted Convex** (`CONVEX_SELF_HOSTED_URL`) is not an environment kind yet. The deployment and
  credential handling are behind one module each, so a self-hosted target can be added as another kind.
- **Either credential is long-lived** and is exposed to every pull-request build, because Jive's
  `requiredSecrets` is enforced in the build job. A deploy key's reach is one deployment; a team token's, the team.
- **A deploy key's deployment is found through Convex's CLI endpoints**, which Convex does not document; a change
  there breaks deploy-key runs, with the reply quoted in the error.
- With a deploy key, canonical URLs are only read, never set: the manifest allows no custom domains, and listing
  the deployment's is a Management API call.
- The generated `api.d.ts` also declares internal function names (types only; clients cannot call them).

## Developing this abstract

`bun run jive:cicd:build` builds and installs the CLI locally; `bun run jive:cicd:audit` typechecks and runs
the unit tests in `src`, which reach Convex and npm only through fakes. CI runs nothing else, because this repo is
a library and its pipeline holds no Convex credential. `bun run test:e2e`, run by hand only, runs every hook of the
built CLI against `test/fixture` on a throwaway Convex project in the fixture's real team (deleted afterwards) and publishes the fixture's client to a registry the test serves
itself. It needs `CONVEX_TEAM_ACCESS_TOKEN` for the fixture's team. After the team-token hooks it covers the deploy-key
path live: it creates a production deployment with reference `latest` in the throwaway project, mints a production
deploy key for it with only the actions listed above, and runs `deploy-plan` and `deploy` with only
`CONVEX_DEPLOY_KEY` set, the client publish going through a fake Jive server's `packages:provision`.
