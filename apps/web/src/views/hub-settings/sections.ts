// The sections of hub settings. Kept apart from schema.ts so the router can import them without
// pulling in core and the settings components.

/** The sections of hub settings, in nav order. */
export type HubSettingsSection = 'general' | 'access' | 'folders' | 'attributes' | 'keys' | 'danger'

export const SECTION_ROUTES: Record<HubSettingsSection, string> = {
  general: 'hub-settings-general',
  access: 'hub-settings-access',
  folders: 'hub-settings-folders',
  attributes: 'hub-settings-attributes',
  keys: 'hub-settings-keys',
  danger: 'hub-settings-danger',
}

export const SECTION_LABELS: Record<HubSettingsSection, string> = {
  general: 'General',
  access: 'Access',
  folders: 'Folders',
  attributes: 'Attributes',
  keys: 'Agent keys',
  danger: 'Danger zone',
}

/** The path segment after `/settings/` for each section. */
export const SECTION_PATHS: Record<HubSettingsSection, string> = {
  general: 'general',
  access: 'access',
  folders: 'folders',
  attributes: 'attributes',
  keys: 'agent-keys',
  danger: 'danger',
}
