import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  assertRequiredArtifacts,
  buildArtifactInventory,
  hashArtifactInventory,
  sha256,
  type ArtifactInventory,
} from './artifacts';
import { runCommand } from './command';

export type StructuredValidationReport = {
  version: string;
  totals: { errors: number; warnings: number };
  sections: Record<string, unknown>;
};

export type ValidationBinding = {
  sourceEpubSha256: string;
  scriptSha256: string;
  outputInventorySha256: string;
  validatorVersion: string;
  validationReportSha256: string;
  blockingErrorCount: number;
  warningCount: number;
};

export type HostValidationResult = {
  binding: ValidationBinding;
  outputInventory: ArtifactInventory;
  report: StructuredValidationReport;
  reportBytes: Uint8Array;
  humanReport: string;
  exitCode: number;
};

export async function validateNormalizedCandidate(options: {
  repoRoot: string;
  sourceEpubPath: string;
  outputDirectory: string;
  normalizerScript: Uint8Array;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<HostValidationResult> {
  const outputDirectory = resolve(options.outputDirectory);
  const sourceEpub = await readFile(resolve(options.sourceEpubPath));
  const inventory = await buildArtifactInventory(outputDirectory);
  assertRequiredArtifacts(inventory, ['book.normalized.html', 'normalization_report.json']);
  if (inventory.files.length > 20_000) {
    throw new Error('normalized output contains more than 20000 files');
  }
  const outputBytes = inventory.files.reduce((total, entry) => total + entry.byteSize, 0);
  if (outputBytes > 512 * 1024 * 1024) {
    throw new Error('normalized output exceeds the 512 MB limit');
  }

  const reportDirectory = await mkdtemp(join(tmpdir(), 'readtailor-host-validation-'));
  try {
    const reportPath = join(reportDirectory, 'nb_check.json');
    const result = await runCommand(
      'python3',
      [
        join(options.repoRoot, 'tools/nb_check.py'),
        join(outputDirectory, 'book.normalized.html'),
        '--baseline',
        resolve(options.sourceEpubPath),
        '--json-report',
        reportPath,
      ],
      {
        cwd: options.repoRoot,
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    if (![0, 2].includes(result.exitCode)) {
      throw new Error(
        `host nb_check failed with exit code ${result.exitCode}: ${(result.stdout + result.stderr).slice(-4000)}`,
      );
    }
    if (result.truncated) {
      throw new Error('host nb_check output exceeded the configured capture limit');
    }

    const reportBytes = await readFile(reportPath);
    const report = JSON.parse(reportBytes.toString('utf8')) as StructuredValidationReport;
    if (
      !report.version ||
      !Number.isInteger(report.totals?.errors) ||
      !Number.isInteger(report.totals?.warnings)
    ) {
      throw new Error('host nb_check returned an invalid structured report');
    }
    if (report.totals.errors !== 0) {
      throw new Error(`host validation has ${report.totals.errors} blocking errors`);
    }
    const expectedExitCode = report.totals.warnings > 0 ? 2 : 0;
    if (result.exitCode !== expectedExitCode) {
      throw new Error(
        `host nb_check exit code ${result.exitCode} conflicts with structured totals (expected ${expectedExitCode})`,
      );
    }

    return {
      binding: {
        sourceEpubSha256: sha256(sourceEpub),
        scriptSha256: sha256(options.normalizerScript),
        outputInventorySha256: hashArtifactInventory(inventory),
        validatorVersion: report.version,
        validationReportSha256: sha256(reportBytes),
        blockingErrorCount: report.totals.errors,
        warningCount: report.totals.warnings,
      },
      outputInventory: inventory,
      report,
      reportBytes,
      humanReport: `${result.stdout}${result.stderr}`,
      exitCode: result.exitCode,
    };
  } finally {
    await rm(reportDirectory, { recursive: true, force: true });
  }
}
