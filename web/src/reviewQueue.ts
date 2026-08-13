import { itemState, type QueueItem } from './api';

export function firstOpenItem(items: QueueItem[]): QueueItem | null {
  return items.find((item) => itemState(item) === 'open') ?? null;
}

/** Items that require a reviewer decision or follow-up, in a stable order. */
export function attentionItems(items: QueueItem[], limit = 4): QueueItem[] {
  return [...items]
    .filter(
      (item) =>
        itemState(item) === 'open' || item.decision?.conclusion === 'requires-procedures',
    )
    .sort((a, b) => {
      const priority = attentionPriority(a) - attentionPriority(b);
      if (priority !== 0) return priority;
      if (b.entryCount !== a.entryCount) return b.entryCount - a.entryCount;
      return a.groupId.localeCompare(b.groupId);
    })
    .slice(0, limit);
}

function attentionPriority(item: QueueItem): number {
  if (item.decision?.conclusion === 'requires-procedures') return 0;
  if (item.kind === 'deviation') return 1;
  if (item.kind === 'individual') return 2;
  return 3;
}
