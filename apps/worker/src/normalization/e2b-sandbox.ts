import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  CommandExitError,
  Sandbox,
  type CommandResult,
  type CommandStartOpts,
} from '@e2b/code-interpreter';
import type {
  NormalizationFinishBinding,
  ToolTextResult,
} from '@readtailor/agent-kit';
import {
  assertSafeRelativePath,
  hashArtifactInventory,
  sha256,
  type ArtifactInventory,
} from '@readtailor/normalized-book';
import type {
  NormalizationArtifactSink,
  NormalizationSandboxSession,
} from './sandbox';

const ROOT = '/tmp/readtailor';
const SOURCE_EPUB = `${ROOT}/source/source.epub`;
const SOURCE_ROOT = `${ROOT}/source/unpacked`;
const NORMALIZER = `${ROOT}/normalize.py`;
const OUTPUT_ROOT = `${ROOT}/output/current`;
const SPEC = `${ROOT}/spec/normalized_book_spec.md`;
const HELPER = `${ROOT}/tools/normalization_sandbox.py`;
const NB_LINTER = `${ROOT}/tools/nb_linter.py`;
const NB_CHECK = `${ROOT}/tools/nb_check.py`;
const VALIDATION_JSON = `${ROOT}/reports/nb_check.json`;
const NORMALIZER_USER = 'readtailor-normalizer';

type SandboxInventory = ArtifactInventory & { sha256: string };

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function truncate(text: string, max = 40_000): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max)}\n… output truncated …`, truncated: true };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function countOccurrences(source: string, expected: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = source.indexOf(expected, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + expected.length;
  }
}

async function runAllowingExit(
  sandbox: Sandbox,
  command: string,
  options: CommandStartOpts,
): Promise<CommandResult> {
  try {
    return await sandbox.commands.run(command, { ...options, background: false });
  } catch (error) {
    if (error instanceof CommandExitError) {
      return {
        exitCode: error.exitCode,
        stdout: error.stdout,
        stderr: error.stderr,
        ...(error.error ? { error: error.error } : {}),
      };
    }
    throw error;
  }
}

export class E2BNormalizationSandbox implements NormalizationSandboxSession {
  readonly provider = 'e2b';
  private scriptRevision = 0;
  private runSequence = 0;
  private currentScriptSha256: string | undefined;
  private lastSuccessfulRun: { sequence: number; scriptSha256: string } | undefined;
  private lastValidation:
    | {
        runSequence: number;
        scriptSha256: string;
        outputInventorySha256: string;
        reportSha256: string;
        validatorVersion: string;
        errors: number;
        warnings: number;
      }
    | undefined;
  private finishBinding: NormalizationFinishBinding | undefined;
  private closed = false;

  constructor(
    private readonly sandbox: Sandbox,
    private readonly sourceEpubSha256: string,
    private readonly artifactSink?: NormalizationArtifactSink,
  ) {}

  get id(): string {
    return this.sandbox.sandboxId;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('normalization sandbox is closed');
  }

  private requestOptions(signal?: AbortSignal) {
    return signal ? { signal } : {};
  }

  private commandOptions(options: {
    timeoutMs: number;
    signal?: AbortSignal | undefined;
    user?: string | undefined;
    envs?: Record<string, string> | undefined;
  }) {
    return {
      cwd: ROOT,
      timeoutMs: options.timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.user ? { user: options.user } : {}),
      ...(options.envs ? { envs: options.envs } : {}),
    };
  }

  private invalidateAfterScriptChange(scriptBytes: Uint8Array): void {
    this.currentScriptSha256 = sha256(scriptBytes);
    this.lastSuccessfulRun = undefined;
    this.lastValidation = undefined;
    this.finishBinding = undefined;
  }

  private async inventory(signal?: AbortSignal): Promise<SandboxInventory> {
    const result = await runAllowingExit(
      this.sandbox,
      `python3 ${HELPER} inventory`,
      this.commandOptions({ timeoutMs: 120_000, signal }),
    );
    if (result.exitCode !== 0) {
      throw new Error(`failed to inventory sandbox output: ${(result.stdout + result.stderr).slice(-4000)}`);
    }
    const inventory = JSON.parse(result.stdout) as SandboxInventory;
    if (
      inventory.version !== 'artifact-inventory-1.0' ||
      !Array.isArray(inventory.files) ||
      inventory.sha256 !== hashArtifactInventory(inventory)
    ) {
      throw new Error('sandbox returned an invalid output inventory');
    }
    return inventory;
  }

  async runShell(
    input: { command: string; timeoutSeconds?: number },
    signal?: AbortSignal,
  ): Promise<ToolTextResult> {
    this.assertOpen();
    if (!input.command || input.command.length > 20_000 || input.command.includes('\0')) {
      throw new Error('shell command must contain 1 to 20000 non-NUL characters');
    }
    const timeoutSeconds = input.timeoutSeconds ?? 30;
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 120) {
      throw new Error('shell timeout must be an integer from 1 to 120 seconds');
    }
    const result = await runAllowingExit(
      this.sandbox,
      `python3 ${HELPER} run-shell`,
      this.commandOptions({
        timeoutMs: (timeoutSeconds + 15) * 1000,
        signal,
        user: NORMALIZER_USER,
        envs: {
          SHELL_COMMAND: input.command,
          SHELL_TIMEOUT_SECONDS: String(timeoutSeconds),
        },
      }),
    );
    if (result.exitCode !== 0) {
      throw new Error(`trusted shell wrapper failed: ${(result.stdout + result.stderr).slice(-4000)}`);
    }
    const shell = JSON.parse(result.stdout) as {
      exit_code: number;
      timed_out: boolean;
      stdout: string;
      stderr: string;
      truncated: { stdout: boolean; stderr: boolean };
    };
    const output = truncate(
      `exit_code=${shell.exit_code}\ntimed_out=${shell.timed_out}\nstdout:\n${shell.stdout}\nstderr:\n${shell.stderr}`,
    );
    return {
      text: output.text,
      details: {
        exitCode: shell.exit_code,
        timedOut: shell.timed_out,
        stdoutTruncated: shell.truncated.stdout,
        stderrTruncated: shell.truncated.stderr,
        responseTruncated: output.truncated,
      },
    };
  }

  async inspectEpubStructure(signal?: AbortSignal): Promise<ToolTextResult> {
    this.assertOpen();
    const result = await runAllowingExit(
      this.sandbox,
      `python3 ${HELPER} inspect-epub-structure`,
      this.commandOptions({ timeoutMs: 120_000, signal }),
    );
    if (result.exitCode !== 0) {
      throw new Error(`failed to inspect EPUB structure: ${(result.stdout + result.stderr).slice(-4000)}`);
    }
    const output = truncate(result.stdout);
    return {
      text: output.text,
      details: { exitCode: result.exitCode, responseTruncated: output.truncated },
    };
  }

  async writeNormalizer(
    input: { content: string },
    signal?: AbortSignal,
  ): Promise<ToolTextResult> {
    this.assertOpen();
    if (!input.content || input.content.length > 500_000 || input.content.includes('\0')) {
      throw new Error('normalize.py must contain 1 to 500000 non-NUL characters');
    }
    const bytes = encode(input.content);
    await this.sandbox.files.write(NORMALIZER, input.content, this.requestOptions(signal));
    this.scriptRevision += 1;
    this.invalidateAfterScriptChange(bytes);
    await this.artifactSink?.({
      kind: 'normalizer_script',
      revision: this.scriptRevision,
      bytes,
      metadata: { sha256: this.currentScriptSha256, mode: 'write' },
    });
    return {
      text: `normalize.py revision ${this.scriptRevision} written (${bytes.byteLength} bytes, sha256=${this.currentScriptSha256})`,
      details: { revision: this.scriptRevision, sha256: this.currentScriptSha256 },
    };
  }

  async patchNormalizer(
    input: { expected: string; replacement: string },
    signal?: AbortSignal,
  ): Promise<ToolTextResult> {
    this.assertOpen();
    const current = await this.sandbox.files.read(NORMALIZER, this.requestOptions(signal));
    const occurrences = countOccurrences(current, input.expected);
    if (occurrences !== 1) {
      throw new Error(`patch expected text must occur exactly once; found ${occurrences}`);
    }
    return this.writeNormalizer(
      { content: current.replace(input.expected, input.replacement) },
      signal,
    );
  }

  async runNormalizer(signal?: AbortSignal): Promise<ToolTextResult> {
    this.assertOpen();
    if (!this.currentScriptSha256) throw new Error('normalize.py has not been written');
    const cleanup = await runAllowingExit(
      this.sandbox,
      `rm -rf ${OUTPUT_ROOT}`,
      this.commandOptions({ timeoutMs: 30_000, signal, user: 'root' }),
    );
    if (cleanup.exitCode !== 0) {
      throw new Error(`failed to clear the previous normalizer output: ${(cleanup.stdout + cleanup.stderr).slice(-4000)}`);
    }
    const setup = await runAllowingExit(
      this.sandbox,
      `mkdir -p ${OUTPUT_ROOT} ${ROOT}/reports ${ROOT}/normalizer-logs && chmod 0644 ${NORMALIZER} && chmod 0777 ${ROOT}/output ${OUTPUT_ROOT} ${ROOT}/normalizer-logs && chmod 0755 ${ROOT}/reports`,
      this.commandOptions({ timeoutMs: 30_000, signal, user: 'root' }),
    );
    if (setup.exitCode !== 0) {
      throw new Error(`failed to prepare a clean normalizer output: ${(setup.stdout + setup.stderr).slice(-4000)}`);
    }
    this.runSequence += 1;
    this.lastSuccessfulRun = undefined;
    this.lastValidation = undefined;
    this.finishBinding = undefined;
    const wrapper = await (async () => {
      try {
        return await runAllowingExit(
          this.sandbox,
          `runuser --user ${NORMALIZER_USER} -- python3 ${HELPER} run-normalizer`,
          this.commandOptions({ timeoutMs: 10 * 60_000, signal, user: 'root' }),
        );
      } finally {
        const lockOutput = await runAllowingExit(
          this.sandbox,
          `chown -R root:root ${OUTPUT_ROOT} && chmod -R a-w,a+rX ${OUTPUT_ROOT}`,
          this.commandOptions({ timeoutMs: 30_000, user: 'root' }),
        );
        if (lockOutput.exitCode !== 0) {
          throw new Error(`failed to lock normalizer output: ${(lockOutput.stdout + lockOutput.stderr).slice(-4000)}`);
        }
      }
    })();
    if (wrapper.exitCode !== 0) {
      throw new Error(`normalizer wrapper failed: ${(wrapper.stdout + wrapper.stderr).slice(-4000)}`);
    }
    const wrapperResult = JSON.parse(wrapper.stdout) as {
      exit_code: number;
      truncated: { stdout: boolean; stderr: boolean };
    };
    const [stdoutBytes, stderrBytes] = await Promise.all([
      this.sandbox.files.read(`${ROOT}/normalizer-logs/normalizer.stdout`, { format: 'bytes' }),
      this.sandbox.files.read(`${ROOT}/normalizer-logs/normalizer.stderr`, { format: 'bytes' }),
    ]);
    const stdout = new TextDecoder().decode(stdoutBytes);
    const stderr = new TextDecoder().decode(stderrBytes);
    await Promise.all([
      this.artifactSink?.({
        kind: 'normalizer_stdout',
        revision: this.runSequence,
        bytes: stdoutBytes,
        metadata: { exitCode: wrapperResult.exit_code, truncated: wrapperResult.truncated.stdout },
      }),
      this.artifactSink?.({
        kind: 'normalizer_stderr',
        revision: this.runSequence,
        bytes: stderrBytes,
        metadata: { exitCode: wrapperResult.exit_code, truncated: wrapperResult.truncated.stderr },
      }),
    ]);
    const output = truncate(`${stdout}${stderr}`);
    if (wrapperResult.exit_code !== 0) {
      throw new Error(`normalize.py exited ${wrapperResult.exit_code}\n${output.text}`);
    }
    this.lastSuccessfulRun = {
      sequence: this.runSequence,
      scriptSha256: this.currentScriptSha256,
    };
    return {
      text: `normalize.py exited 0\n${output.text}`,
      details: { runSequence: this.runSequence, logsTruncated: output.truncated },
    };
  }

  async runNbLinter(signal?: AbortSignal): Promise<ToolTextResult> {
    this.assertOpen();
    if (!this.lastSuccessfulRun) throw new Error('run_normalizer must succeed first');
    const result = await runAllowingExit(
      this.sandbox,
      `python3 ${NB_LINTER} ${OUTPUT_ROOT}/book.normalized.html`,
      this.commandOptions({ timeoutMs: 5 * 60_000, signal }),
    );
    const report = `${result.stdout}${result.stderr}`;
    await this.artifactSink?.({
      kind: 'linter_report',
      revision: this.runSequence,
      bytes: encode(report),
      metadata: { exitCode: result.exitCode },
    });
    if (![0, 1, 2].includes(result.exitCode)) {
      throw new Error(`nb_linter failed unexpectedly with exit ${result.exitCode}`);
    }
    const output = truncate(report);
    return {
      text: output.text,
      details: { exitCode: result.exitCode, logsTruncated: output.truncated },
    };
  }

  async runNbCheck(signal?: AbortSignal): Promise<ToolTextResult> {
    this.assertOpen();
    const run = this.lastSuccessfulRun;
    if (!run) throw new Error('run_normalizer must succeed first');
    const result = await runAllowingExit(
      this.sandbox,
      `python3 ${NB_CHECK} ${OUTPUT_ROOT}/book.normalized.html --baseline ${SOURCE_EPUB} --json-report ${VALIDATION_JSON}`,
      this.commandOptions({ timeoutMs: 10 * 60_000, signal, user: 'root' }),
    );
    if (![0, 1, 2].includes(result.exitCode)) {
      throw new Error(`nb_check failed unexpectedly with exit ${result.exitCode}`);
    }
    const reportBytes = await this.sandbox.files.read(VALIDATION_JSON, {
      format: 'bytes',
      ...this.requestOptions(signal),
    });
    const report = JSON.parse(new TextDecoder().decode(reportBytes)) as {
      version: string;
      totals: { errors: number; warnings: number };
    };
    if (
      !report.version ||
      !Number.isInteger(report.totals?.errors) ||
      !Number.isInteger(report.totals?.warnings)
    ) {
      throw new Error('nb_check returned an invalid structured report');
    }
    const expectedExitCode =
      report.totals.errors > 0 ? 1 : report.totals.warnings > 0 ? 2 : 0;
    if (result.exitCode !== expectedExitCode) {
      throw new Error(
        `nb_check exit code ${result.exitCode} conflicts with structured totals (expected ${expectedExitCode})`,
      );
    }
    const inventory = await this.inventory(signal);
    this.lastValidation = {
      runSequence: run.sequence,
      scriptSha256: run.scriptSha256,
      outputInventorySha256: inventory.sha256,
      reportSha256: sha256(reportBytes),
      validatorVersion: report.version,
      errors: report.totals.errors,
      warnings: report.totals.warnings,
    };
    await this.artifactSink?.({
      kind: 'validation_report',
      revision: this.runSequence,
      bytes: reportBytes,
      metadata: {
        exitCode: result.exitCode,
        errors: report.totals.errors,
        warnings: report.totals.warnings,
        outputInventorySha256: inventory.sha256,
      },
    });
    const output = truncate(`${result.stdout}${result.stderr}`);
    return {
      text: output.text,
      details: {
        exitCode: result.exitCode,
        blockingErrorCount: report.totals.errors,
        warningCount: report.totals.warnings,
        validatorVersion: report.version,
        outputInventorySha256: inventory.sha256,
        validationReportSha256: this.lastValidation.reportSha256,
        logsTruncated: output.truncated,
      },
    };
  }

  async finishNormalization(signal?: AbortSignal): Promise<NormalizationFinishBinding> {
    this.assertOpen();
    const currentScript = await this.readNormalizer();
    const currentScriptSha256 = sha256(currentScript);
    const run = this.lastSuccessfulRun;
    const validation = this.lastValidation;
    if (!run || run.scriptSha256 !== currentScriptSha256) {
      throw new Error('latest normalize.py has not completed a successful run');
    }
    if (
      !validation ||
      validation.runSequence !== run.sequence ||
      validation.scriptSha256 !== currentScriptSha256
    ) {
      throw new Error('latest normalizer run has not completed a full nb_check');
    }
    const inventory = await this.inventory(signal);
    if (inventory.sha256 !== validation.outputInventorySha256) {
      throw new Error('normalized output changed after the latest nb_check');
    }
    const required = new Set(inventory.files.map((entry) => entry.path));
    for (const path of ['book.normalized.html', 'normalization_report.json']) {
      if (!required.has(path)) throw new Error(`normalized output is missing ${path}`);
    }
    if (validation.errors !== 0) {
      throw new Error(`latest nb_check still has ${validation.errors} blocking errors`);
    }
    this.finishBinding = {
      sourceEpubSha256: this.sourceEpubSha256,
      scriptSha256: currentScriptSha256,
      outputInventorySha256: inventory.sha256,
      validatorVersion: validation.validatorVersion,
      validationReportSha256: validation.reportSha256,
      blockingErrorCount: validation.errors,
      warningCount: validation.warnings,
    };
    return this.finishBinding;
  }

  async readNormalizer(): Promise<Uint8Array> {
    this.assertOpen();
    return this.sandbox.files.read(NORMALIZER, { format: 'bytes' });
  }

  getFinishBinding(): NormalizationFinishBinding | undefined {
    return this.finishBinding ? { ...this.finishBinding } : undefined;
  }

  async downloadOutput(destination: string): Promise<void> {
    this.assertOpen();
    if (!this.finishBinding) throw new Error('finish_normalization must succeed before download');
    const inventory = await this.inventory();
    if (inventory.sha256 !== this.finishBinding.outputInventorySha256) {
      throw new Error('sandbox output changed after finish_normalization');
    }
    const destinationRoot = resolve(destination);
    await mkdir(destinationRoot, { recursive: true });
    for (const entry of inventory.files) {
      const path = assertSafeRelativePath(entry.path);
      const bytes = await this.sandbox.files.read(`${OUTPUT_ROOT}/${path}`, { format: 'bytes' });
      if (bytes.byteLength !== entry.byteSize || sha256(bytes) !== entry.sha256) {
        throw new Error(`sandbox artifact changed during download: ${path}`);
      }
      const outputPath = join(destinationRoot, path);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, bytes);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.sandbox.kill().catch(() => false);
  }
}

export async function createE2BNormalizationSandbox(options: {
  apiKey: string;
  sourceEpub: Uint8Array;
  repoRoot: string;
  attemptId: string;
  timeoutMs?: number;
  template?: string;
  artifactSink?: NormalizationArtifactSink;
}): Promise<E2BNormalizationSandbox> {
  const createOptions = {
    apiKey: options.apiKey,
    timeoutMs: options.timeoutMs ?? 30 * 60_000,
    allowInternetAccess: false,
    metadata: { readtailor_attempt_id: options.attemptId },
  };
  const sandbox = options.template
    ? await Sandbox.create(options.template, createOptions)
    : await Sandbox.create(createOptions);

  try {
    const [spec, helper, linter, checker] = await Promise.all([
      readFile(join(options.repoRoot, 'docs/contracts/normalized_book_spec.md')),
      readFile(join(options.repoRoot, 'tools/normalization_sandbox.py')),
      readFile(join(options.repoRoot, 'tools/nb_linter.py')),
      readFile(join(options.repoRoot, 'tools/nb_check.py')),
    ]);
    await sandbox.files.write([
      { path: SOURCE_EPUB, data: toArrayBuffer(options.sourceEpub) },
      { path: SPEC, data: toArrayBuffer(spec) },
      { path: HELPER, data: toArrayBuffer(helper) },
      { path: NB_LINTER, data: toArrayBuffer(linter) },
      { path: NB_CHECK, data: toArrayBuffer(checker) },
    ]);
    const prepare = await runAllowingExit(
      sandbox,
      `id -u ${NORMALIZER_USER} >/dev/null 2>&1 || useradd --create-home --shell /bin/bash ${NORMALIZER_USER}; mkdir -p ${SOURCE_ROOT} ${OUTPUT_ROOT} ${ROOT}/reports ${ROOT}/normalizer-logs ${ROOT}/work && python3 ${HELPER} preflight && python3 -m zipfile -e ${SOURCE_EPUB} ${SOURCE_ROOT} && chmod 0755 ${ROOT} && chmod -R a+rX,go-w ${ROOT}/source ${ROOT}/tools ${ROOT}/spec && chmod 0755 ${ROOT}/output ${OUTPUT_ROOT} && chmod 0777 ${ROOT}/normalizer-logs && chown ${NORMALIZER_USER}:${NORMALIZER_USER} ${ROOT}/work && chmod 0700 ${ROOT}/work && chmod 0755 ${ROOT}/reports && python3 -c "import bs4"`,
      { cwd: ROOT, timeoutMs: 120_000, user: 'root' },
    );
    if (prepare.exitCode !== 0) {
      throw new Error(`failed to prepare E2B sandbox: ${(prepare.stdout + prepare.stderr).slice(-4000)}`);
    }
    return new E2BNormalizationSandbox(sandbox, sha256(options.sourceEpub), options.artifactSink);
  } catch (error) {
    await sandbox.kill().catch(() => false);
    throw error;
  }
}
