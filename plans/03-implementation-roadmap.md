# Implementation Roadmap: Three Paths to Modular Platform

**Date:** 2026-01-13
**Status:** Decision Needed
**Related:** Architecture Design (02-architecture-plugin-system.md)

## Decision Point: Choose Implementation Path

### Option A: Incremental Refactor (Recommended - Safest)
**Timeline:** 8-10 weeks
**Risk:** Low-Medium

**Approach:**
1. Add generic `payload` JSONB column to batches table, keep email fields for backward compat
2. Create `job_type` enum, default to "email"
3. Build plugin system alongside existing email code
4. Gradually migrate email logic into a plugin
5. Add SMS and webhook modules

**Pros:**
- ✅ Email keeps working throughout refactor
- ✅ Can validate abstraction with real code
- ✅ Incremental deployment, easier to test

**Cons:**
- ❌ Technical debt during transition
- ❌ Schema has redundant fields temporarily

---

### Option B: Prototype Validation (Fastest to Learn)
**Timeline:** 2-3 weeks
**Risk:** Low (throwaway code acceptable)

**Approach:**
1. Create parallel webhook module alongside email
2. See what abstractions are needed
3. Validate plugin pattern works
4. Then do full refactor with lessons learned

**Pros:**
- ✅ Fast validation of concept
- ✅ Learn what abstractions are needed
- ✅ Low commitment

**Cons:**
- ❌ Throwaway work
- ❌ Doesn't solve the problem, just informs it

---

### Option C: Clean Slate Refactor (Cleanest Architecture)
**Timeline:** 10-12 weeks
**Risk:** High

**Approach:**
1. Design new generic schema from scratch
2. Build plugin system first
3. Port email as first plugin
4. Add SMS and webhooks

**Pros:**
- ✅ Cleanest architecture
- ✅ No technical debt
- ✅ Best long-term foundation

**Cons:**
- ❌ Longer timeline
- ❌ More risk (big rewrite)
- ❌ Can't validate in production incrementally

---

## Recommended: Option A (Incremental Refactor)

### Phase 1: Core Refactoring (3-4 weeks) - ✅ 80% COMPLETE

**Week 1-2: Schema & Plugin System**
- [x] Add `module_type` enum to schema (email, webhook, sms) - `packages/db/src/schema.ts`
- [ ] Create `job_events` table for generic event tracking
- [x] Create module system interfaces (`Module`, `JobPayload`, `JobResult`) - `apps/worker/src/modules/types.ts`
- [x] Create module registry - `apps/worker/src/modules/index.ts`
- [x] Update database migrations
- [ ] Write unit tests for module system

**Week 3-4: Refactor Email as Module**
- [x] Create email module - `apps/worker/src/modules/email-module.ts`
- [x] Implement `EmailModule` using new interfaces
- [x] Create webhook module with resilient HTTP client - `apps/worker/src/modules/webhook-module.ts`
- [ ] Update workers.ts to fully use module registry
- [ ] Update queue-service.ts to support job types
- [x] Ensure all existing email tests pass
- [x] Test backward compatibility

**Deliverables:**
- ✅ Module system operational
- ✅ Email working as a module
- ✅ Webhook module with retry/circuit breaker
- ✅ No regression in email functionality
- ✅ Foundation ready for new modules

---

### Phase 2: Add Priority Modules (2-3 weeks each) - 🟡 33% COMPLETE

**Week 5-6: SMS Module** - ⬜ NOT STARTED
- [ ] Create `modules/sms/processor.ts`
- [ ] Implement Twilio provider
- [ ] Implement Vonage provider (optional)
- [ ] Add SMS-specific validation (phone numbers)
- [ ] Create SMS batch creation UI
- [ ] Write integration tests
- [ ] Test with Twilio sandbox

**Week 7-8: Webhook Module** - ✅ COMPLETE
- [x] Create `modules/webhook-module.ts`
- [x] Implement resilient HTTP client with retry logic - `apps/worker/src/http/resilient-client.ts`
- [x] Add exponential backoff with jitter
- [x] Add timeout handling with AbortController
- [x] Add circuit breaker pattern (per-endpoint)
- [x] Add response validation and error classification
- [ ] Create webhook batch creation UI
- [x] Test with mock webhook server

**Week 9-10: CRM Module (Optional)** - ⬜ NOT STARTED
- [ ] Create `modules/crm-module.ts`
- [ ] Implement Salesforce Bulk API provider
- [ ] Implement HubSpot Batch API provider
- [ ] Add CRM operation validation
- [ ] Create CRM batch creation UI
- [ ] Test with sandbox environments

**Deliverables:**
- 🟡 2/4 job types supported (email, webhook)
- 🟡 Webhook module thoroughly tested
- ⬜ UI updated for multi-module support

---

### Phase 3: UI & API Polish (1-2 weeks)

**Week 11: Web App Updates**
- [ ] Job type selection UI on batch creation page
- [ ] Dynamic payload editor based on job type
- [ ] Module-specific analytics dashboards
- [ ] Update batch detail pages for all job types
- [ ] Add job type filter to batch list

**Week 12: Documentation & Launch Prep**
- [ ] API documentation for all job types
- [ ] Example projects for each module
- [ ] Migration guide for email-only users
- [ ] Performance benchmarking
- [ ] End-to-end testing across all modules
- [ ] Launch checklist

**Deliverables:**
- ✅ Complete multi-module platform
- ✅ Production-ready
- ✅ Documented and tested

---

## Testing Strategy

### Phase 1: Core Refactoring
1. Keep existing email tests passing
2. Add plugin system unit tests
3. Integration tests for processor registry

### Phase 2: Module Testing
1. **SMS Module:**
   - Mock Twilio API responses
   - Test phone number validation
   - Test rate limiting

2. **Webhook Module:**
   - Mock HTTP responses
   - Test retry logic with backoff
   - Test timeout handling

3. **CRM Module:**
   - Mock Salesforce/HubSpot APIs
   - Test bulk operation handling
   - Test error aggregation

### Phase 3: End-to-End
1. Create test batches for each job type
2. Verify queue processing
3. Verify analytics tracking
4. Verify webhook delivery

---

## Critical Files to Modify

### Database Schema
- `packages/db/src/schema.ts` - Add generic fields, job_type enum

### Core Worker System
- `apps/worker/src/nats/workers.ts` - Refactor to use plugin system
- `apps/worker/src/nats/queue-service.ts` - Generic job types
- `apps/worker/src/config.ts` - Plugin configuration

### Plugin System (New)
- `apps/worker/src/plugins/types.ts` - Core interfaces
- `apps/worker/src/plugins/registry.ts` - Plugin registration
- `apps/worker/src/plugins/email/processor.ts` - Email processor
- `apps/worker/src/plugins/sms/processor.ts` - SMS processor
- `apps/worker/src/plugins/webhook/processor.ts` - Webhook processor

### Web App
- `apps/web/src/app/batches/new/` - Job type selection UI
- `apps/web/src/components/forms/` - Module-specific forms

---

## Milestones & Reviews

### Milestone 1: Plugin System (Week 4)
**Review Criteria:**
- Email working as plugin
- No functionality regression
- Test coverage maintained

### Milestone 2: First New Module (Week 6)
**Review Criteria:**
- SMS or webhook module functional
- Plugin pattern validated
- Performance acceptable

### Milestone 3: Multi-Module Platform (Week 10)
**Review Criteria:**
- 3+ modules working
- UI supports all modules
- Documentation complete

### Milestone 4: Production Ready (Week 12)
**Review Criteria:**
- End-to-end tests passing
- Performance benchmarks met
- Launch checklist complete

---

## Next Steps

1. **Immediate:** Choose implementation path (A, B, or C)
2. **Week 1:** Begin Phase 1 schema changes
3. **Weekly:** Review progress against milestones
4. **Week 12:** Launch preparation
