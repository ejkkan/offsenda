import { NatsClient } from "./client.js";
import { log } from "../logger.js";

export interface NatsMetrics {
  pending_messages: number;
  storage_bytes: number;
  consumer_count: number;
  oldest_message_age: number;
  stream_subjects: number;
  consumer_pending: Record<string, number>;
}

export async function collectNatsMetrics(natsClient: NatsClient): Promise<NatsMetrics> {
  try {
    const jsm = natsClient.getJetStreamManager();
    const stream = await jsm.streams.info('email-system');

    // Calculate oldest message age
    let oldestMessageAge = 0;
    if (stream.state.first_ts && stream.state.messages > 0) {
      // first_ts is a string in RFC3339 format
      oldestMessageAge = Date.now() - new Date(stream.state.first_ts).getTime();
    }

    // Collect pending messages per consumer for autoscaling
    const consumerPending: Record<string, number> = {};
    try {
      const consumers = await jsm.consumers.list('email-system').next();
      for (const consumer of consumers) {
        // Get detailed consumer info to get num_pending
        const consumerInfo = await jsm.consumers.info('email-system', consumer.name);
        consumerPending[consumer.name] = consumerInfo.num_pending || 0;
      }
    } catch (error) {
      log.queue.error({ error }, "Failed to collect consumer pending metrics");
    }

    // Log to Pino with structured data
    log.queue.info({
      component: 'nats',
      stream: 'email-system',
      messages: stream.state.messages,
      bytes: stream.state.bytes,
      consumers: stream.state.consumer_count,
      subjects: stream.state.num_subjects,
      consumer_pending: consumerPending
    }, 'queue metrics');

    // Export metrics
    return {
      pending_messages: stream.state.messages,
      storage_bytes: stream.state.bytes,
      consumer_count: stream.state.consumer_count,
      oldest_message_age: oldestMessageAge,
      stream_subjects: stream.state.num_subjects ?? 0,
      consumer_pending: consumerPending,
    };
  } catch (error) {
    log.queue.error({ error }, "Failed to collect NATS metrics");
    return {
      pending_messages: 0,
      storage_bytes: 0,
      consumer_count: 0,
      oldest_message_age: 0,
      stream_subjects: 0,
      consumer_pending: {},
    };
  }
}

// Health check endpoint data
export async function getNatsHealth(natsClient: NatsClient): Promise<{
  connected: boolean;
  stream_exists: boolean;
  consumers: string[];
}> {
  try {
    const connected = await natsClient.healthCheck();
    if (!connected) {
      return { connected: false, stream_exists: false, consumers: [] };
    }

    const jsm = natsClient.getJetStreamManager();
    const streamInfo = await jsm.streams.info('email-system');

    const consumerNames: string[] = [];
    const consumers = await jsm.consumers.list('email-system').next();
    for (const consumer of consumers) {
      consumerNames.push(consumer.name);
    }

    return {
      connected: true,
      stream_exists: true,
      consumers: consumerNames,
    };
  } catch (error) {
    log.queue.error({ error }, "NATS health check failed");
    return {
      connected: false,
      stream_exists: false,
      consumers: [],
    };
  }
}