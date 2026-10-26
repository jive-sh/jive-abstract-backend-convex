import { expect, test } from "bun:test";
import type { PipelineContext } from "jive-abstract-library";
import { deploymentTargetFor } from "./deployment-target";

const base: PipelineContext = {
  provider: "Github",
  repository: { owner: "o", name: "r" },
  sourceBranch: "feature/Fix_A",
  sourceCommitSha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  event: { type: "COMMIT" },
};

test("a named environment is the production deployment referenced by its lowercase name", () => {
  expect(deploymentTargetFor("Staging", base)).toEqual({ _tag: "Production", reference: "staging" });
});

test("Preview on a pull request is one deployment per pull request", () => {
  const context: PipelineContext = { ...base, event: { type: "PULL_REQUEST", id: "42", destinationBranch: "main" } };
  expect(deploymentTargetFor("Preview", context)).toEqual({ _tag: "Preview", previewIdentifier: "pr-42" });
});

test("branches that read alike still get distinct preview deployments", () => {
  const first = deploymentTargetFor("Preview", { ...base, sourceBranch: "Fix_A" });
  const second = deploymentTargetFor("Preview", { ...base, sourceBranch: "fix-a" });
  expect(first).not.toEqual(second);
  expect(first._tag === "Preview" && first.previewIdentifier).toMatch(/^branch-fix-a-[0-9a-f]{8}$/);
});
