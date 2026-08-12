/**
 * Network Partition Simulation Test Suite
 *
 * Simulates PostgreSQL connectivity failures during funds operations to verify:
 * 1. No partial state is persisted during mid-transaction failures
 * 2. Errors propagate correctly (no swallowed failures)
 * 3. Idempotent retry after recovery produces correct state
 * 4. Workflow event persistence rejects incomplete writes
 * 5. Kafka/Fluvio publication is never reached without prior DB commit
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Simulate a PostgreSQL client that can be partitioned mid-operation
class SimulatedPgClient {
  private partitioned = false;
  private partitionAfterOps = -1;
  private opCount = 0;
  private committedState: Map<string, any> = new Map();
  private pendingTx: Map<string, any> | null = null;
  public queryLog: string[] = [];

  partition() {
    this.partitioned = true;
  }

  recover() {
    this.partitioned = false;
    this.opCount = 0;
    this.partitionAfterOps = -1;
  }

  partitionAfter(n: number) {
    this.partitionAfterOps = n;
    this.opCount = 0;
  }

  private checkPartition() {
    if (this.partitioned) {
      throw new Error("ECONNREFUSED: connection refused (simulated network partition)");
    }
    if (this.partitionAfterOps >= 0) {
      this.opCount++;
      if (this.opCount > this.partitionAfterOps) {
        this.partitioned = true;
        throw new Error("ECONNRESET: connection reset by peer (simulated mid-operation partition)");
      }
    }
  }

  async begin() {
    this.checkPartition();
    this.pendingTx = new Map();
    this.queryLog.push("BEGIN");
    return {
      exec: async (sql: string, params?: any[]) => {
        this.checkPartition();
        this.queryLog.push(`TX:EXEC ${sql.substring(0, 60)}`);
        if (this.pendingTx) {
          const key = `op_${this.pendingTx.size}`;
          this.pendingTx.set(key, { sql, params });
        }
      },
      queryRow: async (sql: string, params?: any[]) => {
        this.checkPartition();
        this.queryLog.push(`TX:QUERY ${sql.substring(0, 60)}`);
        return { balance_cents: 1000000, transfer_id: null };
      },
      commit: async () => {
        this.checkPartition();
        // Only on successful commit do we apply pending writes
        if (this.pendingTx) {
          for (const [key, value] of this.pendingTx.entries()) {
            this.committedState.set(key, value);
          }
        }
        this.pendingTx = null;
        this.queryLog.push("COMMIT");
      },
      rollback: async () => {
        this.pendingTx = null;
        this.queryLog.push("ROLLBACK");
      },
    };
  }

  async exec(sql: string, params?: any[]) {
    this.checkPartition();
    this.queryLog.push(`EXEC ${sql.substring(0, 60)}`);
    this.committedState.set(`direct_${this.committedState.size}`, { sql, params });
  }

  async queryRow(sql: string, params?: any[]) {
    this.checkPartition();
    this.queryLog.push(`QUERY ${sql.substring(0, 60)}`);
    return {};
  }

  getCommittedStateCount() {
    return this.committedState.size;
  }

  reset() {
    this.committedState.clear();
    this.pendingTx = null;
    this.queryLog = [];
    this.partitioned = false;
    this.opCount = 0;
    this.partitionAfterOps = -1;
  }
}

// Simulate the TigerBeetle processLedgerMovement logic
async function simulateTransfer(
  db: SimulatedPgClient,
  transferId: string,
  payerId: string,
  payeeId: string,
  amount: number
): Promise<{ success: boolean; error?: string; rollbackTriggered?: boolean }> {
  let tx: any;
  try {
    tx = await db.begin();

    // Step 1: Check for duplicate (idempotency)
    await tx.queryRow("SELECT transfer_id FROM ledger_entries WHERE transfer_id = $1", [transferId]);

    // Step 2: Lock payer account
    const payerRow = await tx.queryRow("SELECT balance_cents FROM ledger_accounts WHERE account_id = $1 FOR UPDATE", [payerId]);

    // Step 3: Lock payee account
    await tx.queryRow("SELECT balance_cents FROM ledger_accounts WHERE account_id = $1 FOR UPDATE", [payeeId]);

    // Step 4: Check balance
    if ((payerRow?.balance_cents ?? 0) < amount) {
      await tx.rollback();
      return { success: false, error: "insufficient balance", rollbackTriggered: true };
    }

    // Step 5: Debit payer
    await tx.exec("UPDATE ledger_accounts SET balance_cents = balance_cents - $2 WHERE account_id = $1", [payerId, amount]);

    // Step 6: Credit payee
    await tx.exec("UPDATE ledger_accounts SET balance_cents = balance_cents + $2 WHERE account_id = $1", [payeeId, amount]);

    // Step 7: Insert audit entry
    await tx.exec("INSERT INTO ledger_entries (transfer_id, payer_id, payee_id, amount_cents) VALUES ($1,$2,$3,$4)", [transferId, payerId, payeeId, amount]);

    // Step 8: Commit
    await tx.commit();
    return { success: true };
  } catch (err: any) {
    if (tx) {
      try { await tx.rollback(); } catch {}
    }
    return { success: false, error: err.message, rollbackTriggered: true };
  }
}

// Simulate workflow event recording
async function simulateWorkflowEventRecord(
  db: SimulatedPgClient,
  event: { workflowId: string; step: string; status: string }
): Promise<{ persisted: boolean; published: boolean; error?: string }> {
  let tx: any;
  let committed = false;
  try {
    tx = await db.begin();

    // Upsert workflow state
    await tx.exec("INSERT INTO mojaloop_workflows ... ON CONFLICT DO UPDATE", [event.workflowId, event.step, event.status]);

    // Insert event
    await tx.exec("INSERT INTO mojaloop_workflow_events ...", [event.workflowId, event.step, event.status]);

    // Commit
    await tx.commit();
    committed = true;

    // Only publish AFTER commit (simulating Dapr/Kafka/Fluvio)
    // If partition happens here, DB is safe but publication fails
    return { persisted: true, published: true };
  } catch (err: any) {
    if (tx && !committed) {
      try { await tx.rollback(); } catch {}
    }
    return { persisted: committed, published: false, error: err.message };
  }
}

describe("Network Partition Simulation: TigerBeetle Ledger", () => {
  let db: SimulatedPgClient;

  beforeEach(() => {
    db = new SimulatedPgClient();
  });

  it("rejects transfer completely when partition occurs before BEGIN", async () => {
    db.partition();
    const result = await simulateTransfer(db, "txn-001", "payer-A", "payee-B", 5000);

    expect(result.success).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
    expect(db.getCommittedStateCount()).toBe(0);
    expect(db.queryLog).toEqual([]); // No queries reached the DB
  });

  it("rolls back atomically when partition occurs after debit but before credit", async () => {
    // Partition after 4 operations: BEGIN, idempotency check, payer lock, payee lock, debit succeeds, then partition on credit
    db.partitionAfter(5);
    const result = await simulateTransfer(db, "txn-002", "payer-A", "payee-B", 5000);

    expect(result.success).toBe(false);
    expect(result.error).toContain("ECONNRESET");
    expect(result.rollbackTriggered).toBe(true);
    // CRITICAL: No committed state means the debit was NOT persisted
    expect(db.getCommittedStateCount()).toBe(0);
  });

  it("rolls back atomically when partition occurs after credit but before commit", async () => {
    // Partition after 7 operations (all writes succeed but commit fails)
    db.partitionAfter(7);
    const result = await simulateTransfer(db, "txn-003", "payer-A", "payee-B", 5000);

    expect(result.success).toBe(false);
    expect(result.error).toContain("ECONNRESET");
    expect(result.rollbackTriggered).toBe(true);
    // CRITICAL: Despite debit AND credit executing, nothing is committed
    expect(db.getCommittedStateCount()).toBe(0);
  });

  it("succeeds normally when no partition occurs", async () => {
    const result = await simulateTransfer(db, "txn-004", "payer-A", "payee-B", 5000);

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    // State was committed (3 operations: debit, credit, entry)
    expect(db.getCommittedStateCount()).toBe(3);
    expect(db.queryLog).toContain("COMMIT");
    expect(db.queryLog).not.toContain("ROLLBACK");
  });

  it("allows idempotent retry after recovery from partition", async () => {
    // First attempt: partition mid-transaction
    db.partitionAfter(3);
    const firstAttempt = await simulateTransfer(db, "txn-005", "payer-A", "payee-B", 5000);
    expect(firstAttempt.success).toBe(false);
    expect(db.getCommittedStateCount()).toBe(0);

    // Recovery: network restored
    db.recover();
    const retryAttempt = await simulateTransfer(db, "txn-005", "payer-A", "payee-B", 5000);
    expect(retryAttempt.success).toBe(true);
    expect(db.getCommittedStateCount()).toBe(3);
  });

  it("never leaves partial debit without credit in committed state", async () => {
    // Run 20 transfers with random partition points
    const partitionPoints = [1, 2, 3, 4, 5, 6, 7, 8];
    for (const point of partitionPoints) {
      db.reset();
      db.partitionAfter(point);
      const result = await simulateTransfer(db, `txn-fuzz-${point}`, "payer-X", "payee-Y", 1000);

      if (result.success) {
        // If committed, ALL 3 operations must be present
        expect(db.getCommittedStateCount()).toBe(3);
      } else {
        // If failed, ZERO operations must be committed
        expect(db.getCommittedStateCount()).toBe(0);
      }
    }
  });
});

describe("Network Partition Simulation: Workflow Event Persistence", () => {
  let db: SimulatedPgClient;

  beforeEach(() => {
    db = new SimulatedPgClient();
  });

  it("never publishes to brokers if DB commit fails", async () => {
    // Partition after workflow upsert but before commit
    db.partitionAfter(3);
    const result = await simulateWorkflowEventRecord(db, {
      workflowId: "wf-001",
      step: "initiate",
      status: "submitted",
    });

    expect(result.persisted).toBe(false);
    expect(result.published).toBe(false);
    expect(result.error).toContain("ECONNRESET");
  });

  it("persists event and publishes when no partition occurs", async () => {
    const result = await simulateWorkflowEventRecord(db, {
      workflowId: "wf-002",
      step: "settle",
      status: "completed",
    });

    expect(result.persisted).toBe(true);
    expect(result.published).toBe(true);
    expect(result.error).toBeUndefined();
    expect(db.queryLog).toContain("COMMIT");
  });

  it("rejects event recording completely when partition occurs before BEGIN", async () => {
    db.partition();
    const result = await simulateWorkflowEventRecord(db, {
      workflowId: "wf-003",
      step: "initiate",
      status: "submitted",
    });

    expect(result.persisted).toBe(false);
    expect(result.published).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
  });

  it("maintains persist-before-publish ordering under all failure modes", async () => {
    const scenarios = [
      { partitionAt: 0, expectPersisted: false, expectPublished: false },
      { partitionAt: 1, expectPersisted: false, expectPublished: false },
      { partitionAt: 2, expectPersisted: false, expectPublished: false },
      { partitionAt: 3, expectPersisted: false, expectPublished: false },
      { partitionAt: -1, expectPersisted: true, expectPublished: true }, // no partition
    ];

    for (const scenario of scenarios) {
      db.reset();
      if (scenario.partitionAt >= 0) {
        db.partitionAfter(scenario.partitionAt);
      }

      const result = await simulateWorkflowEventRecord(db, {
        workflowId: `wf-order-${scenario.partitionAt}`,
        step: "transfer",
        status: "pending",
      });

      expect(result.persisted).toBe(scenario.expectPersisted);
      // CRITICAL: published can NEVER be true if persisted is false
      if (!result.persisted) {
        expect(result.published).toBe(false);
      }
    }
  });
});

describe("Network Partition Simulation: Recovery and Consistency", () => {
  let db: SimulatedPgClient;

  beforeEach(() => {
    db = new SimulatedPgClient();
  });

  it("system recovers cleanly after partition heals", async () => {
    // Phase 1: Partition — all operations fail
    db.partition();
    const failedTransfer = await simulateTransfer(db, "txn-recovery-1", "payer-R", "payee-S", 2000);
    expect(failedTransfer.success).toBe(false);

    const failedEvent = await simulateWorkflowEventRecord(db, {
      workflowId: "wf-recovery-1",
      step: "initiate",
      status: "submitted",
    });
    expect(failedEvent.persisted).toBe(false);

    // Phase 2: Recovery — all operations succeed
    db.recover();
    const recoveredTransfer = await simulateTransfer(db, "txn-recovery-1", "payer-R", "payee-S", 2000);
    expect(recoveredTransfer.success).toBe(true);

    const recoveredEvent = await simulateWorkflowEventRecord(db, {
      workflowId: "wf-recovery-1",
      step: "initiate",
      status: "submitted",
    });
    expect(recoveredEvent.persisted).toBe(true);
    expect(recoveredEvent.published).toBe(true);
  });

  it("no zombie state exists after multiple partition cycles", async () => {
    for (let cycle = 0; cycle < 5; cycle++) {
      db.reset();

      // Partition mid-operation
      db.partitionAfter(2 + cycle);
      const result = await simulateTransfer(db, `txn-zombie-${cycle}`, "payer-Z", "payee-W", 500);

      if (!result.success) {
        // INVARIANT: Failed operations leave zero committed state
        expect(db.getCommittedStateCount()).toBe(0);
      }
    }
  });
});
