import { spawn } from "node:child_process";
import { join } from "node:path";
import { planLaunch, APP } from "./start.mjs";
const plan=await planLaunch();
if(!plan.ok) throw new Error(plan.message);
async function run(args){
  const child=spawn(process.execPath,args,{cwd:APP,env:plan.env,stdio:"inherit"});
  const code=await new Promise(resolve=>child.on("exit",resolve));
  if(code!==0) throw new Error("Workshop build failed");
}
await run([join(APP,"node_modules/typescript/bin/tsc"),"-b"]);
await run([join(APP,"node_modules/vite/bin/vite.js"),"build","--mode","workshop"]);
