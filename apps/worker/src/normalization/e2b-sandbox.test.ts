import { describe, expect, it, vi } from 'vitest';
import { RemoteNormalizationSandbox } from './e2b-sandbox';
import type { NormalizationSandboxTransport } from './sandbox-transport';

describe('RemoteNormalizationSandbox', () => {
  it('runs Agent shell commands through the fixed root wrapper and drops Linux privileges', async () => {
    const run = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({
        exit_code: 0,
        timed_out: false,
        stdout: 'ok\n',
        stderr: '',
        truncated: { stdout: false, stderr: false },
      }),
      stderr: '',
    });
    const transport = {
      id: 'sandbox-1',
      run,
      write: vi.fn(),
      writeMany: vi.fn(),
      readText: vi.fn(),
      readBytes: vi.fn(),
      kill: vi.fn(),
    } satisfies NormalizationSandboxTransport;
    const sandbox = new RemoteNormalizationSandbox(transport, 'ppio', 'source-sha');

    await sandbox.runShell({ command: 'printf ok', timeoutSeconds: 5 });

    expect(run).toHaveBeenCalledWith(
      expect.stringContaining(
        'runuser --user readtailor-normalizer -- env -i HOME=/tmp/readtailor/work',
      ),
      expect.objectContaining({
        user: 'root',
        envs: {
          SHELL_COMMAND: 'printf ok',
          SHELL_TIMEOUT_SECONDS: '5',
        },
      }),
    );
  });
});
