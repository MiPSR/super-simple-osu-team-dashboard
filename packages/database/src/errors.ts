export class DatabaseError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
  }
}
