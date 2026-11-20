export { default as AppShell } from './AppShell.vue'
export { default as BaseButton } from './BaseButton.vue'
export { default as BaseInput } from './BaseInput.vue'
export { default as BaseSelect } from './BaseSelect.vue'
export { default as HubCard } from './HubCard.vue'
export { default as PaletteChip } from './PaletteChip.vue'
export { default as PixelAvatar } from './PixelAvatar.vue'
export { default as SizeMeter } from './SizeMeter.vue'
export { default as FormNotice, type NoticeTone } from './FormNotice.vue'
export { default as StateBlock, type BlockState } from './StateBlock.vue'
export { default as StatusDot } from './StatusDot.vue'
export { default as ThemeSwitch } from './ThemeSwitch.vue'
export { PALETTE_COLORS, paletteVar, type PaletteColor } from './palette.ts'
export { default as DataTable, type TableColumn, type TableMode } from './DataTable.vue'
export { type RowWindows } from './data-table.ts'
export { default as ItemPanel } from './ItemPanel.vue'
export { default as ActorChip } from './ActorChip.vue'
export { default as AuthLayout } from './AuthLayout.vue'
export { default as BrandMark } from './BrandMark.vue'
export { default as CheckboxField } from './CheckboxField.vue'
export { default as ChipList } from './ChipList.vue'
export { default as RelationChip } from './RelationChip.vue'
export { default as RichTextView } from './RichTextView.vue'
export { default as SignInForm } from './SignInForm.vue'
export { default as UrlLink } from './UrlLink.vue'
export { default as ValueState } from './ValueState.vue'
export type {
  Actor,
  RelationTarget,
  UnknownActor,
  SignInState,
  ValueStateName,
} from './value-types.ts'
// RichTextEditor is not exported here: it pulls in Tiptap. Import it from
// './RichTextEditor.vue' behind a dynamic import so it stays out of the main bundle.
export { chipsFor, type Chip, type ChipOption } from './chips.ts'
export { displayUrl } from './url.ts'
export { shortId } from './actor.ts'
export { isRichTextEmpty, normalizeRichText, richTextToPlain, type RichDoc } from './rich-text.ts'
// M2: settings.
export { default as AttributeTypePicker } from './AttributeTypePicker.vue'
export { default as BaseDialog } from './BaseDialog.vue'
export { default as ConfirmDialog } from './ConfirmDialog.vue'
export { default as OptionsEditor } from './OptionsEditor.vue'
export { default as PalettePicker } from './PalettePicker.vue'
export { default as RowActionsMenu, type RowAction } from './RowActionsMenu.vue'
export { default as SettingsLayout, type SettingsNavEntry } from './SettingsLayout.vue'
export { default as SettingsSection } from './SettingsSection.vue'
export { default as TabList, type Tab } from './TabList.vue'
export { default as ToggleSwitch } from './ToggleSwitch.vue'
export {
  ATTRIBUTE_TYPE_INFO,
  ATTRIBUTE_TYPE_ORDER,
  MAX_OPTIONS,
  confirmTextMatches,
  moveOption,
  newOptionId,
  optionErrors,
  type SettingsState,
} from './settings.ts'
