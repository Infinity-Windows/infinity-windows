interface PublicWorker { url():string }
interface PublicMessage { text():string;worker():PublicWorker|null;page():unknown|null;timestamp():number }
export declare function createWorkerConsoleRecorder(options:{mode:string;fileHashes:Record<string,string>;origin?:string}):{
 receive(message:PublicMessage):void;
 finish():{mode:string;records:unknown[];gaps:string[];earlyRecordCoverage:string;workerIdentity:string;engineRequestIdentity:string;additionalAutoAttachOrDebuggerCommands:number};
};
