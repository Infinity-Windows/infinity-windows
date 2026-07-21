// Pure copy-builder for the "remove assignment" confirmation. Removing an
// assignment can't be undone, and removing a *published* one also pings the
// crew that the job left their schedule — so that case gets a stronger warning.

export interface RemoveWarningInput {
  status: string;
  jobLabel?: string | null;
  crewCount: number;
}

export interface RemoveWarning {
  title: string;
  lines: string[];
  confirmLabel: string;
  published: boolean;
}

function jobPhrase(jobLabel?: string | null): string {
  const job = jobLabel?.trim();
  return job ? ` for ${job}` : "";
}

export function removeWarning(input: RemoveWarningInput): RemoveWarning {
  const published = input.status === "published";
  const phrase = jobPhrase(input.jobLabel);

  if (!published) {
    return {
      title: "Remove assignment?",
      lines: [`Remove this assignment${phrase}? This can’t be undone.`],
      confirmLabel: "Remove",
      published: false,
    };
  }

  const count = Math.max(0, input.crewCount);
  const crew =
    count === 1
      ? "the crew member on it"
      : count > 1
        ? `all ${count} crew members on it`
        : "the crew";

  return {
    title: "Remove a published assignment?",
    lines: [
      `This assignment${phrase} has already been sent to the field.`,
      `Removing it can’t be undone and will notify ${crew} that the job was taken off their schedule.`,
    ],
    confirmLabel: "Remove & notify crew",
    published: true,
  };
}
