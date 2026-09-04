// Zero rows means the row vanished or a guard trigger refused the write.
// Succeeding silently would leave the aggregate and the database disagreeing.
export class StaleWriteError extends Error {
  constructor(
    readonly table: string,
    readonly id: string,
    readonly affected: number,
  ) {
    super(`expected to update exactly one ${table} row (${id}), updated ${affected}`);
    this.name = new.target.name;
  }
}
