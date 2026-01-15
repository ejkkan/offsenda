# Stuck Batch Detector - Automatic Recovery System

**Date:** 2026-01-13
**Status:** Approved - Ready for Implementation
**Priority:** High (fixes user-facing bug)

## Problem Statement

Batches currently get stuck in "processing" status indefinitely when all emails have been successfully sent. This creates a poor user experience where:
- Batch status shows "processing" instead of "completed"
- Users can't tell if their batch actually finished
- Dashboard metrics appear incorrect
- No automatic recovery mechanism exists

### Real Example
```
Status: processing ❌ (should be "completed")
Sent: 1 email ✅
Pending: 0 ✅
Recipient: sent ✅
```

## Root Cause Analysis

Batch completion is purely **event-driven**:
1. `processBatchMessage()` checks completion when processing a batch
2. `checkBatchCompletion()` is called after each email send/fail

**The Gap:** If the event loop is interrupted or `checkBatchCompletion()` fails silently, batches remain stuck forever with no recovery mechanism.

## Proposed Solution

Add a **periodic stuck batch detector** that runs in the background.

### Detection Criteria
A batch is "stuck" if ALL conditions are met:
- Status is "processing"
- Started > 15 minutes ago
- All recipients in final state (sent/failed/bounced/complained)
- No pending/queued recipients remain

### Implementation

**1. Add detector method** (`apps/worker/src/nats/workers.ts`):
```typescript
async detectAndRecoverStuckBatches(): Promise<void> {
  const stuckThreshold = new Date(Date.now() - 15 * 60 * 1000);

  const stuckBatches = await db.query.batches.findMany({
    where: and(
      eq(batches.status, "processing"),
      sql`${batches.startedAt} < ${stuckThreshold}`
    ),
    columns: { id: true, startedAt: true },
  });

  if (stuckBatches.length === 0) return;

  log.system.info({ count: stuckBatches.length }, "Checking potentially stuck batches");

  for (const batch of stuckBatches) {
    await this.checkBatchCompletion(batch.id);
  }
}
```

**2. Add periodic scanner** (`apps/worker/src/index.ts`):
```typescript
// Detect and recover stuck batches (every 5 minutes)
setInterval(() => {
  worker
    ?.detectAndRecoverStuckBatches()
    .catch((error) => {
      log.system.error({ error }, "Stuck batch detection failed");
    });
}, 5 * 60 * 1000);
```

**3. Optional: Add configuration** (`apps/worker/src/config.ts`):
```typescript
STUCK_BATCH_THRESHOLD_MS: z.coerce.number().default(15 * 60 * 1000),
```

## Benefits

✅ **Automatic recovery** - Fixes stuck batches without manual intervention
✅ **Lightweight** - Runs every 5 minutes, minimal overhead
✅ **Non-invasive** - Doesn't affect normal processing
✅ **Reuses existing logic** - Calls `checkBatchCompletion()`
✅ **Handles historical** - Fixes currently stuck batches
✅ **Prevents future issues** - Catches edge cases in production

## Edge Cases Handled

1. **Batch legitimately processing** → Won't touch if < 15 minutes old
2. **Batch with pending emails** → `checkBatchCompletion()` verifies all done
3. **Multiple workers** → Idempotent updates prevent race conditions
4. **Database races** → Status check prevents duplicate completions

## Testing Plan

### 1. Test with Stuck Batch
- Start dev server: `pnpm dev`
- Currently stuck batch should be fixed within 5 minutes
- Watch logs for: `"Checking potentially stuck batches"` and `"completed"`
- Refresh batch page → status should be "completed"

### 2. Test with New Batch
- Create and send a new batch
- Verify it completes immediately (within seconds)
- Stuck batch detector should not interfere

### 3. Test Detection Logic
- Create batch, manually set status to "processing"
- Set `startedAt` to 20 minutes ago
- Mark all recipients as "sent"
- Wait 5 minutes → verify batch marked "completed"

## Monitoring

Track detector effectiveness:
- Number of stuck batches found per scan
- Age of stuck batches when recovered
- Any errors during detection

Example log output:
```
[INFO] system | Checking potentially stuck batches (count: 2)
[INFO] batch | completed (id: "abc-123")
[INFO] batch | completed (id: "def-456")
```

## Future Enhancements

1. **Metrics endpoint** - Expose stuck batch count via `/api/metrics`
2. **Alerting** - Send notification when > 5 stuck batches detected
3. **Configurable threshold** - Adjust via env var
4. **Dashboard widget** - Show "Recovered batches" count
5. **Database index** - Add `(status, startedAt)` index for performance

## Rollback Plan

Simply remove the `setInterval()` call from `index.ts`. The new method is isolated and won't affect existing functionality.

## Implementation Checklist

- [ ] Add `detectAndRecoverStuckBatches()` method to `NatsEmailWorker` class
- [ ] Add `setInterval()` call in `index.ts` startup
- [ ] (Optional) Add `STUCK_BATCH_THRESHOLD_MS` config
- [ ] Test with existing stuck batch
- [ ] Test with new batch (verify no interference)
- [ ] Test detection logic with manually stuck batch
- [ ] Monitor logs for recovery events
- [ ] Update documentation if needed

## Files to Modify

1. `apps/worker/src/nats/workers.ts` - Add detector method
2. `apps/worker/src/index.ts` - Add periodic scanner
3. `apps/worker/src/config.ts` - (Optional) Add config option

## Estimated Effort

**Implementation:** 30 minutes
**Testing:** 15 minutes
**Total:** ~45 minutes

## Dependencies

None - uses existing `checkBatchCompletion()` logic

## Related Issues

- Batches stuck in "processing" status (current bug)
- Event-driven completion checks can miss edge cases
- No recovery mechanism for interrupted processing
