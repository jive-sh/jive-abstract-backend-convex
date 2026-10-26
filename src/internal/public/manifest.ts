import { Schema } from "effect";
import { PREVIEW_ENVIRONMENT, isEnvironment, makeJivePackageJsonSchema } from "jive-abstract-library";

/**
 * The shape a Convex backend package's package.json must have: the fields every Jive package has, plus the
 * `jive["backend-convex"]` block this abstract owns. Every field is required, as with `jive.cicd`: the
 * schema is how an author learns what is configurable, so nothing is defaulted at deploy time.
 */

/** The block's key under `jive`, which is also this abstract's kind. */
export const BACKEND_CONVEX_KEY = "backend-convex";

/** Repository secret holding a Convex team access token; it must be listed in `jive.cicd.requiredSecrets`. */
export const TEAM_ACCESS_TOKEN_SECRET = "CONVEX_TEAM_ACCESS_TOKEN";

/**
 * Words Convex refuses as a deployment reference (Management API, `PlatformUpdateDeploymentArgs.reference`).
 * An environment's deployment reference is its name in lowercase, so these cannot be environment names.
 */
const CONVEX_RESERVED_REFERENCES = [
  "prod", "dev", "cloud", "local", "default", "name", "new", "existing", "deployment", "preview",
] as const;

/**
 * Convex's rule for a deployment reference, applied to the lowercased environment name. `/` is allowed by
 * Convex but not here, since it would let `a/b` and a branch-like name collide with preview references.
 */
export function deploymentReferenceProblem(environment: string): string | undefined {
  const reference = environment.toLowerCase();
  if (!/^[a-z0-9-]{3,100}$/.test(reference)) {
    return `"${environment}" cannot name a Convex deployment: lowercased, it must be 3 to 100 letters, digits or "-"`;
  }
  if ((CONVEX_RESERVED_REFERENCES as ReadonlyArray<string>).includes(reference)) {
    return `"${environment}" is a word Convex reserves for deployment references`;
  }
  if (/^[a-z]+-[a-z]+-[0-9]+$/.test(reference)) {
    return `"${environment}" looks like a Convex deployment name (like happy-otter-123), which Convex refuses as a reference`;
  }
  if (reference.startsWith("local-")) {
    return `"${environment}" starts with "local-", which Convex refuses as a reference`;
  }
  return undefined;
}

const EnvironmentVariableName = Schema.NonEmptyString.check(
  Schema.isPattern(/^[A-Za-z][A-Za-z0-9_]{0,255}$/),
).annotate({
  description: "A Convex environment variable name: starts with a letter, then letters, digits or underscores, at most 256 characters.",
});

const GeneratedValue = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("randomBytes"),
    bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(16)).annotate({
      description: "How many cryptographically random bytes to generate.",
    }),
    prefix: Schema.String.annotate({
      description: 'Text written before the base64 of the bytes, e.g. "1:" for a key version. "" for none.',
    }),
  }).annotate({ description: "Random bytes, standard base64, after `prefix`." }),
  Schema.Struct({
    type: Schema.Literal("es256KeyPair"),
    publicJwksVariable: EnvironmentVariableName.annotate({
      description: "Variable that receives the matching public key as a JWKS data URI, the form Convex's customJwt `jwks` accepts. Generated together with the private key.",
    }),
  }).annotate({ description: "An ES256 (P-256) private key as a JWK JSON string, for signing JWTs Convex's customJwt auth verifies." }),
]);
export type GeneratedValue = typeof GeneratedValue.Type;

const EnvironmentVariable = Schema.Union([
  Schema.Struct({
    value: Schema.String.annotate({ description: "Set on every deploy; a value changed on the deployment by hand is overwritten." }),
  }),
  Schema.Struct({
    generateOnce: GeneratedValue.annotate({
      description: "Generated on the first deploy that finds the variable absent, then never touched again. If the deployment's variables cannot be read, the deploy stops rather than risk replacing a key in use.",
    }),
  }),
]);
export type EnvironmentVariable = typeof EnvironmentVariable.Type;

const RequestDestination = Schema.Literals(["convexCloud", "convexSite"]).annotate({
  description: '"convexCloud" serves the Convex client API (queries, mutations, subscriptions); "convexSite" serves HTTP actions.',
});
export type RequestDestination = typeof RequestDestination.Type;

const CustomDomain = Schema.Struct({
  domain: Schema.NonEmptyString.check(Schema.isPattern(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/)).annotate({
    description: 'A hostname you control, e.g. "api.example.com". Its DNS records (a CNAME to convex.domains and a TXT at _convex_domains.<domain>) are yours to create; the deploy reports whether Convex has verified them.',
  }),
  destination: RequestDestination,
  canonical: Schema.Boolean.annotate({
    description: "If true, once Convex has verified the domain it becomes the deployment's canonical URL for its destination (CONVEX_CLOUD_URL or CONVEX_SITE_URL), and the published client connects through it. At most one per destination.",
  }),
});
export type CustomDomain = typeof CustomDomain.Type;

const EnvironmentConfig = Schema.Struct({
  environmentVariables: Schema.Record(EnvironmentVariableName, EnvironmentVariable).annotate({
    description: "Variables this package owns on the environment's deployment. Variables set elsewhere are left alone and listed by name in the deploy log.",
  }),
  customDomains: Schema.Array(CustomDomain).annotate({
    description: "Domains served by this environment's deployment. A domain absent from this list is never deleted, only reported. Must be empty for Preview, since a domain points at one deployment.",
  }),
});
export type EnvironmentConfig = typeof EnvironmentConfig.Type;

/** The `jive["backend-convex"]` block. */
export const BackendConvexSchema = Schema.Struct({
  team: Schema.Int.check(Schema.isGreaterThan(0)).annotate({
    description: "Numeric id of the Convex team that owns the project; the Management API takes ids, not slugs. CONVEX_TEAM_ACCESS_TOKEN must be a token for this team.",
  }),
  project: Schema.NonEmptyString.check(Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)).annotate({
    description: "Slug of the Convex project this package deploys to. Created with this name on the first deploy if absent.",
  }),
  region: Schema.NonEmptyString.annotate({
    description: 'Region new deployments are created in, e.g. "aws-us-east-1". Applies only when a deployment is created; an existing deployment stays where it is.',
  }),
  environments: Schema.Record(Schema.String, EnvironmentConfig).annotate({
    description: 'One entry per deploy target: every environment named in jive.cicd.deploy.branches, plus "Preview" when jive.cicd.deploy.previews is true, and nothing else. Each environment is its own Convex deployment, referenced by the environment name in lowercase.',
  }),
  afterDeploy: Schema.NullOr(Schema.Struct({
    function: Schema.NonEmptyString.annotate({
      description: 'A Convex function, e.g. "deploys:record", run after every push with {"sourceCommitSha": string, "environment": string}. May be internal.',
    }),
  })).annotate({ description: "A function to run once the push succeeds, or null for none." }),
});
export type BackendConvexConfig = typeof BackendConvexSchema.Type;

function environmentsProblems(
  backend: BackendConvexConfig,
  deployTargets: ReadonlyArray<string>,
  previews: boolean,
): ReadonlyArray<string> {
  const problems: Array<string> = [];
  const names = Object.keys(backend.environments);
  const expected = [...deployTargets, ...(previews ? ["Preview"] : [])];

  for (const target of expected) {
    if (!names.includes(target)) problems.push(`jive.${BACKEND_CONVEX_KEY}.environments has no entry for "${target}", a deploy target`);
  }
  for (const name of names) {
    if (!expected.includes(name)) problems.push(`jive.${BACKEND_CONVEX_KEY}.environments."${name}" is not a deploy target in jive.cicd.deploy`);
  }

  const seen = new Map<string, string>();
  for (const name of names) {
    const lower = name.toLowerCase();
    const clash = seen.get(lower);
    if (clash !== undefined) problems.push(`environments "${clash}" and "${name}" would share one Convex deployment`);
    seen.set(lower, name);

    const config = backend.environments[name]!;
    if (isEnvironment(name, PREVIEW_ENVIRONMENT)) {
      if (config.customDomains.length > 0) problems.push(`"${name}" cannot have custom domains: there is one preview deployment per pull request`);
    } else {
      const referenceProblem = deploymentReferenceProblem(name);
      if (referenceProblem !== undefined) problems.push(referenceProblem);
    }

    for (const destination of ["convexCloud", "convexSite"] as const) {
      const canonical = config.customDomains.filter((d) => d.canonical && d.destination === destination);
      if (canonical.length > 1) problems.push(`"${name}" marks ${canonical.length} ${destination} domains canonical; at most one can be`);
    }

    const declared = Object.keys(config.environmentVariables);
    for (const [variable, spec] of Object.entries(config.environmentVariables)) {
      if ("generateOnce" in spec && spec.generateOnce.type === "es256KeyPair") {
        const publicVariable = spec.generateOnce.publicJwksVariable;
        if (declared.includes(publicVariable)) {
          problems.push(`"${name}": ${publicVariable} is written by ${variable}'s key pair, so it cannot also be declared`);
        }
      }
    }
  }
  return problems;
}

/**
 * The whole package.json. Checks that span `jive.cicd` and this abstract's block run here, at decode: an
 * environment the pipeline would deploy with no configuration, or configuration nothing deploys, fails
 * `get-config` instead of a deploy.
 */
export const PackageJsonSchema = makeJivePackageJsonSchema({ [BACKEND_CONVEX_KEY]: BackendConvexSchema }).check(
  Schema.makeFilter((packageJson) => {
    const { cicd } = packageJson.jive;
    const backend = packageJson.jive[BACKEND_CONVEX_KEY];
    const problems = [
      ...environmentsProblems(backend, [...new Set(Object.values(cicd.deploy.branches).flat())], cicd.deploy.previews),
      ...((cicd.requiredSecrets ?? []).includes(TEAM_ACCESS_TOKEN_SECRET)
        ? []
        : [`jive.cicd.requiredSecrets must include ${TEAM_ACCESS_TOKEN_SECRET}, the credential every deploy hook uses`]),
    ];
    return problems.length === 0 ? undefined : problems.join("\n");
  }),
);
export type PackageJson = typeof PackageJsonSchema.Type;

/** The `jive` block `get-config` prints. */
export const JivePackageConfig = PackageJsonSchema.fields.jive;
