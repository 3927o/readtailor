export const userBookQueryKeys = {
  all: ['user-book'] as const,
  detail: (userBookId: string) => ['user-book', userBookId] as const,
  interview: (userBookId: string) => ['user-book', userBookId, 'interview'] as const,
  strategies: (userBookId: string) => ['user-book', userBookId, 'strategy'] as const,
  strategy: (userBookId: string, draftId: string) => [
    'user-book',
    userBookId,
    'strategy',
    draftId,
  ] as const,
  trials: (userBookId: string) => ['user-book', userBookId, 'trial'] as const,
  trial: (userBookId: string, trialRevisionId: string) => [
    'user-book',
    userBookId,
    'trial',
    trialRevisionId,
  ] as const,
  readingSetupOperations: (userBookId: string) => [
    'user-book',
    userBookId,
    'reading-setup-operation',
  ] as const,
  currentReadingSetupOperation: (userBookId: string) => [
    'user-book',
    userBookId,
    'reading-setup-operation',
    'current',
  ] as const,
  readingSetupOperation: (userBookId: string, operationId: string) => [
    'user-book',
    userBookId,
    'reading-setup-operation',
    operationId,
  ] as const,
};
