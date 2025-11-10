export type RouterErrorCode =
  | 'LOW_CONFIDENCE'
  | 'EMPTY_CHANGES'
  | 'EMPTY_SCOPE'
  | 'SEGMENT_NOT_FOUND'
  | 'SEGMENT_NOT_UNIQUE'
  | 'CONFLICTING_COMMANDS'
  | 'BASELINE_NOT_FOUND'
  | 'SCHEMA_CHANGED';

export class RouterError extends Error {
  public readonly code: RouterErrorCode;

  constructor(code: RouterErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = 'RouterError';
  }
}
