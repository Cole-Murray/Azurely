/**
 * Thrown when tool input fails a cross-field business rule that a flat zod
 * raw shape can't express on its own (e.g. "provide roleId or roleName, but
 * not neither"). Caught by runTool and logged as a validation_error - the
 * Graph call is never reached.
 */
export class ToolInputError extends Error {}

/** Thrown when a name/ID lookup (role, user) matches zero results. */
export class NotFoundError extends Error {}

/**
 * Thrown when a name-based lookup matches more than one result and the
 * caller needs to give a more specific query instead (e.g. two roles whose
 * display names both contain the search text).
 */
export class AmbiguousMatchError extends Error {}
