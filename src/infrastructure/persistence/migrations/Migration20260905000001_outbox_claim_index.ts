import { Migration } from '@mikro-orm/migrations';

export class Migration20260905000001_outbox_claim_index extends Migration {
  // Ordered by what the claim orders by. Leading with next_attempt_at made the
  // due-time filter a range scan and forced a sort of every eligible row on each
  // claim, which publishes one message at a time.
  override async up(): Promise<void> {
    this.addSql(`DROP INDEX outbox_pending_ix;`);

    this.addSql(`
      CREATE INDEX outbox_pending_ix
        ON outbox_message (occurred_at, id)
        INCLUDE (next_attempt_at, claimed_until)
        WHERE published_at IS NULL;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP INDEX outbox_pending_ix;`);

    this.addSql(`
      CREATE INDEX outbox_pending_ix
        ON outbox_message (next_attempt_at, claimed_until, occurred_at, id)
        WHERE published_at IS NULL;
    `);
  }
}
