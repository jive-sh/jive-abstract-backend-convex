import { Effect, Option, Redacted, Schema, SchemaIssue, pipe } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { implementing, type EffectGen } from "effective-modules";
import { CONVEX_CLI_API_URL } from "../../common/constants";
import { DEPLOY_KEY_SECRET, TEAM_ACCESS_TOKEN_SECRET, listedCredentialSecrets, type ConvexCredentialSecret } from "../../public/manifest";
import { backendModules } from "../index";
import { ConvexCredential, type DeployKeyDeployment, type IConvexCredential } from "./interface";

const formatSchemaError = SchemaIssue.makeFormatterDefault();

const KeyUrl = Schema.String;
const KeyOwner = Schema.Struct({
  teamId: Schema.Number,
  project: Schema.String,
  reference: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

/**
 * A production deploy key is `prod:<deployment-name>|<secret>`; dev keys start `dev:` and preview keys
 * `preview:<team>:<project>|` (https://docs.convex.dev/cli/deploy-key-types). Never echoes the key.
 */
export function productionDeployKeyName(key: string): Option.Option<string> {
  const match = key.match(/^prod:([a-z0-9-]+)\|.+$/);
  return match === null ? Option.none() : Option.some(match[1]!);
}

/**
 * The credential `secret` names, from `environment`. The other credential's variable being set too is refused,
 * not ignored: a shell holding both would otherwise act with whichever the manifest happens to list.
 */
export function credentialFrom(
  secret: ConvexCredentialSecret,
  environment: Readonly<Record<string, string | undefined>>,
): Effect.Effect<ConvexCredential, string> {
  return Effect.suspend((): Effect.Effect<ConvexCredential, string> => {
    const other = secret === TEAM_ACCESS_TOKEN_SECRET ? DEPLOY_KEY_SECRET : TEAM_ACCESS_TOKEN_SECRET;
    const value = environment[secret];
    if (value === undefined || value === "") {
      return Effect.fail(secret === TEAM_ACCESS_TOKEN_SECRET
        ? `${TEAM_ACCESS_TOKEN_SECRET} is not set. It is a Convex team access token (Convex dashboard, team settings), stored as a repository secret and listed in jive.cicd.requiredSecrets.`
        : `${DEPLOY_KEY_SECRET} is not set. It is a production deploy key (Convex dashboard, the deployment's settings), stored as a repository secret and listed in jive.cicd.requiredSecrets.`);
    }
    const otherValue = environment[other];
    if (otherValue !== undefined && otherValue !== "") {
      return Effect.fail(`Both ${TEAM_ACCESS_TOKEN_SECRET} and ${DEPLOY_KEY_SECRET} are set. This package deploys with ${secret}, its jive.cicd.requiredSecrets says; unset ${other} so which credential acts is not a guess.`);
    }
    if (secret === TEAM_ACCESS_TOKEN_SECRET) return Effect.succeed(ConvexCredential.TeamAccessToken({ token: Redacted.make(value) }));
    return Option.match(productionDeployKeyName(value), {
      onNone: () => Effect.fail(`${DEPLOY_KEY_SECRET} is not a production deploy key (one starts "prod:<deployment-name>|"); dev and preview keys cannot deploy an environment.`),
      onSome: (deploymentName) => Effect.succeed(ConvexCredential.DeployKey({ key: Redacted.make(value), deploymentName })),
    });
  });
}

export class ConvexCredentialImpl extends implementing(backendModules.ConvexCredential)
  .uses(backendModules.Package, HttpClient.HttpClient)
  implements IConvexCredential {
  *current(): EffectGen<ConvexCredential, string> {
    const packageJson = yield* this.dependencies.Package.load();
    const listed = listedCredentialSecrets(packageJson.jive.cicd.requiredSecrets);
    const [secret] = listed;
    if (secret === undefined || listed.length !== 1) {
      return yield* Effect.fail(`jive.cicd.requiredSecrets must list exactly one of ${TEAM_ACCESS_TOKEN_SECRET} and ${DEPLOY_KEY_SECRET}`);
    }
    return yield* credentialFrom(secret, process.env);
  }

  *deployKeyDeployment(credential: {
    readonly key: Redacted.Redacted<string>;
    readonly deploymentName: string;
  }): EffectGen<DeployKeyDeployment, string> {
    const url = yield* this.askAboutKey("deployment/url_for_key", credential.key, KeyUrl);
    const owner = yield* this.askAboutKey("deployment/team_and_project_for_key", credential.key, KeyOwner);
    return {
      deployment: { name: credential.deploymentName, cloudUrl: url },
      teamId: owner.teamId,
      projectSlug: owner.project,
      reference: Option.fromNullishOr(owner.reference),
    };
  }

  /** One question about the key, as the `convex` CLI asks it: the key in the body, no other credential. */
  private *askAboutKey<A>(path: string, key: Redacted.Redacted<string>, schema: Schema.Codec<A, unknown, never, never>): EffectGen<A, string> {
    const purpose = `ask Convex which deployment ${DEPLOY_KEY_SECRET} names (${path})`;
    const response = yield* pipe(
      this.getDependency(HttpClient.HttpClient).execute(
        HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.post(`${CONVEX_CLI_API_URL}/${path}`), { deployKey: Redacted.value(key) }),
      ),
      Effect.mapError((e) => `Could not ${purpose}: ${e.message}`),
    );
    const text = yield* pipe(response.text, Effect.mapError((e) => `Could not ${purpose}: reading the reply failed: ${e.message}`));
    if (response.status !== 200) return yield* Effect.fail(`Could not ${purpose}: Convex answered ${response.status}: ${text.trim().slice(0, 300)}`);
    return yield* pipe(
      Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text),
      Effect.mapError((e) => `Could not ${purpose}: Convex's reply has an unexpected shape:\n${formatSchemaError(e.issue)}`),
    );
  }
}
