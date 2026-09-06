import { Migration } from '@mikro-orm/migrations';

const GUARD = (identityColumns: string, processedMessage: string, processedArgs: string): string => `
  CREATE OR REPLACE FUNCTION inbox_message_guard() RETURNS trigger AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'inbox_message is append-only: DELETE is not allowed'
        USING ERRCODE = '0A000';
    END IF;

    IF ${identityColumns} THEN
      RAISE EXCEPTION 'inbox_message identity is immutable'
        USING ERRCODE = '0A000';
    END IF;

    IF OLD.processed_at IS NOT NULL
       AND NEW.processed_at IS DISTINCT FROM OLD.processed_at THEN
      RAISE EXCEPTION '${processedMessage}', ${processedArgs}
        USING ERRCODE = '0A000';
    END IF;

    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;
`;

const SHARED_IDENTITY = `NEW.consumer_name <> OLD.consumer_name
       OR NEW.message_id <> OLD.message_id
       OR NEW.payload_hash <> OLD.payload_hash
       OR NEW.received_at <> OLD.received_at`;

export class Migration20260906000003_inbox_provider_scope extends Migration {
  // The message id belongs to the producer, so two providers that number their own collide.
  override async up(): Promise<void> {
    this.addSql(`ALTER TABLE inbox_message ADD COLUMN provider_id varchar(64) NOT NULL DEFAULT '';`);
    this.addSql(`ALTER TABLE inbox_message ALTER COLUMN provider_id DROP DEFAULT;`);
    this.addSql(`ALTER TABLE inbox_message DROP CONSTRAINT inbox_message_pk;`);
    this.addSql(`
      ALTER TABLE inbox_message
        ADD CONSTRAINT inbox_message_pk PRIMARY KEY (consumer_name, provider_id, message_id);
    `);

    this.addSql(
      GUARD(
        `NEW.provider_id <> OLD.provider_id
       OR ${SHARED_IDENTITY}`,
        'inbox_message %/%/% is already processed',
        'OLD.consumer_name, OLD.provider_id, OLD.message_id',
      ),
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      GUARD(
        SHARED_IDENTITY,
        'inbox_message %/% is already processed',
        'OLD.consumer_name, OLD.message_id',
      ),
    );

    this.addSql(`ALTER TABLE inbox_message DROP CONSTRAINT inbox_message_pk;`);
    this.addSql(`
      ALTER TABLE inbox_message
        ADD CONSTRAINT inbox_message_pk PRIMARY KEY (consumer_name, message_id);
    `);
    this.addSql(`ALTER TABLE inbox_message DROP COLUMN provider_id;`);
  }
}
