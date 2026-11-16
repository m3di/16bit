import { z } from 'zod'
import { type AttributeType, BASE_SUMMARIES, EMPTY_OPERATORS } from './contract.ts'
import {
  RICH_TEXT_BLOCK_TYPES,
  RICH_TEXT_HEADING_LEVELS,
  RICH_TEXT_MAX_BYTES,
  richTextDocSchema,
  richTextPlainText,
  richTextToMarkdown,
  type RichTextDoc,
} from './rich-text-doc.ts'

export const richTextConfigSchema = z.strictObject({})
export type RichTextConfig = z.infer<typeof richTextConfigSchema>

const marks = {
  type: 'array',
  items: {
    oneOf: [
      {
        type: 'object',
        properties: { type: { enum: ['bold', 'italic', 'code'] } },
        required: ['type'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          type: { const: 'link' },
          attrs: {
            type: 'object',
            properties: { href: { type: 'string', pattern: '^(https?:|mailto:)' } },
            required: ['href'],
            additionalProperties: false,
          },
        },
        required: ['type', 'attrs'],
        additionalProperties: false,
      },
    ],
  },
}

const node = (type: string, properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: 'object',
  properties: { type: { const: type }, ...properties },
  required: ['type', ...required],
  additionalProperties: false,
})

const inline = { $ref: '#/$defs/inline' }
const paragraph = { $ref: '#/$defs/paragraph' }
const list = { oneOf: [{ $ref: '#/$defs/bulletList' }, { $ref: '#/$defs/orderedList' }] }
const listItems = { type: 'array', minItems: 1, items: { $ref: '#/$defs/listItem' } }

/** The JSON Schema for agents. The depth and size caps are stated, not encoded. */
const jsonSchema = {
  type: 'object',
  description: `A rich text document (ProseMirror JSON) with block nodes ${RICH_TEXT_BLOCK_TYPES.join(', ')}. Headings are level 3 or 4. At most ${String(RICH_TEXT_MAX_BYTES)} bytes of JSON.`,
  properties: {
    type: { const: 'doc' },
    content: { type: 'array', items: { $ref: '#/$defs/block' } },
  },
  required: ['type', 'content'],
  additionalProperties: false,
  $defs: {
    inline: {
      oneOf: [
        node('text', { text: { type: 'string', minLength: 1 }, marks }, ['text']),
        node('hardBreak'),
      ],
    },
    paragraph: node('paragraph', { content: { type: 'array', items: inline } }),
    bulletList: node('bulletList', { content: listItems }, ['content']),
    orderedList: node(
      'orderedList',
      {
        attrs: {
          type: 'object',
          properties: { start: { type: 'integer', minimum: 1 } },
          required: ['start'],
          additionalProperties: false,
        },
        content: listItems,
      },
      ['content'],
    ),
    listItem: node(
      'listItem',
      {
        content: {
          type: 'array',
          minItems: 1,
          prefixItems: [paragraph],
          items: { oneOf: [paragraph, list] },
        },
      },
      ['content'],
    ),
    block: {
      oneOf: [
        paragraph,
        node(
          'heading',
          {
            attrs: {
              type: 'object',
              properties: { level: { enum: [...RICH_TEXT_HEADING_LEVELS] } },
              required: ['level'],
              additionalProperties: false,
            },
            content: { type: 'array', items: inline },
          },
          ['attrs'],
        ),
        list,
        node('codeBlock', {
          content: {
            type: 'array',
            items: node('text', { text: { type: 'string', minLength: 1 } }, ['text']),
          },
        }),
      ],
    },
  },
}

export const richTextType: AttributeType<'rich_text', RichTextConfig, RichTextDoc> = {
  name: 'rich_text',
  configSchema: richTextConfigSchema,
  valueSchema: () => richTextDocSchema,
  readOnly: false,
  // A document with no visible text, such as one empty paragraph, is stored as `null`.
  isEmpty: (value) => richTextPlainText(value).trim() === '',
  // The plain text, one row, so `contains` searches the words without the markup.
  indexProjection: 'txt',
  project: (value) => [richTextPlainText(value)],
  filterOperators: ['contains', 'not_contains', ...EMPTY_OPERATORS],
  sortable: false,
  sortKey: (value) => richTextPlainText(value).toLowerCase(),
  groupKey: (value) => richTextPlainText(value),
  summaries: [...BASE_SUMMARIES],
  jsonSchema: () => jsonSchema,
  render: (value) => (value === null ? '' : richTextToMarkdown(value)),
}
