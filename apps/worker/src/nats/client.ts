import {
  connect,
  NatsConnection,
  JetStreamClient,
  JetStreamManager,
  RetentionPolicy,
  StorageType,
  DiscardPolicy,
  StringCodec,
  AckPolicy,
  DeliverPolicy,
  ReplayPolicy,
  type ConnectionOptions,
  type TlsOptions,
} from "nats";
import { config } from "../config.js";
import { log } from "../logger.js";
import { readFileSync } from "node:fs";
import { calculateBackoff } from "../domain/utils/backoff.js";

export class NatsClient {
  private nc: NatsConnection | null = null;
  private js: JetStreamClient | null = null;
  private jsm: JetStreamManager | null = null;
  private sc = StringCodec();
  private isClosing = false;

  async connect(): Promise<void> {
    const servers = config.NATS_CLUSTER?.split(",") || ["nats://localhost:4222"];
    const maxRetries = 10;

    // Build connection options
    const connectionOptions: ConnectionOptions = {
      servers,
      name: `worker-${config.WORKER_ID}`,
      reconnect: true,
      maxReconnectAttempts: -1,
      reconnectTimeWait: 2000,
      pingInterval: 30000,
      maxPingOut: 3,
    };

    // Configure TLS if enabled
    if (config.NATS_TLS_ENABLED) {
      log.system.info({}, "NATS TLS enabled");

      const tlsOptions: TlsOptions = {};

      // Load CA certificate if provided
      if (config.NATS_TLS_CA_FILE) {
        tlsOptions.ca = readFileSync(config.NATS_TLS_CA_FILE, "utf-8");
        log.system.debug({ caFile: config.NATS_TLS_CA_FILE }, "Loaded NATS CA certificate");
      }

      // Load client certificate if provided (for mutual TLS)
      if (config.NATS_TLS_CERT_FILE && config.NATS_TLS_KEY_FILE) {
        tlsOptions.cert = readFileSync(config.NATS_TLS_CERT_FILE, "utf-8");
        tlsOptions.key = readFileSync(config.NATS_TLS_KEY_FILE, "utf-8");
        log.system.debug({}, "Loaded NATS client certificate for mutual TLS");
      }

      connectionOptions.tls = tlsOptions;
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        log.system.info({ servers, attempt, maxRetries, tls: config.NATS_TLS_ENABLED }, "Connecting to NATS cluster");

        this.nc = await connect(connectionOptions);

        this.js = this.nc.jetstream();
        this.jsm = await this.nc.jetstreamManager();

        // Set up event handlers
        this.nc.closed().then(() => {
          if (!this.isClosing) {
            // Unexpected closure - trigger graceful shutdown instead of immediate exit
            log.system.error({}, "NATS connection closed unexpectedly, initiating graceful shutdown");
            process.emit('SIGTERM');
          } else {
            log.system.info({}, "NATS connection closed (expected during shutdown)");
          }
        });

        (async () => {
          for await (const status of this.nc!.status()) {
            log.system.info({ status: status.type, data: status.data }, "NATS status update");
          }
        })();

        // Create stream if it doesn't exist
        await this.ensureStream();
        await this.ensureWebhookStream();

        log.system.info("Successfully connected to NATS and initialized JetStream");
        return; // Success - exit retry loop
      } catch (error) {
        const isLastAttempt = attempt === maxRetries;

        if (isLastAttempt) {
          log.system.error({ error, attempt }, "Failed to connect to NATS after all retries");
          throw error;
        }

        // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s (capped at 32s)
        const delay = calculateBackoff(attempt - 1, { baseDelayMs: 1000, maxDelayMs: 32000 });
        log.system.warn({ error, attempt, maxRetries, retryInMs: delay }, "NATS connection failed, retrying");

        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  private async ensureStream(): Promise<void> {
    try {
      // Check if stream exists
      await this.jsm!.streams.info("email-system");
      log.system.info("Stream 'email-system' already exists");
    } catch (error) {
      // Stream doesn't exist, create it
      log.system.info("Creating stream 'email-system'");

      try {
        await this.jsm!.streams.add({
          name: "email-system",
          subjects: ["sys.batch.*", "email.user.*.send", "email.priority.*"],
          retention: RetentionPolicy.Workqueue,
          storage: StorageType.File,
          num_replicas: config.NATS_REPLICAS,
          max_age: 2 * 60 * 60 * 1e9, // 2 hours in nanoseconds
          discard: DiscardPolicy.Old,
          max_msgs_per_subject: 50000,
          duplicate_window: 2 * 60 * 1e9, // 2 minutes deduplication window
          deny_delete: true, // Prevent accidental stream deletion
          deny_purge: true, // Prevent accidental purge
        });

        log.system.info("Stream 'email-system' created successfully");
      } catch (createError: any) {
        // Handle race condition: another worker may have created it
        if (createError.message?.includes("stream name already in use")) {
          log.system.info("Stream 'email-system' was created by another worker");
        } else {
          throw createError;
        }
      }
    }

    // Create default consumers
    await this.ensureConsumer("batch-processor", "sys.batch.>");
    await this.ensureConsumer("priority-processor", "email.priority.>");
  }

  private async ensureWebhookStream(): Promise<void> {
    try {
      // Check if stream exists
      await this.jsm!.streams.info("webhooks");
      log.system.info("Stream 'webhooks' already exists");
    } catch (error) {
      // Stream doesn't exist, create it
      log.system.info("Creating stream 'webhooks'");

      try {
        await this.jsm!.streams.add({
          name: "webhooks",
          subjects: ["webhook.>"], // webhook.<provider>.<event_type> (supports nested types like sms.delivered)
          retention: RetentionPolicy.Workqueue,
          storage: StorageType.File,
          num_replicas: config.NATS_REPLICAS,
          max_age: 24 * 60 * 60 * 1e9, // 24 hours
          max_bytes: 1024 * 1024 * 1024, // 1GB
          discard: DiscardPolicy.Old,
          max_msgs_per_subject: 10000,
          duplicate_window: 60 * 1e9, // 60 seconds deduplication window
          deny_delete: true, // Prevent accidental stream deletion
          deny_purge: true, // Prevent accidental purge
        });

        log.system.info("Stream 'webhooks' created successfully");
      } catch (createError: any) {
        // Handle race condition: another worker may have created it
        if (createError.message?.includes("stream name already in use")) {
          log.system.info("Stream 'webhooks' was created by another worker");
        } else {
          throw createError;
        }
      }
    }
  }

  private async ensureConsumer(name: string, filterSubject: string): Promise<void> {
    try {
      await this.jsm!.consumers.info("email-system", name);
      log.system.debug({ consumer: name }, "Consumer already exists");
    } catch (error) {
      // Consumer doesn't exist, create it
      log.system.info({ consumer: name }, "Creating consumer");

      try {
        await this.jsm!.consumers.add("email-system", {
          name,
          durable_name: name,
          filter_subject: filterSubject,
          ack_policy: AckPolicy.Explicit,
          ack_wait: name === "batch-processor" ? 5 * 60 * 1e9 : 30 * 1e9, // 5 min for batch, 30s for others
          max_deliver: name === "batch-processor" ? 3 : 5,
          max_ack_pending: name === "batch-processor" ? 50 : 200, // Increased from 10 to match concurrent batches
          deliver_policy: DeliverPolicy.All,
          replay_policy: ReplayPolicy.Instant,
        });

        log.system.info({ consumer: name }, "Consumer created successfully");
      } catch (createError: any) {
        // Handle race condition: another worker may have created it
        if (createError.message?.includes("consumer name already in use")) {
          log.system.info({ consumer: name }, "Consumer was created by another worker");
        } else {
          throw createError;
        }
      }
    }
  }

  async createUserConsumer(userId: string): Promise<void> {
    const consumerName = `user-${userId}`;

    try {
      await this.jsm!.consumers.info("email-system", consumerName);
      log.queue.debug({ userId }, "User consumer already exists");
      return;
    } catch (error) {
      // Consumer doesn't exist, create it
      log.queue.info({ userId }, "Creating user consumer");

      await this.jsm!.consumers.add("email-system", {
        name: consumerName,
        durable_name: consumerName,
        filter_subject: `email.user.${userId}.>`,
        ack_policy: AckPolicy.Explicit,
        ack_wait: 30 * 1e9, // 30 seconds
        max_deliver: 5,
        max_ack_pending: 100,
        // Note: rate_limit_bps not supported for pull consumers
        inactive_threshold: 3600 * 1e9, // Auto-delete after 1 hour of inactivity
        deliver_policy: DeliverPolicy.All,
        replay_policy: ReplayPolicy.Instant,
      });

      log.queue.info({ userId }, "User consumer created successfully");
    }
  }

  getConnection(): NatsConnection {
    if (!this.nc) {
      throw new Error("NATS not connected");
    }
    return this.nc;
  }

  getJetStream(): JetStreamClient {
    if (!this.js) {
      throw new Error("JetStream not initialized");
    }
    return this.js;
  }

  getJetStreamManager(): JetStreamManager {
    if (!this.jsm) {
      throw new Error("JetStream Manager not initialized");
    }
    return this.jsm;
  }

  async close(): Promise<void> {
    this.isClosing = true;
    if (this.nc) {
      await this.nc.drain();
      await this.nc.close();
      log.system.info({}, "NATS connection closed gracefully");
    }
  }

  async healthCheck(): Promise<boolean> {
    if (!this.nc) return false;

    try {
      await this.nc.flush();
      return true;
    } catch (error) {
      log.system.error({ error }, "NATS health check failed");
      return false;
    }
  }
}