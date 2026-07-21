import type { ReadingManifest } from '@readtailor/reader-core';

export function createReadingManifestFixture(
  sections: Array<{ sectionId: string; text: string; title?: string }>,
): ReadingManifest {
  let absoluteStart = 0;
  const nodes = sections.map((section, index) => {
    const nodeAbsoluteStart = absoluteStart;
    absoluteStart += section.text.length;
    return {
      sectionId: section.sectionId,
      segment: 1,
      order: index + 1,
      region: 'bodymatter',
      dataType: 'section',
      title: section.title ?? `第 ${index + 1} 节`,
      parentSectionId: null,
      characterCount: section.text.length,
      blockCount: 1,
      tailoringEligible: true,
      exclusionReason: null,
      nodeAbsoluteStart,
      blocks: [{
        blockIndex: 1,
        kind: 'p',
        blockAbsoluteStart: nodeAbsoluteStart,
        blockUtf16Length: section.text.length,
      }],
    };
  });
  return {
    version: 'reading-nodes-1.0',
    tailoringEligibilityVersion: 'tailoring-eligibility-1.0',
    document: { title: '测试书', language: 'zh-CN' },
    outline: nodes.map((node) => ({
      sectionId: node.sectionId,
      dataType: node.dataType,
      title: node.title,
      parentSectionId: null,
      firstNodeOrder: node.order,
    })),
    bookTotalCharacters: absoluteStart,
    nodeCount: nodes.length,
    nodes,
    warnings: [],
    validation: { isValid: true, errorCount: 0, warningCount: 0 },
  };
}
