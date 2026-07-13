import { spawn } from 'node:child_process';

export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
};

export async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
    signal?: AbortSignal;
  },
): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  const maxOutputBytes = options.maxOutputBytes ?? 2 * 1024 * 1024;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let truncated = false;
    let settled = false;

    const collect = (target: Buffer[], chunk: Buffer) => {
      if (outputBytes >= maxOutputBytes) {
        truncated = true;
        return;
      }
      const remaining = maxOutputBytes - outputBytes;
      const accepted = chunk.subarray(0, remaining);
      target.push(accepted);
      outputBytes += accepted.byteLength;
      if (accepted.byteLength < chunk.byteLength) {
        truncated = true;
      }
    };

    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));

    const finishWithError = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
      child.kill('SIGKILL');
      reject(error);
    };
    const abort = () => finishWithError(new Error(`${command} aborted`));
    const timeout = setTimeout(
      () => finishWithError(new Error(`${command} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );

    if (options.signal?.aborted) {
      abort();
      return;
    }
    options.signal?.addEventListener('abort', abort, { once: true });
    child.once('error', finishWithError);
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
      resolve({
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        truncated,
      });
    });
  });
}
