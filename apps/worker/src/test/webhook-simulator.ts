import { eq, and } from "drizzle-orm";
import { randomUUID } from "crypto";
import { z } from "zod";
import { recipients, batches } from "@batchsender/db";
import { db } from "../db.js";
import { log } from "../logger.js";
import { WebhookQueueProcessor, WebhookEventFactory } from "../webhooks/queue-processor.js";
import { NatsClient } from "../nats/client.js";

/**
 * Realistic Webhook Simulator
 *
 * Simulates real-world webhook patterns for load testing and integration testing.
 * Generates realistic event chains like:
 *   send → delivered (1-30s) → opened (mins-hours) → clicked (secs after open)
 */

// =============================================================================
// Types & Schemas
// =============================================================================

export interface SimulationConfig {
  /** Simulation profile preset */
  profile: "realistic" | "stress" | "instant";
  /** Duration to spread events over (seconds) */
  durationSeconds: number;
  /** Max webhooks per second */
  throughputPerSecond: number;
  /** Custom event rates (overrides profile defaults) */
  rates?: {
    deliveryRate?: number;      // % that get delivered (vs bounce)
    bounceRate?: number;        // % that bounce
    complaintRate?: number;     // % that complain
    openRate?: number;          // % of delivered that open
    clickRate?: number;         // % of opens that click
    multipleOpens?: number;     // avg additional opens per opener
  };
}

export interface SimulationState {
  id: string;
  batchId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: Date;
  completedAt?: Date;
  config: SimulationConfig;
  progress: {
    totalRecipients: number;
    eventsGenerated: number;
    eventsProcessed: number;
    eventsByType: Record<string, number>;
  };
  error?: string;
}

export const simulationConfigSchema = z.object({
  profile: z.enum(["realistic", "stress", "instant"]).default("realistic"),
  durationSeconds: z.number().min(1).max(3600).default(300),
  throughputPerSecond: z.number().min(1).max(10000).default(500),
  rates: z.object({
    deliveryRate: z.number().min(0).max(1).optional(),
    bounceRate: z.number().min(0).max(1).optional(),
    complaintRate: z.number().min(0).max(1).optional(),
    openRate: z.number().min(0).max(1).optional(),
    clickRate: z.number().min(0).max(1).optional(),
    multipleOpens: z.number().min(0).max(10).optional(),
  }).optional(),
});

// =============================================================================
// Profile Presets
// =============================================================================

type RatesConfig = {
  deliveryRate: number;
  bounceRate: number;
  complaintRate: number;
  openRate: number;
  clickRate: number;
  multipleOpens: number;
};

const PROFILES: { realistic: RatesConfig; stress: RatesConfig; instant: RatesConfig } = {
  realistic: {
    deliveryRate: 0.94,      // 94% delivered
    bounceRate: 0.05,        // 5% bounce
    complaintRate: 0.001,    // 0.1% complaint
    openRate: 0.25,          // 25% open rate
    clickRate: 0.15,         // 15% of opens click
    multipleOpens: 1.3,      // Some people open multiple times
  },
  stress: {
    deliveryRate: 0.99,      // Almost all deliver (max webhook load)
    bounceRate: 0.005,
    complaintRate: 0.0001,
    openRate: 0.6,           // High open rate for more events
    clickRate: 0.4,          // High click rate
    multipleOpens: 2.0,      // Multiple opens per person
  },
  instant: {
    deliveryRate: 0.90,
    bounceRate: 0.08,
    complaintRate: 0.01,
    openRate: 0.3,
    clickRate: 0.2,
    multipleOpens: 1.0,
  },
};

// Timing distributions (in milliseconds)
type TimingConfig = {
  delivery: { min: number; max: number };
  open: { min: number; max: number };
  click: { min: number; max: number };
  bounce: { min: number; max: number };
};

const TIMING: { realistic: TimingConfig; stress: TimingConfig; instant: TimingConfig } = {
  realistic: {
    delivery: { min: 1000, max: 30000 },      // 1-30 seconds
    open: { min: 60000, max: 3600000 },       // 1 min - 1 hour
    click: { min: 1000, max: 60000 },         // 1-60 seconds after open
    bounce: { min: 500, max: 5000 },          // 0.5-5 seconds
  },
  stress: {
    delivery: { min: 100, max: 1000 },        // 0.1-1 seconds
    open: { min: 500, max: 5000 },            // 0.5-5 seconds
    click: { min: 100, max: 1000 },           // 0.1-1 seconds
    bounce: { min: 100, max: 500 },
  },
  instant: {
    delivery: { min: 0, max: 100 },           // Near instant
    open: { min: 0, max: 100 },
    click: { min: 0, max: 100 },
    bounce: { min: 0, max: 100 },
  },
};

// =============================================================================
// Webhook Simulator Service
// =============================================================================

export class WebhookSimulator {
  private simulations = new Map<string, SimulationState>();
  private queueProcessor: WebhookQueueProcessor | null = null;
  private abortControllers = new Map<string, AbortController>();

  constructor(private natsClient: NatsClient) {}

  /**
   * Initialize the simulator (call after NATS is connected)
   */
  async initialize(): Promise<void> {
    this.queueProcessor = new WebhookQueueProcessor(this.natsClient);
    log.system.info("Webhook simulator initialized");
  }

  /**
   * Start a new simulation for a batch
   */
  async startSimulation(batchId: string, config: SimulationConfig): Promise<SimulationState> {
    if (!this.queueProcessor) {
      throw new Error("Simulator not initialized - call initialize() first");
    }

    // Check batch exists
    const batch = await db.query.batches.findFirst({
      where: eq(batches.id, batchId),
    });

    if (!batch) {
      throw new Error(`Batch not found: ${batchId}`);
    }

    // Get recipients with status 'sent'
    const sentRecipients = await db.query.recipients.findMany({
      where: and(
        eq(recipients.batchId, batchId),
        eq(recipients.status, "sent")
      ),
    });

    if (sentRecipients.length === 0) {
      throw new Error("No recipients with 'sent' status found");
    }

    // Create simulation state
    const simulationId = randomUUID();
    const abortController = new AbortController();

    const state: SimulationState = {
      id: simulationId,
      batchId,
      status: "running",
      startedAt: new Date(),
      config,
      progress: {
        totalRecipients: sentRecipients.length,
        eventsGenerated: 0,
        eventsProcessed: 0,
        eventsByType: {},
      },
    };

    this.simulations.set(simulationId, state);
    this.abortControllers.set(simulationId, abortController);

    // Start simulation in background
    this.runSimulation(simulationId, sentRecipients, config, abortController.signal)
      .catch(error => {
        const sim = this.simulations.get(simulationId);
        if (sim) {
          sim.status = "failed";
          sim.error = error.message;
          sim.completedAt = new Date();
        }
      });

    log.system.info({
      simulationId,
      batchId,
      recipients: sentRecipients.length,
      profile: config.profile,
      duration: config.durationSeconds,
    }, "Webhook simulation started");

    return state;
  }

  /**
   * Get simulation status
   */
  getSimulation(simulationId: string): SimulationState | undefined {
    return this.simulations.get(simulationId);
  }

  /**
   * List all simulations
   */
  listSimulations(): SimulationState[] {
    return Array.from(this.simulations.values());
  }

  /**
   * Cancel a running simulation
   */
  cancelSimulation(simulationId: string): boolean {
    const controller = this.abortControllers.get(simulationId);
    if (controller) {
      controller.abort();
      const sim = this.simulations.get(simulationId);
      if (sim) {
        sim.status = "cancelled";
        sim.completedAt = new Date();
      }
      return true;
    }
    return false;
  }

  /**
   * Run the simulation (background)
   */
  private async runSimulation(
    simulationId: string,
    recipients: Array<{ id: string; email: string; batchId: string; providerMessageId: string | null }>,
    config: SimulationConfig,
    signal: AbortSignal
  ): Promise<void> {
    const state = this.simulations.get(simulationId)!;
    const profileRates = PROFILES[config.profile];
    const rates: RatesConfig = {
      deliveryRate: config.rates?.deliveryRate ?? profileRates.deliveryRate,
      bounceRate: config.rates?.bounceRate ?? profileRates.bounceRate,
      complaintRate: config.rates?.complaintRate ?? profileRates.complaintRate,
      openRate: config.rates?.openRate ?? profileRates.openRate,
      clickRate: config.rates?.clickRate ?? profileRates.clickRate,
      multipleOpens: config.rates?.multipleOpens ?? profileRates.multipleOpens,
    };
    const timing = TIMING[config.profile];

    // Generate all events upfront with their scheduled times
    const events: Array<{
      recipientId: string;
      email: string;
      batchId: string;
      providerMessageId: string;
      eventType: string;
      scheduledAt: number; // ms from start
    }> = [];

    const startTime = Date.now();
    const durationMs = config.durationSeconds * 1000;

    for (const recipient of recipients) {
      if (signal.aborted) break;

      const providerMessageId = recipient.providerMessageId || `sim-${randomUUID()}`;
      const recipientStartOffset = Math.random() * durationMs * 0.3; // Spread initial events over first 30% of duration

      // Determine outcome for this recipient
      const rand = Math.random();

      if (rand < rates.bounceRate) {
        // Bounce
        events.push({
          recipientId: recipient.id,
          email: recipient.email,
          batchId: recipient.batchId,
          providerMessageId,
          eventType: "bounced",
          scheduledAt: recipientStartOffset + randomBetween(timing.bounce.min, timing.bounce.max),
        });
      } else if (rand < rates.bounceRate + rates.complaintRate) {
        // Complaint (usually after delivery)
        events.push({
          recipientId: recipient.id,
          email: recipient.email,
          batchId: recipient.batchId,
          providerMessageId,
          eventType: "delivered",
          scheduledAt: recipientStartOffset + randomBetween(timing.delivery.min, timing.delivery.max),
        });
        events.push({
          recipientId: recipient.id,
          email: recipient.email,
          batchId: recipient.batchId,
          providerMessageId,
          eventType: "complained",
          scheduledAt: recipientStartOffset + randomBetween(timing.delivery.max, timing.open.min),
        });
      } else if (rand < rates.bounceRate + rates.complaintRate + rates.deliveryRate) {
        // Delivered
        const deliveryTime = recipientStartOffset + randomBetween(timing.delivery.min, timing.delivery.max);
        events.push({
          recipientId: recipient.id,
          email: recipient.email,
          batchId: recipient.batchId,
          providerMessageId,
          eventType: "delivered",
          scheduledAt: deliveryTime,
        });

        // Maybe opens
        if (Math.random() < rates.openRate) {
          const openTime = deliveryTime + randomBetween(timing.open.min, timing.open.max);

          // First open
          events.push({
            recipientId: recipient.id,
            email: recipient.email,
            batchId: recipient.batchId,
            providerMessageId,
            eventType: "opened",
            scheduledAt: Math.min(openTime, durationMs),
          });

          // Multiple opens
          const additionalOpens = Math.floor(Math.random() * rates.multipleOpens);
          for (let i = 0; i < additionalOpens; i++) {
            events.push({
              recipientId: recipient.id,
              email: recipient.email,
              batchId: recipient.batchId,
              providerMessageId,
              eventType: "opened",
              scheduledAt: Math.min(openTime + randomBetween(1000, timing.open.max / 2), durationMs),
            });
          }

          // Maybe clicks
          if (Math.random() < rates.clickRate) {
            events.push({
              recipientId: recipient.id,
              email: recipient.email,
              batchId: recipient.batchId,
              providerMessageId,
              eventType: "clicked",
              scheduledAt: Math.min(openTime + randomBetween(timing.click.min, timing.click.max), durationMs),
            });
          }
        }
      }
      // else: remains as 'sent' (soft fail / delayed)
    }

    // Sort events by scheduled time
    events.sort((a, b) => a.scheduledAt - b.scheduledAt);

    state.progress.eventsGenerated = events.length;
    log.system.info({
      simulationId,
      eventsGenerated: events.length,
      recipients: recipients.length,
      avgEventsPerRecipient: (events.length / recipients.length).toFixed(2),
    }, "Events generated, starting delivery");

    // Process events with rate limiting
    const minIntervalMs = 1000 / config.throughputPerSecond;
    let lastProcessTime = startTime;

    for (const event of events) {
      if (signal.aborted) break;

      // Wait until scheduled time
      const now = Date.now();
      const targetTime = startTime + event.scheduledAt;

      if (targetTime > now) {
        await sleep(targetTime - now);
      }

      // Rate limiting
      const timeSinceLastProcess = Date.now() - lastProcessTime;
      if (timeSinceLastProcess < minIntervalMs) {
        await sleep(minIntervalMs - timeSinceLastProcess);
      }

      // Send webhook event
      try {
        await this.sendWebhookEvent(event);
        state.progress.eventsProcessed++;
        state.progress.eventsByType[event.eventType] =
          (state.progress.eventsByType[event.eventType] || 0) + 1;
        lastProcessTime = Date.now();
      } catch (error) {
        log.webhook.error({ event, error }, "Failed to send simulated webhook");
      }

      // Log progress periodically
      if (state.progress.eventsProcessed % 1000 === 0) {
        log.system.info({
          simulationId,
          progress: `${state.progress.eventsProcessed}/${state.progress.eventsGenerated}`,
          elapsed: `${((Date.now() - startTime) / 1000).toFixed(1)}s`,
        }, "Simulation progress");
      }
    }

    // Mark complete
    state.status = signal.aborted ? "cancelled" : "completed";
    state.completedAt = new Date();

    log.system.info({
      simulationId,
      duration: `${((Date.now() - startTime) / 1000).toFixed(1)}s`,
      eventsProcessed: state.progress.eventsProcessed,
      eventsByType: state.progress.eventsByType,
    }, "Webhook simulation completed");
  }

  /**
   * Send a single webhook event through the queue
   */
  private async sendWebhookEvent(event: {
    recipientId: string;
    email: string;
    batchId: string;
    providerMessageId: string;
    eventType: string;
  }): Promise<void> {
    // Map to Resend event format and enqueue
    const resendType = mapToResendType(event.eventType);

    const webhookEvent = WebhookEventFactory.fromResend({
      type: resendType,
      created_at: new Date().toISOString(),
      data: {
        email_id: event.providerMessageId,
        from: "simulator@test.local",
        to: [event.email],
        subject: "Simulated Email",
      },
    });

    // Pre-populate recipient info (skip lookup)
    webhookEvent.recipientId = event.recipientId;
    webhookEvent.batchId = event.batchId;

    await this.queueProcessor!.enqueueWebhook(webhookEvent);
  }
}

// =============================================================================
// Helpers
// =============================================================================

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function mapToResendType(eventType: string): "email.delivered" | "email.bounced" | "email.complained" | "email.opened" | "email.clicked" {
  switch (eventType) {
    case "delivered": return "email.delivered";
    case "bounced": return "email.bounced";
    case "complained": return "email.complained";
    case "opened": return "email.opened";
    case "clicked": return "email.clicked";
    default: return "email.delivered";
  }
}

// =============================================================================
// Singleton instance
// =============================================================================

let simulatorInstance: WebhookSimulator | null = null;

export function getWebhookSimulator(): WebhookSimulator | null {
  return simulatorInstance;
}

export function initializeWebhookSimulator(natsClient: NatsClient): WebhookSimulator {
  simulatorInstance = new WebhookSimulator(natsClient);
  return simulatorInstance;
}
