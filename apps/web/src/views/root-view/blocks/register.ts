import { registerBlock } from '../registry.ts'
import BoardBlock from './BoardBlock.vue'
import ChartBlock from './ChartBlock.vue'
import ColumnsBlock from './ColumnsBlock.vue'
import FieldsBlock from './FieldsBlock.vue'
import HeadingBlock from './HeadingBlock.vue'
import ListBlock from './ListBlock.vue'
import NumberBlock from './NumberBlock.vue'
import SectionBlock from './SectionBlock.vue'
import TableBlock from './TableBlock.vue'
import TextBlock from './TextBlock.vue'

// The block components this build has. `page` is the root, drawn by ViewRenderer itself. A data
// type without one would show its states only (DataBlockStates).
registerBlock('section', SectionBlock)
registerBlock('columns', ColumnsBlock)
registerBlock('heading', HeadingBlock)
registerBlock('text', TextBlock)
registerBlock('table', TableBlock)
registerBlock('list', ListBlock)
registerBlock('board', BoardBlock)
registerBlock('number', NumberBlock)
registerBlock('chart', ChartBlock)
registerBlock('fields', FieldsBlock)
