import { createHash } from "node:crypto";
import { PREVIEW_ENVIRONMENT, isEnvironment, type PipelineContext } from "jive-abstract-library";

/**
 * Which Convex deployment one environment of one pipeline run lands on. A named environment is one
 * production-type deployment, referenced by its name in lowercase; Preview is one preview deployment per
 * pull request, or per branch for a manual run, which Convex deletes after its retention period.
 */
export type DeploymentTarget =
  | { readonly _tag: "Production"; readonly reference: string }
  | { readonly _tag: "Preview"; readonly previewIdentifier: string };

const PREVIEW_BRANCH_HASH_LENGTH = 8;

/**
 * A branch name becomes readable text plus a hash of the exact name: lowercasing and replacing characters
 * Convex refuses would otherwise let two branches (`Fix_A`, `fix-a`) share one preview deployment.
 */
function branchPreviewIdentifier(branch: string): string {
  const readable = branch.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  const hash = createHash("sha256").update(branch).digest("hex").slice(0, PREVIEW_BRANCH_HASH_LENGTH);
  return `branch-${readable === "" ? "" : `${readable}-`}${hash}`;
}

export function deploymentTargetFor(environment: string, context: PipelineContext): DeploymentTarget {
  if (!isEnvironment(environment, PREVIEW_ENVIRONMENT)) {
    return { _tag: "Production", reference: environment.toLowerCase() };
  }
  return {
    _tag: "Preview",
    previewIdentifier: context.event.type === "PULL_REQUEST"
      ? `pr-${context.event.id}`
      : branchPreviewIdentifier(context.sourceBranch),
  };
}

export function describeTarget(target: DeploymentTarget): string {
  return target._tag === "Production" ? `deployment "${target.reference}"` : `preview deployment "${target.previewIdentifier}"`;
}
