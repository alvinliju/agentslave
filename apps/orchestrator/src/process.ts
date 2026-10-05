import { spawn } from "node:child_process";

export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
};

export async function runCommand(
  command: string,
  args: string[],
  options: { input?: string | Buffer; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, options.timeoutMs ?? 120_000);
    timer.unref();

    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code ?? 1,
        timedOut,
      });
    });
    if (child.stdin) {
      child.stdin.end(options.input);
    }
  });
}

export async function runChecked(
  command: string,
  args: string[],
  options: { input?: string | Buffer; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<CommandResult> {
  const result = await runCommand(command, args, options);
  if (result.exitCode !== 0) {
    if (result.timedOut) throw new Error(`${command} timed out`);
    const detail = result.stderr.trim() || result.stdout.trim() || "no output";
    throw new Error(`${command} failed with ${result.exitCode}: ${detail.slice(0, 1_000)}`);
  }
  return result;
}
