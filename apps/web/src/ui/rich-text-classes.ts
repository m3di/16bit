/**
 * Classes for each node and mark of the closed set. The viewer and the editor share them, so
 * a document looks the same while it is edited. Long text uses the 1.6 line height.
 */
export const RICH_CLASSES = {
  root: 'flex flex-col gap-2.5 text-body leading-long text-ink2 break-words',
  paragraph: 'm-0',
  // h3 is 14px, h4 is 13px, both medium. One class so the editor's heading node can use it.
  heading: 'm-0 mt-1 font-medium text-ink [&:is(h3)]:text-name [&:is(h4)]:text-body',
  codeBlock:
    'm-0 overflow-x-auto rounded-card border border-line bg-surface px-3 py-2 font-mono text-secondary text-ink',
  bulletList: 'm-0 list-disc pl-[18px]',
  orderedList: 'm-0 list-decimal pl-[18px]',
  listItem: 'pl-0.5',
  // Two weights only: "bold" in a document is the medium weight.
  bold: 'font-medium text-ink',
  italic: 'italic',
  code: 'rounded-chip bg-selected px-1 font-mono text-secondary text-ink',
  link: 'border-b border-line2 text-ink no-underline hover:border-line3',
} as const
