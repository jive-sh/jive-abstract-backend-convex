import { Effect } from "effect";
import { makeCicdCommand } from "../../common/command";

export const audit = makeCicdCommand(
  "audit",
  "no-op: replace this hook with the package's own tests",
  function* () {
    yield* Effect.log("Nothing to audit");
  },
);
