import type { QueryClient } from "@tanstack/react-query";
import { supabase } from "../supabase";
import { getRealProfile } from "../install/api";
import { roleRank } from "../install/types";
import { resolveWalkthroughProject } from "./nativeDay";

export interface Sandbox {
    id: string;
    job_code: string;
    actorId: string;
    actorName: string;
    isTest: boolean;
    canEditAllUnits: boolean;
}
export async function readSandbox(projectId: string | null): Promise<Sandbox> {
    const real = await getRealProfile();
    if (!real)
        throw new Error("Sign in to open Workday.");
    const { data: profile, error: pe } = await supabase.from("profiles").select("id,is_test").eq("id", real.id).maybeSingle();
    if (pe)
        throw pe;
    if (!profile)
        throw new Error("Your signed-in profile could not be loaded.");
    const query = supabase.from("projects").select("id,job_code,name,is_test").is("deleted_at", null);
    const { data: projects, error } = await (projectId ? query.eq("id", projectId) : query.or("job_code.ilike.zztest,name.ilike.zztest"));
    if (error)
        throw error;
    if (projectId && projects?.length !== 1)
        throw new Error("That project is unavailable to your account.");
    const project = projectId ? projects![0] : resolveWalkthroughProject(projects ?? []);
    if (profile.is_test) {
        if (!project.is_test)
            throw new Error("Test work requires a project flagged as testing.");
        const { data, error } = await supabase.rpc("is_sandbox_project", { p_project_id: project.id });
        if (error)
            throw error;
        if (data !== true)
            throw new Error("This project is not registered as a sandbox. Nothing can be changed here.");
    }
    const { data: auth } = await supabase.auth.getSession();
    if (auth.session?.user.id !== real.id)
        throw new Error("Sign-in changed. Reopen Workday.");
    return { ...project, actorId: real.id, actorName: real.display_name, isTest: profile.is_test === true, canEditAllUnits: roleRank(real.role) >= 1 };
}
export function workdayProjectQuery(actor: string | null, project: string | null) {
    return {
        queryKey: ["installerDaySandbox", actor, project],
        queryFn: () => readSandbox(project),
        staleTime: 30_000,
    };
}

export async function prepareWorkdayDestination(client: QueryClient, actor: string, project: string) {
    const query = workdayProjectQuery(actor, project);
    if (client.getQueryData<Sandbox>(query.queryKey)) return;
    if (!navigator.onLine) throw new Error("This job has not been saved on this device. Connect before switching to it.");
    const destination = await client.fetchQuery(query);
    if (destination.actorId !== actor) throw new Error("Sign-in changed. Reopen Workday.");
}
