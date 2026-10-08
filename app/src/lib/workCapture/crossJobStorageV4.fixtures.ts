/** Synthetic new evidence fixtures; existing original/RecordV3 fixtures reused. */
import {genesis,row,id} from './crossJobStorageV3.fixtures';
import type {RecordV3} from './crossJobStorageV3';
import type {AttemptEvidenceV1,AttemptFactV1} from './crossJobStorageV4';
export function evidenceFixture(fact:AttemptFactV1={kind:'not_invoked'}){
 const original=genesis();const record:RecordV3={...row(original),revision:2,everAttempted:true,attemptToken:id(70),hold:'unknown'};
 const evidence:AttemptEvidenceV1={encodingVersion:1,contract:'cross_job_adapter_attempt_evidence_v1',boundary:'bound_command_rpc_invocation',ownerId:record.ownerId,deviceId:record.deviceId,commandId:record.commandId,attemptToken:record.attemptToken!,localLoginGeneration:original.fences.loginGeneration,originalCommandBytes:original.commandBytes,settlementRevision:2,fact};
 return {record,evidence};
}
