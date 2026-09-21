import type { AnthropicToolDef } from './anthropicTools.ts';
import { validDay } from './askReporting.ts';
export interface NewJobDetails {
  name:string; jobCode:string; address:string|null; customerName:string|null;
  contactPhone:string|null; contactEmail:string|null; notes:string|null;
  startDate:string|null; endDate:string|null;
  projectedHours:number|null; goalHours:number|null; squareFeet:number|null;
}
export interface JobProposal { kind:'job_proposal'; id:string; details:NewJobDetails; similarJobs:Array<{id:string;name:string;job_code:string}> }
export interface ScheduleProposal { kind:'schedule_proposal'; id:string; assignmentCount:number; message:string }
export type ActionArtifact=JobProposal|ScheduleProposal;
export function parseNewJob(value:unknown,rank:number):NewJobDetails {
  if(rank<1)throw new Error('Creating jobs requires foreman access.');
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Provide job details.');
  const x=value as Record<string,unknown>;
  const text=(key:string,max:number,required=false):string|null=>{
    if(x[key]==null&&!required)return null;
    if(typeof x[key]!=='string'||(x[key] as string).trim().length>max)throw new Error(`Check ${key}.`);
    const v=(x[key] as string).trim();if(required&&!v)throw new Error(`${key} is required.`);return v||null;
  };
  const number=(key:string):number|null=>{if(x[key]==null)return null;if(rank<2)throw new Error('Labor targets require a supervisor or owner.');if(typeof x[key]!=='number'||!Number.isFinite(x[key])||x[key]<0||x[key]>100000000)throw new Error(`Check ${key}.`);return x[key] as number;};
  const name=text('name',200,true)!,jobCode=text('jobCode',60,true)!.toUpperCase().replace(/[^A-Z0-9-]+/g,'-');
  if(!/[A-Z0-9]/.test(jobCode))throw new Error('Use letters or numbers in the job code.');
  const startDate=text('startDate',10),endDate=text('endDate',10);
  if(startDate&&!validDay(startDate)||endDate&&!validDay(endDate)||startDate&&endDate&&startDate>endDate)throw new Error('Choose valid job dates.');
  const contactEmail=text('contactEmail',254);if(contactEmail&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail))throw new Error('Check the contact email.');
  return {name,jobCode,address:text('address',500),customerName:text('customerName',200),contactPhone:text('contactPhone',60),contactEmail,notes:text('notes',5000),startDate,endDate,projectedHours:number('projectedHours'),goalHours:number('goalHours'),squareFeet:number('squareFeet')};
}
const properties=Object.fromEntries(['name','jobCode','address','customerName','contactPhone','contactEmail','notes','startDate','endDate'].map(key=>[key,{type:['name','jobCode'].includes(key)?'string':['string','null'],description:['startDate','endDate'].includes(key)?'YYYY-MM-DD, or null when not supplied.':'Use only information supplied by the user.'}]));
export const JOB_PROPOSAL_TOOL:AnthropicToolDef={name:'prepare_new_job',description:'Prepare a reviewable new-job card; this does not create a job until the user presses Create job. Requires name and job code. Check similar jobs first. Foreman+; labor targets supervisor+. Never infer contact details, dates or labor targets. New jobs start Not ready with normal warehouse staging bays.',input_schema:{type:'object',properties:{...properties,projectedHours:{type:['number','null']},goalHours:{type:['number','null']},squareFeet:{type:['number','null']}},required:['name','jobCode'],additionalProperties:false}};
export const ACTIONS_SYSTEM_PROMPT=`\nUse prepare_new_job for an explicit new-job request. Ask for missing name/job code, show similar-job matches, and do not say created until an actual saved receipt exists. A proposal card is only a preview. Labor targets require supervisor access. Schedule drafts now return review cards: a supervisor reviews fresh conflicts and explicitly publishes. Never call a draft published. Do not clear unrelated drafts as a correction. Approved time off is unavailable time; pending time off needs review. Do not invent crew qualifications, readiness or travel time.\n`;
