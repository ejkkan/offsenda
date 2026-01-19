import { JetStreamManager } from "nats";
import { log } from "../logger.js";

/**
 * Create NATS JetStream configuration for webhook processing
 */
export async function setupWebhookStream(jsm: JetStreamManager): Promise<void> {
  try {
    // Check if stream exists
    try {
      await jsm.streams.info("webhooks");
      log.nats.info("webhooks stream already exists");
    } catch {
      // Create webhook stream
      await jsm.streams.add({
        name: "webhooks",
        subjects: ["webhook.>"], // webhook.<provider>.<event_type> (supports nested types like sms.delivered)
        retention: "workqueue", // Delete after acknowledgment
        storage: "file",
        replicas: 1,
        max_msgs_per_subject: 10_000, // Prevent runaway growth
        max_age: 24 * 60 * 60 * 1e9, // 24 hours
        max_bytes: 1024 * 1024 * 1024, // 1GB
        discard: "old", // Discard old messages when limits reached
        duplicate_window: 60 * 1e9, // 60 second dedup window
      });

      log.nats.info("webhooks stream created");
    }

    // Note: Consumer is created by NatsWebhookWorker when it starts
    // This avoids conflicts between push/pull consumer configurations

  } catch (error) {
    log.nats.error({ error }, "failed to setup webhook stream");
    throw error;
  }
}