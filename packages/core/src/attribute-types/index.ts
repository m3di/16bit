import { actorType } from './actor.ts'
import { autoIdType } from './auto-id.ts'
import { booleanType } from './boolean.ts'
import type { AttributeTypeName } from './contract.ts'
import { dateType } from './date.ts'
import { multiSelectType } from './multi-select.ts'
import { numberType } from './number.ts'
import { relationType } from './relation.ts'
import { richTextType } from './rich-text.ts'
import { selectType } from './select.ts'
import { textType } from './text.ts'
import { urlType } from './url.ts'

export * from './contract.ts'
export * from './actor.ts'
export * from './auto-id.ts'
export * from './boolean.ts'
export * from './date.ts'
export * from './multi-select.ts'
export * from './number.ts'
export * from './relation.ts'
export * from './rich-text.ts'
export * from './rich-text-doc.ts'
export * from './select.ts'
export * from './text.ts'
export * from './url.ts'

export const attributeTypes = {
  text: textType,
  number: numberType,
  boolean: booleanType,
  date: dateType,
  select: selectType,
  multi_select: multiSelectType,
  url: urlType,
  actor: actorType,
  auto_id: autoIdType,
  rich_text: richTextType,
  relation: relationType,
} as const satisfies { [N in AttributeTypeName]: { name: N } }
