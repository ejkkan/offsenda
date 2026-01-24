/**
 * Email Provider Types and Classes
 *
 * Note: The EmailModule now handles provider selection internally based on
 * the `service` field in the config. These exports are kept for backwards
 * compatibility and potential future use cases.
 */

export * from "./types.js";
export { ResendProvider } from "./resend-provider.js";
export { SESProvider } from "./ses-provider.js";
