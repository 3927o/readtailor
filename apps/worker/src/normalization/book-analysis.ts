import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  runBookAnalysisAgent,
  type AgentTraceHandler,
  type BookAnalysisAgentEvent,
  type BookAnalysisToolbox,
  type BookProfile,
  type ToolTextResult,
} from '@readtailor/agent-kit';
import { readBookMetadata, runCommand, type BookMetadata } from '@readtailor/normalized-book';
import {
  createManifestIndex,
  findNode,
  type ReadingManifest,
} from '@readtailor/reader-core';
import { readPublishedReadingManifestJson } from '../reading-manifest';

async function runAnalysisHelper(options: {
  repoRoot: string;
  packageDirectory: string;
  args: string[];
  signal?: AbortSignal;
}): Promise<ToolTextResult> {
  const result = await runCommand(
    'python3',
    [
      join(options.repoRoot, 'tools/book_analysis.py'),
      ...options.args,
      join(options.packageDirectory, 'book.normalized.html'),
    ],
    {
      cwd: options.repoRoot,
      timeoutMs: 3 * 60_000,
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(`book analysis helper failed: ${(result.stdout + result.stderr).slice(-4000)}`);
  }
  if (result.truncated) throw new Error('book analysis helper output was truncated');
  return { text: result.stdout, details: { exitCode: result.exitCode } };
}

export async function createBookAnalysisToolbox(options: {
  repoRoot: string;
  packageDirectory: string;
}): Promise<{
  toolbox: BookAnalysisToolbox;
  manifest: ReadingManifest;
  metadata: BookMetadata;
}> {
  const [manifest, metadata] = await Promise.all([
    readFile(join(options.packageDirectory, 'reading_manifest.json'), 'utf8').then(
      readPublishedReadingManifestJson,
    ),
    readBookMetadata(options.packageDirectory),
  ]);
  const manifestIndex = createManifestIndex(manifest);
  const eligibleKeys = new Set(
    manifest.nodes
      .filter((node) => node.tailoringEligible)
      .map((node) => `${node.sectionId}\0${node.segment}`),
  );

  const toolbox: BookAnalysisToolbox = {
    async getBookMetadata() {
      return {
        text: JSON.stringify(
          {
            ...metadata,
            node_count: manifest.nodeCount,
            tailoring_eligible_node_count: eligibleKeys.size,
            book_total_characters: manifest.bookTotalCharacters,
          },
          null,
          2,
        ),
      };
    },
    async getBookOutline(input) {
      const offset = input.offset ?? 0;
      const limit = input.limit ?? 100;
      return {
        text: JSON.stringify(
          {
            ...(offset === 0 ? { outline: manifest.outline } : {}),
            nodes: manifest.nodes.slice(offset, offset + limit),
            offset,
            next_offset: offset + limit < manifest.nodes.length ? offset + limit : null,
            total: manifest.nodes.length,
          },
          null,
          2,
        ),
      };
    },
    readBookNode(input, signal) {
      return runAnalysisHelper({
        ...options,
        args: [
          'read',
          '--section-id',
          input.sectionId,
          '--segment',
          String(input.segment),
          '--max-characters',
          String(input.maxCharacters ?? 6000),
        ],
        ...(signal ? { signal } : {}),
      });
    },
    searchBook(input, signal) {
      return runAnalysisHelper({
        ...options,
        args: ['search', '--query', input.query, '--limit', String(input.limit ?? 20)],
        ...(signal ? { signal } : {}),
      });
    },
    getNodeStats(input, signal) {
      return runAnalysisHelper({
        ...options,
        args: [
          'stats',
          '--section-id',
          input.sectionId,
          '--segment',
          String(input.segment),
        ],
        ...(signal ? { signal } : {}),
      });
    },
    async saveBookProfile(profile) {
      const candidates = profile.trial_candidates;
      const minimum = Math.min(9, eligibleKeys.size);
      if (eligibleKeys.size === 0) {
        throw new Error('book has no tailoring-eligible nodes for trial candidates');
      }
      if (candidates.length < minimum || candidates.length > Math.min(15, eligibleKeys.size)) {
        throw new Error(
          `book profile needs ${minimum}–${Math.min(15, eligibleKeys.size)} trial candidates`,
        );
      }
      const seen = new Set<string>();
      for (const candidate of candidates) {
        const key = `${candidate.section_id}\0${candidate.segment}`;
        const node = findNode(manifestIndex, candidate.section_id, candidate.segment);
        if (!node?.tailoringEligible || !eligibleKeys.has(key)) {
          throw new Error(`trial candidate is missing or not tailoring eligible: ${key}`);
        }
        if (seen.has(key)) throw new Error(`duplicate trial candidate: ${key}`);
        seen.add(key);
      }
      const serialized = JSON.stringify(profile);
      if (serialized.length > 50_000) throw new Error('book profile exceeds the 50 KB limit');
    },
  };

  return { toolbox, manifest, metadata };
}

export async function analyzeBookPackage(options: {
  repoRoot: string;
  packageDirectory: string;
  modelApiBaseUrl: string;
  modelApiKey: string;
  modelName: string;
  sessionId?: string;
  maxTurns?: number;
  timeoutMs?: number;
  onEvent?: (event: BookAnalysisAgentEvent) => void | Promise<void>;
  onTrace?: AgentTraceHandler;
}): Promise<{ profile: BookProfile; turns: number; toolCalls: number }> {
  const { toolbox } = await createBookAnalysisToolbox(options);
  const result = await runBookAnalysisAgent({
    apiBaseUrl: options.modelApiBaseUrl,
    apiKey: options.modelApiKey,
    modelName: options.modelName,
    toolbox,
    sessionId: options.sessionId ?? randomUUID(),
    ...(options.maxTurns ? { maxTurns: options.maxTurns } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    ...(options.onTrace ? { onTrace: options.onTrace } : {}),
  });
  await writeFile(
    join(options.packageDirectory, 'book_profile.json'),
    `${JSON.stringify(result.profile, null, 2)}\n`,
    'utf8',
  );
  return result;
}
