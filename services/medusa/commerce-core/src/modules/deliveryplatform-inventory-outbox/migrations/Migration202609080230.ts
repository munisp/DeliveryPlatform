import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration202609080230 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE TABLE IF NOT EXISTS deliveryplatform_inventory_outbox (
        id uuid PRIMARY KEY,
        source_event_key text NOT NULL UNIQUE CHECK (length(source_event_key) BETWEEN 8 AND 255),
        event_type text NOT NULL CHECK (event_type IN ('commerce.inventory.level.snapshot', 'commerce.inventory.reservation.snapshot')),
        payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
        source_occurred_at timestamptz NOT NULL,
        state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processing', 'delivered', 'dead_letter')),
        attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 16),
        next_attempt_at timestamptz NOT NULL DEFAULT now(),
        claim_token uuid,
        lease_expires_at timestamptz,
        delivered_at timestamptz,
        last_error text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CHECK (
          (state = 'processing' AND claim_token IS NOT NULL AND lease_expires_at IS NOT NULL AND delivered_at IS NULL)
          OR (state = 'delivered' AND claim_token IS NULL AND lease_expires_at IS NULL AND delivered_at IS NOT NULL)
          OR (state IN ('pending', 'dead_letter') AND claim_token IS NULL AND lease_expires_at IS NULL AND delivered_at IS NULL)
        )
      );
      CREATE INDEX IF NOT EXISTS deliveryplatform_inventory_outbox_ready_idx
        ON deliveryplatform_inventory_outbox (next_attempt_at, created_at)
        WHERE state = 'pending';
      CREATE INDEX IF NOT EXISTS deliveryplatform_inventory_outbox_lease_idx
        ON deliveryplatform_inventory_outbox (lease_expires_at)
        WHERE state = 'processing';
    `);
  }

  async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS deliveryplatform_inventory_outbox;`);
  }
}
