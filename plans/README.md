# Plans Directory

This directory contains strategic planning documents, architectural decisions, and implementation roadmaps for the BatchSender project.

## Active Plans

### 🚨 Production Readiness Checklist (2026-01-13)
**File:** `production-readiness-2026-01-13.md`

**Summary:** Comprehensive audit of production readiness with 17 prioritized tasks. Identifies critical gaps in cold storage, encryption, monitoring, and disaster recovery. Includes "Quick Wins" section with 7 tasks achievable in Week 1 (~24 hours effort).

**Status:** 📋 Under Review
**Priority:** CRITICAL - Required before production launch
**Coverage:** Security (40%), Monitoring (20%), Backups (30%), DR (10%)

**Recommended Start:** Week 1 Quick Wins (Items #1-7)
- 🔒 TLS for NATS (2-4h)
- 🛡️ Request validation (2-3h)
- 📝 Audit logging (4-6h)
- 💾 ClickHouse backups (3-4h)
- 🔐 Webhook validation fix (1h)
- 🎭 Error message hardening (2h)
- 📖 Runbook documentation (3-4h)

**Total:** 17 tasks, 0/17 completed

---

### 🐛 Stuck Batch Detector - Automatic Recovery (2026-01-13)
**File:** `stuck-batch-detector-2026-01-13.md`

**Summary:** Add periodic background detector to identify and fix batches stuck in "processing" status. Runs every 5 minutes to check for batches older than 15 minutes with all emails completed.

**Status:** ✅ Approved - Ready for Implementation
**Priority:** High (fixes user-facing bug)
**Estimated Effort:** ~45 minutes

---

### 🚀 Modular Platform Evolution

Strategic initiative to transform BatchSender from an email-specific tool into a general-purpose modular batch processing platform.

#### 1. Strategic Analysis
**File:** `01-strategic-analysis-modular-platform.md`
- Market gap analysis
- Competitive landscape
- Use case priorities
- Success metrics

**Status:** 📋 Under Review
**Decision Needed:** Strategic direction and positioning

#### 2. Architecture Design
**File:** `02-architecture-plugin-system.md`
- Plugin system architecture
- Database schema changes
- Worker system updates
- File structure

**Status:** 📐 Design Phase
**Estimated Complexity:** 8-12 weeks

#### 3. Implementation Roadmap
**File:** `03-implementation-roadmap.md`
- Three implementation paths (A, B, C)
- Phase-by-phase breakdown
- Testing strategy
- Critical files to modify

**Status:** 📅 Awaiting Path Selection
**Options:** Incremental (A - Recommended), Prototype (B), Clean Slate (C)

#### 4. Module: SMS
**File:** `04-module-sms.md`
- SMS payload structure
- Twilio/Vonage providers
- Phone validation
- UI components

**Status:** 📱 Ready to Implement
**Priority:** Tier 1 (High)
**Estimated Effort:** 2 weeks

#### 5. Module: Webhook
**File:** `05-module-webhook.md`
- Webhook payload structure
- Retry logic with exponential backoff
- Circuit breaker pattern
- HMAC signature support

**Status:** 🔗 Ready to Implement
**Priority:** Tier 2 (High Value)
**Estimated Effort:** 2 weeks

#### 6. Module: CRM
**File:** `06-module-crm.md`
- Salesforce/HubSpot/Pipedrive
- Bulk operation handling
- CSV upload and parsing
- OAuth integration

**Status:** 📊 Ready to Implement
**Priority:** Tier 2 (High Value)
**Estimated Effort:** 3 weeks

---

## Archived Plans

### Strategic Pivot to Modular Platform (Original - Archived)
**File:** `archived/strategic-pivot-to-modular-platform-original.md`

**Note:** This monolithic document has been split into focused, task-specific documents (01-06 above) for better organization and clarity.

**Status:** 📦 Archived
**Date Archived:** 2026-01-13

---

## Purpose

This folder serves as:
1. **Strategic Documentation** - Long-term vision and market positioning
2. **Implementation Roadmaps** - Technical plans for major features/refactors
3. **Task-Specific Plans** - Focused documents for individual modules/features
4. **Historical Record** - Context for future contributors and agents
5. **Decision Log** - Record of architectural and product decisions

## Organization

Plans are organized by prefix:
- `01-06`: Numbered plans for multi-part initiatives (read in order)
- `YYYY-MM-DD`: Date-stamped plans for standalone features
- `archived/`: Historical plans no longer active

## Contributing

When adding new plans:
- Use descriptive filenames: `feature-name-YYYY-MM-DD.md` or numbered for series
- Include date, status, and decision points
- Keep plans focused on a single topic or module
- Link to related GitHub issues/PRs when applicable
- Update this README with a summary

## Status Labels

- ✅ **Approved** - Ready for implementation
- 📋 **Under Review** - Awaiting feedback/approval
- 📐 **Design Phase** - Technical design in progress
- 📅 **Planning** - Initial planning/scoping
- 🚧 **In Progress** - Currently being implemented
- ✅ **Completed** - Fully implemented
- 📦 **Archived** - No longer relevant or superseded
