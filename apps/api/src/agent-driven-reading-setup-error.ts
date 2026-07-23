/** Defines application errors exposed by the agent-driven reading-setup boundary. */

export class AgentDrivenReadingSetupError extends Error {
  constructor(message: string, readonly statusCode: 400 | 404 | 409 | 503) {
    super(message);
    this.name = 'AgentDrivenReadingSetupError';
  }
}
