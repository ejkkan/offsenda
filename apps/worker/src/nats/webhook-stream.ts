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
        subjects: ["webhook.*.*"], // webhook.<provider>.<event_type>
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

    // Create consumer for webhook processor
    const consumerInfo = {
      durable_name: "webhook-processor",
      deliver_subject: "webhook.process",
      ack_policy: "explicit",
      ack_wait: 30 * 1e9, // 30 seconds
      max_deliver: 3, // Retry failed messages 3 times
      replay_policy: "instant",
      deliver_policy: "all",
      max_ack_pending: 1000, // Process up to 1000 webhooks in parallel
      rate_limit: 10000, // Max 10k webhooks per second
    };

    try {
      await jsm.consumers.info("webhooks", consumerInfo.durable_name);
      log.nats.info("webhook consumer already exists");
    } catch {
      await jsm.consumers.add("webhooks", consumerInfo);
      log.nats.info("webhook consumer created");
    }

  } catch (error) {
    log.nats.error({ error }, "failed to setup webhook stream");
    throw error;
  }
}