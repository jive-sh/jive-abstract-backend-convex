import { Command } from "commander";
import { audit } from "./audit";
import { build } from "./build";
import { deploy } from "./deploy";
import { deployUrl } from "./deploy-url";
import { getConfig } from "./get-config";
import { uploadArtifacts } from "./upload-artifacts";

export const cicd = new Command("cicd").summary("hooks invoked by Jive's reusable CI/CD pipeline");

[getConfig, build, audit, deployUrl, uploadArtifacts, deploy].forEach((command) => { cicd.addCommand(command); });
