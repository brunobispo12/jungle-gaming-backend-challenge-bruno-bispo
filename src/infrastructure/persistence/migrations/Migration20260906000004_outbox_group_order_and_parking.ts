import { Migration } from '@mikro-orm/migrations';

export class Migration20260906000004_outbox_group_order_and_parking extends Migration {
  // The consumer has a DLQ; without abandoned_at the publisher retries a dead
  // event forever. The group index lets the claim hold a FIFO group behind its
  // oldest pending message.
  override async up(): Promise<void> {
    this.addSql(`ALTER TABLE outbox_message ADD COLUMN abandoned_at timestamptz;`);
    this.addSql(`
      ALTER TABLE outbox_message ADD CONSTRAINT outbox_abandoned_unpublished_ck CHECK (
        abandoned_at IS NULL OR published_at IS NULL
      );
    `);
    this.addSql(`GRANT UPDATE (abandoned_at) ON outbox_message TO wagering_app;`);

    this.addSql(`DROP INDEX outbox_pending_ix;`);
    this.addSql(`
      CREATE INDEX outbox_pending_ix
        ON outbox_message (occurred_at, id)
        INCLUDE (next_attempt_at, claimed_until)
        WHERE published_at IS NULL AND abandoned_at IS NULL;
    `);

    this.addSql(`
      CREATE INDEX outbox_group_order_ix
        ON outbox_message (aggregate_id, occurred_at, id)
        WHERE published_at IS NULL AND abandoned_at IS NULL;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP INDEX outbox_group_order_ix;`);
    this.addSql(`DROP INDEX outbox_pending_ix;`);
    this.addSql(`
      CREATE INDEX outbox_pending_ix
        ON outbox_message (occurred_at, id)
        INCLUDE (next_attempt_at, claimed_until)
        WHERE published_at IS NULL;
    `);
    this.addSql(`REVOKE UPDATE (abandoned_at) ON outbox_message FROM wagering_app;`);
    this.addSql(`ALTER TABLE outbox_message DROP CONSTRAINT outbox_abandoned_unpublished_ck;`);
    this.addSql(`ALTER TABLE outbox_message DROP COLUMN abandoned_at;`);
  }
}
