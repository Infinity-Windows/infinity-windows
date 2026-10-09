export interface BrowserIdentity { protocolVersion:string; product:string; revision:string; userAgent:string; jsVersion:string }
export interface RuntimePins { browser:BrowserIdentity; traceCategories:string[]; order:string[]; flags:Record<string,string> }
export declare function assertBrowserAndCategories(version:BrowserIdentity, available:readonly string[], pins:RuntimePins):string[];
export declare function assertRunEnvironment(env:Record<string,string|undefined>,pins:RuntimePins):{index:number;mode:string;runDir:string};
export declare function fileMap(root:string):Record<string,string>;
export declare function verifyPair(pair:string,manifest:Record<'old'|'new',{sha256:Record<string,string>}>):Record<'old'|'new',{files:number;workerSha256:string;path:string}>;

export declare const CASE_TITLE:string;
export declare const CASE_GREP:RegExp;
export declare function shellQuote(value:string):string;
export declare function readPinnedManifest(path:string|URL,pin:{manifestSha256:string;workerSha256:string}):{old:{sha256:Record<string,string>};new:{sha256:Record<string,string>}};
export declare function observationOnly<T>(action:()=>Promise<T>,onError:(error:unknown)=>Promise<unknown>):Promise<T|undefined>;
