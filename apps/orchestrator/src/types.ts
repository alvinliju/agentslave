export const jobStatuses = [
  "RECEIVED", "NEEDS_CONTEXT", "READY", "PREPARING", "RUNNING",
  "VERIFYING", "PR_READY", "FAILED", "CANCELLED",
  "MERGED",
] as const;

export type JobStatus = typeof jobStatuses[number];

export type Job = {
  id: string;
  title: string;
  details: string;
  repository: string | null;
  status: JobStatus;
  source: "slack" | "api";
  slackChannel: string | null;
  slackThreadTs: string | null;
  openhandsConversationId: string | null;
  workspaceInstance: string | null;
  branchName: string | null;
  pullRequestUrl: string | null;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type JobEvent = {
  id: number;
  jobId: string;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: Date;
};

export type RepositoryRegistration = {
  fullName: string;
  installationId: number;
  defaultBranch: string;
  verificationCommands: string[][];
};

export type Intake = {
  title: string;
  details: string;
  repository: string | null;
  source: "slack" | "api";
  slackChannel?: string;
  slackThreadTs?: string;
};
