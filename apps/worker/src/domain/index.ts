/**
 * Domain layer - pure business logic.
 *
 * This module contains pure functions and classes that:
 * - Have no side effects
 * - Don't depend on external services (DB, Redis, NATS, etc.)
 * - Are fully unit-testable
 * - Can be tested in isolation without mocking
 */

// Utility functions
export * from "./utils/index.js";

// Payload builders
export * from "./payload-builders/index.js";

// Circuit breaker logic
export * from "./circuit-breaker/index.js";

// Buffer management
export * from "./buffer/index.js";

// Idempotency checking
export * from "./idempotency/index.js";
