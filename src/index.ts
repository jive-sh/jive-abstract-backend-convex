/**
 * The public surface of this abstract: the package.json shape a Convex backend package must have. The six
 * CI/CD hooks are reached through the `jive-backend-convex` CLI, not imported.
 */
export {
  BACKEND_CONVEX_KEY,
  BackendConvexSchema,
  DEPLOY_KEY_SECRET,
  JivePackageConfig,
  PackageJsonSchema,
  TEAM_ACCESS_TOKEN_SECRET,
  type BackendConvexConfig,
  type CustomDomain,
  type EnvironmentConfig,
  type EnvironmentVariable,
  type GeneratedValue,
  type PackageJson,
  type RequestDestination,
} from "./internal/public/manifest";
