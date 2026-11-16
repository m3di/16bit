import { booleanType } from './boolean.ts'
import type { AttributeTypeName } from './contract.ts'
import { dateType } from './date.ts'
import { numberType } from './number.ts'
import { selectType } from './select.ts'
import { textType } from './text.ts'

export * from './contract.ts'
export * from './boolean.ts'
export * from './date.ts'
export * from './number.ts'
export * from './select.ts'
export * from './text.ts'

export const attributeTypes = {
  text: textType,
  number: numberType,
  boolean: booleanType,
  date: dateType,
  select: selectType,
} as const satisfies { [N in AttributeTypeName]: { name: N } }
