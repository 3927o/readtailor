export class UserBookError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 404 | 409 | 503,
  ) {
    super(message);
    this.name = 'UserBookError';
  }
}
