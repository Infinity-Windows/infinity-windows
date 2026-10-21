// Actual post-run entrypoint, called by run-arm.mjs after Playwright/server teardown.
import {readFileSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertRunEnvironment} from './experiment-gates.mjs';
import {collectEvidence,validateEvidence} from './postrun-validation.mjs';
const here=dirname(fileURLToPath(import.meta.url));
const pins=JSON.parse(readFileSync(join(here,'RUNTIME-PINS.json'),'utf8'));
const arm=assertRunEnvironment(process.env,pins);
const result=validateEvidence(collectEvidence(arm.runDir),pins,arm);
writeFileSync(join(arm.runDir,'ARM-VALIDATION.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(result));process.exitCode=result.captureValid?0:1;
