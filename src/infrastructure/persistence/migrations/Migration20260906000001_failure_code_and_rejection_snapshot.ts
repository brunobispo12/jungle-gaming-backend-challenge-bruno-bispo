import { Migration } from '@mikro-orm/migrations';

const FAILURE_CODES_V1 = [
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
  'INFRASTRUCTURE_FAILURE',
];

const FAILURE_CODES_V2 = [...FAILURE_CODES_V1, 'BALANCE_LIMIT_EXCEEDED'];

function enumLiterals(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

// ALTER TYPE ... ADD VALUE cannot be undone, and down() has to give the same
// schema back, so both directions rebuild the type and the checks that read it.
function swapFailureCodeType(target: readonly string[], hiddenBalance: readonly string[]): string[] {
  return [
    `ALTER TABLE wager_transaction DROP CONSTRAINT wager_failure_code_states_ck;`,
    `ALTER TABLE wager_transaction DROP CONSTRAINT wager_infrastructure_failure_ck;`,
    `ALTER TABLE wager_transaction DROP CONSTRAINT wager_result_balance_presence_ck;`,
    `ALTER TABLE wager_transaction DROP CONSTRAINT wager_result_balance_currency_ck;`,

    `ALTER TYPE wager_failure_code RENAME TO wager_failure_code_previous;`,
    `CREATE TYPE wager_failure_code AS ENUM (${enumLiterals(target)});`,
    `ALTER TABLE wager_transaction
       ALTER COLUMN failure_code TYPE wager_failure_code
       USING failure_code::text::wager_failure_code;`,
    `DROP TYPE wager_failure_code_previous;`,

    `ALTER TABLE wager_transaction ADD CONSTRAINT wager_failure_code_states_ck CHECK (
       (failure_code IS NOT NULL) = (status IN ('REJECTED', 'FAILED'))
     );`,
    `ALTER TABLE wager_transaction ADD CONSTRAINT wager_infrastructure_failure_ck CHECK (
       (status = 'FAILED' AND failure_code = 'INFRASTRUCTURE_FAILURE')
       OR (status <> 'FAILED'
           AND (failure_code IS NULL OR failure_code <> 'INFRASTRUCTURE_FAILURE'))
     );`,
    `ALTER TABLE wager_transaction ADD CONSTRAINT wager_result_balance_presence_ck CHECK (
       CASE
         WHEN status = 'PENDING' THEN result_balance_amount IS NULL
         WHEN status = 'REJECTED' AND failure_code IN (${enumLiterals(hiddenBalance)})
           THEN result_balance_amount IS NULL
         ELSE result_balance_amount IS NOT NULL
       END
     );`,
    `ALTER TABLE wager_transaction ADD CONSTRAINT wager_result_balance_currency_ck CHECK (
       result_balance_currency IS NULL
       OR result_balance_currency = currency
       OR failure_code = 'CURRENCY_MISMATCH'
     );`,
  ];
}

export class Migration20260906000001_failure_code_and_rejection_snapshot extends Migration {
  // WALLET_PLAYER_MISMATCH joins WALLET_NOT_FOUND in carrying no snapshot: the
  // balance of a wallet the caller has no claim over must not leave the system.
  override async up(): Promise<void> {
    for (const statement of swapFailureCodeType(FAILURE_CODES_V2, [
      'WALLET_NOT_FOUND',
      'WALLET_PLAYER_MISMATCH',
    ])) {
      this.addSql(statement);
    }
  }

  override async down(): Promise<void> {
    for (const statement of swapFailureCodeType(FAILURE_CODES_V1, ['WALLET_NOT_FOUND'])) {
      this.addSql(statement);
    }
  }
}
