import { Effect } from "effect";
import { makePipelineCommand } from "../../common/command";

export const uploadArtifacts = makePipelineCommand(
  "upload-artifacts",
  "no-op: the functions are pushed and the client published in deploy, per environment",
  function* (context) {
    yield* Effect.log(`Nothing to upload for ${context.repository.owner}/${context.repository.name}`);
  },
);
