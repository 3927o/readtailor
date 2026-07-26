/** Defines cache keys for the remaining user-book detail resources. */

export const userBookQueryKeys = {
  all: ['user-book'] as const,
  detail: (userBookId: string) => ['user-book', userBookId] as const,
};
