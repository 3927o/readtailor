import {
  CommandExitError as E2BCommandExitError,
  Sandbox as E2BSandbox,
  type CommandStartOpts as E2BCommandStartOpts,
} from '@e2b/code-interpreter';
import {
  CommandExitError as PPIOCommandExitError,
  Sandbox as PPIOSandbox,
  type CommandStartOpts as PPIOCommandStartOpts,
} from 'e2b-code-interpreter-ppio';
import type { NormalizationSandboxConfig } from './sandbox';

export type SandboxCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
};

export type SandboxCommandOptions = {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  user?: 'root' | 'user';
  envs?: Record<string, string>;
};

export type SandboxWriteEntry = {
  path: string;
  data: ArrayBuffer;
};

export interface NormalizationSandboxTransport {
  readonly id: string;
  run(command: string, options: SandboxCommandOptions): Promise<SandboxCommandResult>;
  write(path: string, data: string, signal?: AbortSignal): Promise<void>;
  writeMany(entries: SandboxWriteEntry[]): Promise<void>;
  readText(path: string, signal?: AbortSignal): Promise<string>;
  readBytes(path: string, signal?: AbortSignal): Promise<Uint8Array>;
  kill(): Promise<void>;
}

type CreateTransportOptions = {
  config: NormalizationSandboxConfig;
  attemptId: string;
  timeoutMs: number;
};

type CommandResultLike = {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string | undefined;
};

function commandResult(result: CommandResultLike): SandboxCommandResult {
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.error ? { error: result.error } : {}),
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('sandbox request aborted');
}

function createE2BTransport(sandbox: E2BSandbox): NormalizationSandboxTransport {
  return {
    id: sandbox.sandboxId,
    async run(command, options) {
      try {
        const result = await sandbox.commands.run(command, {
          ...options,
          background: false,
        } as E2BCommandStartOpts & { background: false });
        return commandResult(result);
      } catch (error) {
        if (error instanceof E2BCommandExitError) return commandResult(error);
        throw error;
      }
    },
    async write(path, data, signal) {
      await sandbox.files.write(path, data, signal ? { signal } : undefined);
    },
    async writeMany(entries) {
      await sandbox.files.write(entries);
    },
    readText(path, signal) {
      return sandbox.files.read(path, signal ? { signal } : undefined);
    },
    readBytes(path, signal) {
      return sandbox.files.read(path, { format: 'bytes', ...(signal ? { signal } : {}) });
    },
    async kill() {
      await sandbox.kill();
    },
  };
}

function createPPIOTransport(sandbox: PPIOSandbox): NormalizationSandboxTransport {
  return {
    id: sandbox.sandboxId,
    async run(command, options) {
      const { signal, ...commandOptions } = options;
      throwIfAborted(signal);
      try {
        const result = await sandbox.commands.run(command, {
          ...commandOptions,
          background: false,
        } as PPIOCommandStartOpts & { background: false });
        return commandResult(result);
      } catch (error) {
        if (error instanceof PPIOCommandExitError) return commandResult(error);
        throw error;
      }
    },
    async write(path, data, signal) {
      throwIfAborted(signal);
      await sandbox.files.write(path, data);
    },
    async writeMany(entries) {
      await sandbox.files.write(entries);
    },
    readText(path, signal) {
      throwIfAborted(signal);
      return sandbox.files.read(path);
    },
    readBytes(path, signal) {
      throwIfAborted(signal);
      return sandbox.files.read(path, { format: 'bytes' });
    },
    async kill() {
      await sandbox.kill();
    },
  };
}

export async function createNormalizationSandboxTransport(
  options: CreateTransportOptions,
): Promise<NormalizationSandboxTransport> {
  const commonOptions = {
    apiKey: options.config.apiKey,
    domain: options.config.domain,
    timeoutMs: options.timeoutMs,
    metadata: { readtailor_attempt_id: options.attemptId },
  };

  if (options.config.provider === 'ppio') {
    const createOptions = commonOptions;
    const sandbox = options.config.template
      ? await PPIOSandbox.create(options.config.template, createOptions)
      : await PPIOSandbox.create(createOptions);
    return createPPIOTransport(sandbox);
  }

  const createOptions = { ...commonOptions, allowInternetAccess: false };
  const sandbox = options.config.template
    ? await E2BSandbox.create(options.config.template, createOptions)
    : await E2BSandbox.create(createOptions);
  return createE2BTransport(sandbox);
}
