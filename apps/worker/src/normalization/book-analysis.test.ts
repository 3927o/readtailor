import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createBookAnalysisToolbox } from './book-analysis';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function packageFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'readtailor-analysis-'));
  directories.push(directory);
  await writeFile(
    join(directory, 'book.normalized.html'),
    '<!doctype html><html lang="zh-CN"><head><title>测试书</title></head><body>' +
      '<main id="book" data-type="book"><section id="body" data-role="bodymatter">' +
      '<section id="ch-1" data-type="chapter"><h1>第一章</h1><p>苹果与思想反复出现。</p>' +
      '</section></section></main></body></html>',
  );
  await writeFile(
    join(directory, 'reading_manifest.json'),
    JSON.stringify({
      version: 'reading-nodes-1.0',
      tailoringEligibilityVersion: 'tailoring-eligibility-1.0',
      document: { title: '测试书', language: 'zh-CN' },
      outline: [{
        sectionId: 'ch-1',
        dataType: 'chapter',
        title: '第一章',
        parentSectionId: null,
        firstNodeOrder: 1,
      }],
      bookTotalCharacters: 10,
      nodeCount: 1,
      nodes: [
        {
          sectionId: 'ch-1',
          segment: 1,
          order: 1,
          region: 'bodymatter',
          dataType: 'chapter',
          title: '第一章',
          parentSectionId: null,
          characterCount: 10,
          blockCount: 1,
          tailoringEligible: true,
          exclusionReason: null,
          nodeAbsoluteStart: 0,
          blocks: [{
            blockIndex: 1,
            kind: 'p',
            blockAbsoluteStart: 0,
            blockUtf16Length: 10,
          }],
        },
      ],
      warnings: [],
      validation: { isValid: true, errorCount: 0, warningCount: 0 },
    }),
  );
  await writeFile(
    join(directory, 'metadata.json'),
    JSON.stringify({
      title: '测试书',
      authors: ['作者'],
      language: 'zh-CN',
      cover_path: null,
      identifiers: {},
      publisher: null,
      published_date: null,
      source_filename: 'test.epub',
    }),
  );
  return directory;
}

describe('book analysis toolbox', () => {
  it('reads stable nodes and validates eligible trial candidates', async () => {
    const packageDirectory = await packageFixture();
    const { toolbox } = await createBookAnalysisToolbox({
      repoRoot: REPO_ROOT,
      packageDirectory,
    });

    const node = JSON.parse(
      (await toolbox.readBookNode({ sectionId: 'ch-1', segment: 1 })).text,
    ) as { text: string };
    expect(node.text).toContain('苹果与思想');
    const search = JSON.parse((await toolbox.searchBook({ query: '思想' })).text) as {
      matches: unknown[];
    };
    expect(search.matches).toHaveLength(1);

    await expect(
      toolbox.saveBookProfile({
        version: 'book-profile-1.0',
        summary: '这是一本用于测试共享书籍分析能力的简短书籍。',
        structure: '全书当前只有一章，因此结构直接且适合一次连续阅读。',
        core_questions: ['这本书希望讨论什么问题？'],
        themes: ['测试'],
        reading_barriers: ['篇幅很短，语境信息有限，需要结合完整版本理解。'],
        reading_advice: ['先连续阅读全章，再回看反复出现的关键词。'],
        trial_candidates: [
          {
            section_id: 'ch-1',
            segment: 1,
            features: ['entry'],
            reason: '唯一可裁读节点，能够代表全书当前内容。',
          },
        ],
      }),
    ).resolves.toBeUndefined();
  });
});
