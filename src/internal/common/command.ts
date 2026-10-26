import { makeCicdCommandFactory, type CicdCommandFactory } from "jive-abstract-library";
import type { BackendModules } from "../modules";
import { layerLive } from "./layer";

export const { makeCicdCommand, makePipelineCommand, makeDeployCommand }: CicdCommandFactory<BackendModules> =
  makeCicdCommandFactory(layerLive);
