import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  e2bCreate: vi.fn(),
  ppioCreate: vi.fn(),
}));

vi.mock('@e2b/code-interpreter', () => ({
  CommandExitError: class CommandExitError extends Error {},
  Sandbox: { create: mocks.e2bCreate },
}));

vi.mock('e2b-code-interpreter-ppio', () => ({
  CommandExitError: class CommandExitError extends Error {},
  Sandbox: { create: mocks.ppioCreate },
}));

import { createNormalizationSandboxTransport } from './sandbox-transport';

function fakeSandbox(id: string) {
  return {
    sandboxId: id,
    commands: { run: vi.fn() },
    files: { read: vi.fn(), write: vi.fn() },
    kill: vi.fn(),
  };
}

describe('createNormalizationSandboxTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.e2bCreate.mockResolvedValue(fakeSandbox('e2b-sandbox'));
    mocks.ppioCreate.mockResolvedValue(fakeSandbox('ppio-sandbox'));
  });

  it('uses the current E2B SDK and preserves its no-network option', async () => {
    const transport = await createNormalizationSandboxTransport({
      config: {
        provider: 'e2b',
        apiKey: 'e2b-key',
        template: 'e2b-template',
        domain: 'e2b.dev',
      },
      attemptId: 'attempt-1',
      timeoutMs: 123_000,
    });

    expect(transport.id).toBe('e2b-sandbox');
    expect(mocks.e2bCreate).toHaveBeenCalledWith('e2b-template', {
      apiKey: 'e2b-key',
      domain: 'e2b.dev',
      timeoutMs: 123_000,
      metadata: { readtailor_attempt_id: 'attempt-1' },
      allowInternetAccess: false,
    });
    expect(mocks.ppioCreate).not.toHaveBeenCalled();
  });

  it('uses the PPIO-compatible SDK with an explicit domain', async () => {
    const transport = await createNormalizationSandboxTransport({
      config: {
        provider: 'ppio',
        apiKey: 'ppio-key',
        template: 'ppio-template',
        domain: 'sandbox.ppio.cn',
      },
      attemptId: 'attempt-2',
      timeoutMs: 456_000,
    });

    expect(transport.id).toBe('ppio-sandbox');
    expect(mocks.ppioCreate).toHaveBeenCalledWith('ppio-template', {
      apiKey: 'ppio-key',
      timeoutMs: 456_000,
      metadata: { readtailor_attempt_id: 'attempt-2' },
      domain: 'sandbox.ppio.cn',
    });
    expect(mocks.e2bCreate).not.toHaveBeenCalled();
  });
});
