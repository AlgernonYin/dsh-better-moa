/**
 * The distributable deliberately contains no model recipes or provider accounts.
 * Presets are user-owned records in Config.presetOverrides; an empty install
 * opens the settings onboarding state. Existing local recipes are migrated by
 * the release procedure, not reconstructed as undeletable defaults.
 */
export const DEFAULT_PRESET_ID = ''
export const DEFAULT_PRESETS = Object.freeze({})
export const PRESET_ORDER = Object.freeze([])
export default DEFAULT_PRESETS
