/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";
import type { GenericId as Id } from "convex/values";

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: {
  deploys: {
    latest: FunctionReference<
      "query",
      "public",
      {},
      null | { environment: string; greeting: string; sourceCommitSha: string }
    >;
  };
};

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: {
  deploys: {
    record: FunctionReference<
      "mutation",
      "internal",
      { environment: string; sourceCommitSha: string },
      null
    >;
  };
};

export declare const components: {};
