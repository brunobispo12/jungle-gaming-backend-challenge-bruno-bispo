import { Migration } from '@mikro-orm/migrations';

export class Migration20260904000001_initial extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TYPE wager_transaction_kind AS ENUM (
        'OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'
      );
    `);

    this.addSql(`
      CREATE TYPE wager_transaction_status AS ENUM (
        'PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'
      );
    `);

    this.addSql(`CREATE TYPE ledger_direction AS ENUM ('DEBIT', 'CREDIT');`);

    this.addSql(`
      CREATE TYPE wager_failure_code AS ENUM (
        'INSUFFICIENT_FUNDS',
        'REVERSAL_WOULD_OVERDRAW',
        'REFERENCE_NOT_FOUND',
        'REFERENCE_NOT_PROCESSED',
        'REFERENCE_KIND_NOT_REVERSIBLE',
        'REFERENCE_MISMATCH',
        'REVERSAL_AMOUNT_MISMATCH',
        'REFERENCE_ALREADY_REVERSED',
        'CURRENCY_MISMATCH',
        'WALLET_NOT_FOUND',
        'WALLET_PLAYER_MISMATCH',
        'INFRASTRUCTURE_FAILURE'
      );
    `);

    this.addSql(`
      CREATE TABLE wallet (
        id          uuid          NOT NULL,
        player_id   varchar(64)   NOT NULL,
        currency    char(3)       NOT NULL,
        balance     numeric(20,2) NOT NULL,
        version     integer       NOT NULL,
        created_at  timestamptz   NOT NULL,
        updated_at  timestamptz   NOT NULL,

        CONSTRAINT wallet_pk PRIMARY KEY (id),
        CONSTRAINT wallet_player_currency_uq UNIQUE (player_id, currency),
        CONSTRAINT wallet_id_currency_uq UNIQUE (id, currency),
        CONSTRAINT wallet_balance_non_negative_ck CHECK (balance >= 0),
        CONSTRAINT wallet_version_min_ck CHECK (version >= 1),
        CONSTRAINT wallet_currency_iso_ck CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wallet_updated_after_created_ck CHECK (updated_at >= created_at)
      );
    `);

    // Sem FK simples em wallet_id: WALLET_NOT_FOUND precisa ser auditável. A FK
    // composta é MATCH SIMPLE, então não é verificada com o snapshot nulo.
    this.addSql(`
      CREATE TABLE wager_transaction (
        id                                uuid                     NOT NULL,
        provider_id                       varchar(64)              NOT NULL,
        external_transaction_id           varchar(128)             NOT NULL,
        idempotency_key                   varchar(255)             NOT NULL,
        payload_hash                      char(64)                 NOT NULL,
        wallet_id                         uuid                     NOT NULL,
        player_id                         varchar(64)              NOT NULL,
        round_id                          varchar(128)             NOT NULL,
        game_id                           varchar(128)             NOT NULL,
        kind                              wager_transaction_kind   NOT NULL,
        amount                            numeric(20,2)            NOT NULL,
        currency                          char(3)                  NOT NULL,
        reference_external_transaction_id varchar(128),
        reference_transaction_id          uuid,
        status                            wager_transaction_status NOT NULL,
        failure_code                      wager_failure_code,
        result_balance_amount             numeric(20,2),
        result_balance_currency           char(3),
        attempts                          integer                  NOT NULL DEFAULT 0,
        next_attempt_at                   timestamptz,
        expires_at                        timestamptz,
        correlation_id                    varchar(128)             NOT NULL,
        created_at                        timestamptz              NOT NULL,
        processed_at                      timestamptz,

        CONSTRAINT wager_transaction_pk PRIMARY KEY (id),

        CONSTRAINT wager_provider_idempotency_uq UNIQUE (provider_id, idempotency_key),
        CONSTRAINT wager_provider_external_uq UNIQUE (provider_id, external_transaction_id),

        CONSTRAINT wager_reference_fk
          FOREIGN KEY (reference_transaction_id)
          REFERENCES wager_transaction (id) ON DELETE RESTRICT,

        CONSTRAINT wager_result_balance_wallet_fk
          FOREIGN KEY (wallet_id, result_balance_currency)
          REFERENCES wallet (id, currency) MATCH SIMPLE ON DELETE RESTRICT,

        CONSTRAINT wager_amount_positive_ck CHECK (amount > 0),
        CONSTRAINT wager_currency_iso_ck CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wager_attempts_non_negative_ck CHECK (attempts >= 0),
        CONSTRAINT wager_no_self_reference_ck CHECK (reference_transaction_id <> id),

        CONSTRAINT wager_failure_code_states_ck CHECK (
          (failure_code IS NOT NULL) = (status IN ('REJECTED', 'FAILED'))
        ),

        CONSTRAINT wager_infrastructure_failure_ck CHECK (
          (status = 'FAILED' AND failure_code = 'INFRASTRUCTURE_FAILURE')
          OR (status <> 'FAILED'
              AND (failure_code IS NULL OR failure_code <> 'INFRASTRUCTURE_FAILURE'))
        ),

        CONSTRAINT wager_processed_at_states_ck CHECK (
          (processed_at IS NOT NULL) = (status IN ('PROCESSED', 'REJECTED', 'FAILED'))
        ),

        CONSTRAINT wager_result_balance_pair_ck CHECK (
          (result_balance_amount IS NULL) = (result_balance_currency IS NULL)
        ),

        CONSTRAINT wager_result_balance_non_negative_ck CHECK (
          result_balance_amount IS NULL OR result_balance_amount >= 0
        ),

        CONSTRAINT wager_result_balance_presence_ck CHECK (
          CASE
            WHEN status = 'PENDING' THEN result_balance_amount IS NULL
            WHEN status = 'REJECTED' AND failure_code = 'WALLET_NOT_FOUND'
              THEN result_balance_amount IS NULL
            ELSE result_balance_amount IS NOT NULL
          END
        ),

        CONSTRAINT wager_result_balance_currency_ck CHECK (
          result_balance_currency IS NULL
          OR result_balance_currency = currency
          OR failure_code = 'CURRENCY_MISMATCH'
        ),

        CONSTRAINT wager_reference_external_by_kind_ck CHECK (
          CASE
            WHEN kind IN ('REFUND', 'ROLLBACK')
              THEN reference_external_transaction_id IS NOT NULL
            WHEN kind = 'WIN' THEN TRUE
            ELSE reference_external_transaction_id IS NULL
          END
        ),

        CONSTRAINT wager_reference_resolved_ck CHECK (
          status <> 'PROCESSED'
          OR kind NOT IN ('REFUND', 'ROLLBACK')
          OR reference_transaction_id IS NOT NULL
        ),

        CONSTRAINT wager_pending_reference_ck CHECK (
          status <> 'PENDING_REFERENCE'
          OR (kind IN ('REFUND', 'ROLLBACK')
              AND reference_transaction_id IS NULL
              AND next_attempt_at IS NOT NULL
              AND expires_at IS NOT NULL)
        )
      );
    `);

    this.addSql(`
      COMMENT ON COLUMN wager_transaction.result_balance_currency IS
        'Moeda da wallet observada, não a da operação. Em CURRENCY_MISMATCH as duas diferem por definição.';
    `);

    // Opção B (README §7 regra 4): unicidade por (referência, kind), então a
    // mesma referência aceita um REFUND e um ROLLBACK. Não é bug.
    this.addSql(`
      CREATE UNIQUE INDEX wager_reversal_once_per_kind_uq
        ON wager_transaction (reference_transaction_id, kind)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK');
    `);

    this.addSql(`
      CREATE INDEX wager_pending_due_ix
        ON wager_transaction (next_attempt_at, id)
        WHERE status = 'PENDING_REFERENCE';
    `);

    this.addSql(`
      CREATE TABLE wallet_ledger_entry (
        id              uuid             NOT NULL,
        wallet_id       uuid             NOT NULL,
        transaction_id  uuid             NOT NULL,
        direction       ledger_direction NOT NULL,
        amount          numeric(20,2)    NOT NULL,
        currency        char(3)          NOT NULL,
        balance_before  numeric(20,2)    NOT NULL,
        balance_after   numeric(20,2)    NOT NULL,
        created_at      timestamptz      NOT NULL,

        CONSTRAINT wallet_ledger_entry_pk PRIMARY KEY (id),
        CONSTRAINT ledger_transaction_wallet_uq UNIQUE (transaction_id, wallet_id),

        CONSTRAINT ledger_wallet_fk
          FOREIGN KEY (wallet_id, currency)
          REFERENCES wallet (id, currency) ON DELETE RESTRICT,

        CONSTRAINT ledger_transaction_fk
          FOREIGN KEY (transaction_id)
          REFERENCES wager_transaction (id) ON DELETE RESTRICT,

        CONSTRAINT ledger_amount_positive_ck CHECK (amount > 0),
        CONSTRAINT ledger_currency_iso_ck CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT ledger_balance_before_non_negative_ck CHECK (balance_before >= 0),
        CONSTRAINT ledger_balance_after_non_negative_ck CHECK (balance_after >= 0),

        CONSTRAINT ledger_arithmetic_ck CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount)
          OR (direction = 'DEBIT' AND balance_after = balance_before - amount)
        )
      );
    `);

    this.addSql(`
      CREATE INDEX ledger_wallet_keyset_ix
        ON wallet_ledger_entry (wallet_id, created_at DESC, id DESC);
    `);

    this.addSql(`
      CREATE TABLE inbox_message (
        consumer_name     varchar(64)  NOT NULL,
        message_id        varchar(128) NOT NULL,
        payload_hash      char(64)     NOT NULL,
        broker_message_id varchar(128),
        received_at       timestamptz  NOT NULL,
        processed_at      timestamptz,

        CONSTRAINT inbox_message_pk PRIMARY KEY (consumer_name, message_id),
        CONSTRAINT inbox_processed_after_received_ck CHECK (
          processed_at IS NULL OR processed_at >= received_at
        )
      );
    `);

    this.addSql(`
      CREATE TABLE outbox_message (
        id              uuid         NOT NULL,
        event_id        uuid         NOT NULL,
        aggregate_id    varchar(128) NOT NULL,
        event_type      varchar(64)  NOT NULL,
        payload         jsonb        NOT NULL,
        occurred_at     timestamptz  NOT NULL,
        attempts        integer      NOT NULL DEFAULT 0,
        next_attempt_at timestamptz  NOT NULL,
        claimed_by      varchar(64),
        claimed_until   timestamptz,
        last_error      text,
        published_at    timestamptz,

        CONSTRAINT outbox_message_pk PRIMARY KEY (id),
        CONSTRAINT outbox_event_id_uq UNIQUE (event_id),
        CONSTRAINT outbox_attempts_non_negative_ck CHECK (attempts >= 0),
        CONSTRAINT outbox_claim_pair_ck CHECK (
          (claimed_by IS NULL) = (claimed_until IS NULL)
        )
      );
    `);

    this.addSql(`
      CREATE INDEX outbox_pending_ix
        ON outbox_message (next_attempt_at, claimed_until, occurred_at, id)
        WHERE published_at IS NULL;
    `);

    this.addSql(`
      CREATE FUNCTION wallet_ledger_entry_guard() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entry is immutable: % is not allowed', TG_OP
          USING ERRCODE = '0A000';
      END;
      $$ LANGUAGE plpgsql;
    `);

    this.addSql(`
      CREATE TRIGGER wallet_ledger_entry_immutable_tg
        BEFORE UPDATE OR DELETE ON wallet_ledger_entry
        FOR EACH ROW EXECUTE FUNCTION wallet_ledger_entry_guard();
    `);

    this.addSql(`
      CREATE TRIGGER wallet_ledger_entry_no_truncate_tg
        BEFORE TRUNCATE ON wallet_ledger_entry
        FOR EACH STATEMENT EXECUTE FUNCTION wallet_ledger_entry_guard();
    `);

    this.addSql(`
      CREATE FUNCTION wager_transaction_guard() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wager_transaction is append-only: DELETE is not allowed (id=%)', OLD.id
            USING ERRCODE = '0A000';
        END IF;

        IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
          RAISE EXCEPTION 'wager_transaction % is terminal (%): UPDATE is not allowed', OLD.id, OLD.status
            USING ERRCODE = '0A000';
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    this.addSql(`
      CREATE TRIGGER wager_transaction_guard_tg
        BEFORE UPDATE OR DELETE ON wager_transaction
        FOR EACH ROW EXECUTE FUNCTION wager_transaction_guard();
    `);

    this.addSql(`
      CREATE FUNCTION inbox_message_guard() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'inbox_message is append-only: DELETE is not allowed'
            USING ERRCODE = '0A000';
        END IF;

        IF NEW.consumer_name <> OLD.consumer_name
           OR NEW.message_id <> OLD.message_id
           OR NEW.payload_hash <> OLD.payload_hash
           OR NEW.received_at <> OLD.received_at THEN
          RAISE EXCEPTION 'inbox_message identity is immutable'
            USING ERRCODE = '0A000';
        END IF;

        IF OLD.processed_at IS NOT NULL
           AND NEW.processed_at IS DISTINCT FROM OLD.processed_at THEN
          RAISE EXCEPTION 'inbox_message %/% is already processed', OLD.consumer_name, OLD.message_id
            USING ERRCODE = '0A000';
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    this.addSql(`
      CREATE TRIGGER inbox_message_guard_tg
        BEFORE UPDATE OR DELETE ON inbox_message
        FOR EACH ROW EXECUTE FUNCTION inbox_message_guard();
    `);

    this.addSql(`GRANT SELECT, INSERT ON wallet TO wagering_app;`);
    this.addSql(`GRANT UPDATE (balance, version, updated_at) ON wallet TO wagering_app;`);

    this.addSql(`GRANT SELECT, INSERT ON wager_transaction TO wagering_app;`);
    this.addSql(`
      GRANT UPDATE (
        status, failure_code, processed_at, reference_transaction_id,
        result_balance_amount, result_balance_currency, attempts, next_attempt_at
      ) ON wager_transaction TO wagering_app;
    `);

    this.addSql(`GRANT SELECT, INSERT ON wallet_ledger_entry TO wagering_app;`);

    this.addSql(`GRANT SELECT, INSERT ON inbox_message TO wagering_app;`);
    this.addSql(`GRANT UPDATE (processed_at) ON inbox_message TO wagering_app;`);

    this.addSql(`GRANT SELECT, INSERT ON outbox_message TO wagering_app;`);
    this.addSql(`
      GRANT UPDATE (
        attempts, next_attempt_at, claimed_by, claimed_until, last_error, published_at
      ) ON outbox_message TO wagering_app;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TRIGGER IF EXISTS inbox_message_guard_tg ON inbox_message;`);
    this.addSql(`DROP TRIGGER IF EXISTS wager_transaction_guard_tg ON wager_transaction;`);
    this.addSql(`DROP TRIGGER IF EXISTS wallet_ledger_entry_no_truncate_tg ON wallet_ledger_entry;`);
    this.addSql(`DROP TRIGGER IF EXISTS wallet_ledger_entry_immutable_tg ON wallet_ledger_entry;`);

    this.addSql(`DROP FUNCTION IF EXISTS inbox_message_guard();`);
    this.addSql(`DROP FUNCTION IF EXISTS wager_transaction_guard();`);
    this.addSql(`DROP FUNCTION IF EXISTS wallet_ledger_entry_guard();`);

    this.addSql(`DROP TABLE IF EXISTS outbox_message;`);
    this.addSql(`DROP TABLE IF EXISTS inbox_message;`);
    this.addSql(`DROP TABLE IF EXISTS wallet_ledger_entry;`);
    this.addSql(`DROP TABLE IF EXISTS wager_transaction;`);
    this.addSql(`DROP TABLE IF EXISTS wallet;`);

    this.addSql(`DROP TYPE IF EXISTS wager_failure_code;`);
    this.addSql(`DROP TYPE IF EXISTS ledger_direction;`);
    this.addSql(`DROP TYPE IF EXISTS wager_transaction_status;`);
    this.addSql(`DROP TYPE IF EXISTS wager_transaction_kind;`);
  }
}
