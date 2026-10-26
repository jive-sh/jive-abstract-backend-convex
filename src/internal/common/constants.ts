export const CLI_CMD_NAME = "jive-backend-convex";
export const CONVEX_MANAGEMENT_API_URL = "https://api.convex.dev/v1";
export const NPM_REGISTRY_URL = "https://registry.npmjs.org";
/** Where `deploy` assembles the client package before publishing it; under dist/ so it is never committed. */
export const CLIENT_PACKAGE_DIR = "dist/client";
export const CONVEX_GENERATED_DIR = "convex/_generated";
export const CONVEX_CONFIG_FILE = "convex.json";
/** Convex refuses an expiry less than 30 minutes away; the margin covers clock skew. */
export const DEPLOY_KEY_LIFETIME_MINUTES = 35;
