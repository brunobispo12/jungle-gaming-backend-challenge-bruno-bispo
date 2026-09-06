import { Migration } from '@mikro-orm/migrations';

export class Migration20260906000002_reversal_slot_per_reference extends Migration {
  // One active reversal per reference, any kind, and the slot reopens when the
  // reversal is rolled back: uniqueness reads other rows, so it needs a trigger.
  override async up(): Promise<void> {
    this.addSql(`DROP INDEX wager_reversal_once_per_kind_uq;`);

    this.addSql(`
      CREATE INDEX wager_reference_transaction_ix
        ON wager_transaction (reference_transaction_id)
        WHERE reference_transaction_id IS NOT NULL;
    `);

    this.addSql(`
      CREATE FUNCTION wager_reversal_guard() RETURNS trigger AS $$
      BEGIN
        IF NEW.status <> 'PROCESSED'
           OR NEW.kind NOT IN ('REFUND', 'ROLLBACK')
           OR NEW.reference_transaction_id IS NULL THEN
          RETURN NEW;
        END IF;

        IF EXISTS (
          SELECT 1
          FROM wager_transaction applied
          WHERE applied.reference_transaction_id = NEW.reference_transaction_id
            AND applied.id <> NEW.id
            AND applied.status = 'PROCESSED'
            AND applied.kind IN ('REFUND', 'ROLLBACK')
            AND NOT EXISTS (
              SELECT 1
              FROM wager_transaction undone
              WHERE undone.reference_transaction_id = applied.id
                AND undone.status = 'PROCESSED'
                AND undone.kind = 'ROLLBACK'
            )
        ) THEN
          RAISE EXCEPTION 'wager_transaction % already has an active reversal',
            NEW.reference_transaction_id
            USING ERRCODE = '23505';
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    this.addSql(`
      CREATE TRIGGER wager_reversal_guard_tg
        BEFORE INSERT OR UPDATE ON wager_transaction
        FOR EACH ROW EXECUTE FUNCTION wager_reversal_guard();
    `);
  }

  // Restoring the narrower rule fails over rows the wider one allowed. That is
  // the honest outcome; recreating a disposable database drops instead.
  override async down(): Promise<void> {
    this.addSql(`DROP TRIGGER wager_reversal_guard_tg ON wager_transaction;`);
    this.addSql(`DROP FUNCTION wager_reversal_guard();`);
    this.addSql(`DROP INDEX wager_reference_transaction_ix;`);
    this.addSql(`
      CREATE UNIQUE INDEX wager_reversal_once_per_kind_uq
        ON wager_transaction (reference_transaction_id, kind)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK');
    `);
  }
}
