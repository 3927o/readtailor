import { ReaderContractError } from './errors';
import type {
  ReadingManifest,
  ReadingManifestBlock,
  ReadingManifestNode,
  ReadingManifestOutlineItem,
} from './manifest-schema';

export type ManifestIndex = {
  manifest: ReadingManifest;
  nodeByOrder: ReadonlyMap<number, ReadingManifestNode>;
  nodeByKey: ReadonlyMap<string, ReadingManifestNode>;
  outlineBySectionId: ReadonlyMap<string, ReadingManifestOutlineItem>;
};

export function manifestNodeKey(sectionId: string, segment: number): string {
  return `${sectionId}\0${segment}`;
}

export function createManifestIndex(manifest: ReadingManifest): ManifestIndex {
  return {
    manifest,
    nodeByOrder: new Map(manifest.nodes.map((node) => [node.order, node])),
    nodeByKey: new Map(manifest.nodes.map((node) => [manifestNodeKey(node.sectionId, node.segment), node])),
    outlineBySectionId: new Map(manifest.outline.map((item) => [item.sectionId, item])),
  };
}

export function findNodeByOrder(index: ManifestIndex, order: number): ReadingManifestNode | undefined {
  return index.nodeByOrder.get(order);
}

export function findNode(
  index: ManifestIndex,
  sectionId: string,
  segment: number,
): ReadingManifestNode | undefined {
  return index.nodeByKey.get(manifestNodeKey(sectionId, segment));
}

export function requireNode(
  index: ManifestIndex,
  sectionId: string,
  segment: number,
): ReadingManifestNode {
  const node = findNode(index, sectionId, segment);
  if (!node) throw new ReaderContractError('unknown_node', `unknown node ${sectionId}#${segment}`);
  return node;
}

export function findBlock(node: ReadingManifestNode, blockIndex: number): ReadingManifestBlock | undefined {
  const candidate = node.blocks[blockIndex - 1];
  return candidate?.blockIndex === blockIndex ? candidate : undefined;
}

export function requireBlock(node: ReadingManifestNode, blockIndex: number): ReadingManifestBlock {
  const block = findBlock(node, blockIndex);
  if (!block) throw new ReaderContractError('unknown_block', `unknown block ${blockIndex}`, 'blockIndex');
  return block;
}
