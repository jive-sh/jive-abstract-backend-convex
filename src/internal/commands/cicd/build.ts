import { Effect } from "effect";
import { makeCicdCommand } from "../../common/command";
import { backendModules } from "../../modules";

export const build = makeCicdCommand(
  "build",
  "validate package.json and convex.json and typecheck the Convex functions; the push itself happens in deploy",
  function* () {
    const packageJson = yield* (yield* backendModules.Package).load();
    yield* (yield* backendModules.ClientPackage).checkPublishable(packageJson);
    yield* (yield* backendModules.ConvexCli).typecheckFunctions();
    yield* Effect.log("Build complete");
  },
);
