import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import type { PresetBookTemplate, PresetReadyGenerationTemplate } from './preset-book-templates';

const DEFAULT_SOURCE_USER_BOOK_ID = 'af778839-dea8-4e6f-89f9-31ea5e650414';
const DEFAULT_OUTPUT_PATH = fileURLToPath(
  new URL('./preset-book-templates/zarathustra.v1.json', import.meta.url),
);

type SourceBookRow = {
  id: string;
  shared_book_id: string;
  title: string;
  epub_sha256: string;
  package_version: string;
  manifest_version: string;
  file_hashes: Record<string, string>;
  current_interview_session_id: string | null;
  current_book_reader_profile_version_id: string | null;
  current_strategy_draft_version_id: string | null;
  current_strategy_version_id: string | null;
  current_trial_revision_id: string | null;
};

type GenerationRow = {
  trial_segment_id: string | null;
  section_id: string;
  segment: number;
  result: PresetReadyGenerationTemplate['result'];
  model_config_id: string;
  prompt_version: string;
  attempt_count: number;
  max_attempts: number;
};

function requiredPointer(value: string | null, name: string): string {
  if (!value) throw new Error(`source user book is missing ${name}`);
  return value;
}

function generationTemplate(row: GenerationRow): PresetReadyGenerationTemplate {
  if (!row.result) throw new Error(`ready generation has no result: ${row.section_id}:${row.segment}`);
  return {
    sectionId: row.section_id,
    segment: row.segment,
    result: row.result,
    modelConfigId: row.model_config_id,
    promptVersion: row.prompt_version,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
  };
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const sourceUserBookId = process.argv[2] ?? DEFAULT_SOURCE_USER_BOOK_ID;
  const outputPath = process.argv[3] ? resolve(process.argv[3]) : DEFAULT_OUTPUT_PATH;
  const sql = postgres(databaseUrl, { max: 1 });

  try {
    const [source] = await sql<SourceBookRow[]>`
      select
        ub.id,
        ub.shared_book_id,
        sb.title,
        sb.epub_sha256,
        bp.version as package_version,
        bp.manifest_version,
        bp.file_hashes,
        ub.current_interview_session_id,
        ub.current_book_reader_profile_version_id,
        ub.current_strategy_draft_version_id,
        ub.current_strategy_version_id,
        ub.current_trial_revision_id
      from user_books ub
      join shared_books sb on sb.id = ub.shared_book_id
      join book_packages bp on bp.id = sb.current_package_id
      where ub.id = ${sourceUserBookId}
        and ub.workflow_status = 'active_reading'
    `;
    if (!source) throw new Error(`active source user book not found: ${sourceUserBookId}`);

    const profileId = requiredPointer(
      source.current_book_reader_profile_version_id,
      'current_book_reader_profile_version_id',
    );
    const draftId = requiredPointer(
      source.current_strategy_draft_version_id,
      'current_strategy_draft_version_id',
    );
    const strategyId = requiredPointer(
      source.current_strategy_version_id,
      'current_strategy_version_id',
    );

    const [[profile], [draft], [strategy], formalGenerationRows] = await Promise.all([
      sql<Array<{ profile: PresetBookTemplate['profile'] }>>`
        select profile from book_reader_profile_versions where id = ${profileId}
      `,
      sql<
        Array<{
          reading_briefing: PresetBookTemplate['readingBriefing'];
          user_facing_summary: string;
          strategy: PresetBookTemplate['strategy'];
        }>
      >`
        select reading_briefing, user_facing_summary, strategy
        from strategy_draft_versions
        where id = ${draftId} and user_book_id = ${source.id} and status = 'confirmed'
      `,
      sql<Array<{ user_facing_summary: string; strategy: PresetBookTemplate['strategy'] }>>`
        select user_facing_summary, strategy
        from strategy_versions
        where id = ${strategyId} and user_book_id = ${source.id}
      `,
      sql<GenerationRow[]>`
        select trial_segment_id, section_id, segment, result, model_config_id, prompt_version,
               attempt_count, max_attempts
        from node_generations
        where user_book_id = ${source.id}
          and strategy_version_id = ${strategyId}
          and generation_scope = 'formal'
          and status = 'ready'
        order by section_id, segment
      `,
    ]);
    if (!profile || !draft || !strategy) {
      throw new Error('source user book has incomplete profile or strategy data');
    }
    if (draft.user_facing_summary !== strategy.user_facing_summary) {
      throw new Error('source draft and formal strategy summaries differ');
    }
    if (JSON.stringify(draft.strategy) !== JSON.stringify(strategy.strategy)) {
      throw new Error('source draft and formal strategy payloads differ');
    }
    if (formalGenerationRows.length === 0) {
      throw new Error('source user book has no ready formal generations');
    }

    let trial: PresetBookTemplate['trial'] = null;
    if (source.current_trial_revision_id) {
      const [revision] = await sql<Array<{ id: string }>>`
        select id
        from trial_revisions
        where id = ${source.current_trial_revision_id}
          and user_book_id = ${source.id}
          and strategy_draft_version_id = ${draftId}
          and status = 'adopted'
      `;
      if (!revision) throw new Error('current trial revision is not the adopted trial for the current draft');

      const segmentRows = await sql<
        Array<{
          id: string;
          ordinal: number;
          section_id: string;
          segment: number;
          start_block_index: number;
          start_offset: number;
          end_block_index: number;
          end_offset: number;
          selection_reason: string;
        }>
      >`
        select id, ordinal, section_id, segment, start_block_index, start_offset,
               end_block_index, end_offset, selection_reason
        from trial_segments
        where trial_revision_id = ${revision.id} and status = 'ready'
        order by ordinal
      `;
      const trialGenerationRows = await sql<GenerationRow[]>`
        select trial_segment_id, section_id, segment, result, model_config_id, prompt_version,
               attempt_count, max_attempts
        from node_generations
        where user_book_id = ${source.id}
          and strategy_draft_version_id = ${draftId}
          and generation_scope = 'trial'
          and status = 'ready'
      `;
      const generationBySegment = new Map(
        trialGenerationRows.map((row) => [requiredPointer(row.trial_segment_id, 'trial_segment_id'), row]),
      );
      if (segmentRows.length !== 3 || generationBySegment.size !== segmentRows.length) {
        throw new Error('adopted trial must contain three ready segments and generations');
      }
      trial = {
        segments: segmentRows.map((segment) => {
          const generation = generationBySegment.get(segment.id);
          if (!generation) throw new Error(`trial segment has no generation: ${segment.id}`);
          return {
            ordinal: segment.ordinal,
            sectionId: segment.section_id,
            segment: segment.segment,
            startBlockIndex: segment.start_block_index,
            startOffset: segment.start_offset,
            endBlockIndex: segment.end_block_index,
            endOffset: segment.end_offset,
            selectionReason: segment.selection_reason,
            generation: generationTemplate(generation),
          };
        }),
      };
    }

    const readingManifestSha256 = source.file_hashes['reading_manifest.json'];
    if (!readingManifestSha256) {
      throw new Error('source package has no reading_manifest.json hash');
    }

    const template: PresetBookTemplate = {
      schemaVersion: 1,
      key: 'zarathustra-v1',
      source: {
        userBookId: source.id,
        sharedBookId: source.shared_book_id,
      },
      book: {
        title: source.title,
        epubSha256: source.epub_sha256,
        packageVersion: source.package_version,
        manifestVersion: source.manifest_version,
        readingManifestSha256,
      },
      profile: profile.profile,
      readingBriefing: draft.reading_briefing,
      userFacingSummary: strategy.user_facing_summary,
      strategy: strategy.strategy,
      trial,
      formalGenerations: formalGenerationRows.map(generationTemplate),
    };

    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(template, null, 2)}\n`, 'utf8');
    console.log(
      `exported ${template.key} to ${resolve(dirname(outputPath), outputPath)} (${template.formalGenerations.length} formal generations)`,
    );
  } finally {
    await sql.end();
  }
}

await main();
