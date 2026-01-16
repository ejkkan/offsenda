import type { Module } from "./types.js";
import { EmailModule } from "./email-module.js";
import { WebhookModule } from "./webhook-module.js";

/**
 * Module registry - maps module types to implementations
 */
const modules: Record<string, Module> = {
  email: new EmailModule(),
  webhook: new WebhookModule(),
};

/**
 * Get a module by type
 * @throws Error if module type is unknown
 */
export function getModule(type: string): Module {
  const module = modules[type];
  if (!module) {
    throw new Error(`Unknown module type: ${type}`);
  }
  return module;
}

/**
 * Check if a module type exists
 */
export function hasModule(type: string): boolean {
  return type in modules;
}

/**
 * List all available module types
 */
export function listModules(): string[] {
  return Object.keys(modules);
}

/**
 * Get all modules
 */
export function getAllModules(): Record<string, Module> {
  return { ...modules };
}

// Re-export types
export * from "./types.js";
