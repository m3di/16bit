import { registerBlock } from '../registry.ts'
import ColumnsBlock from './ColumnsBlock.vue'
import HeadingBlock from './HeadingBlock.vue'
import SectionBlock from './SectionBlock.vue'
import TextBlock from './TextBlock.vue'

// The block components this build has. `page` is the root, drawn by ViewRenderer itself.
// Data types without one show their states only (DataBlockStates).
registerBlock('section', SectionBlock)
registerBlock('columns', ColumnsBlock)
registerBlock('heading', HeadingBlock)
registerBlock('text', TextBlock)
