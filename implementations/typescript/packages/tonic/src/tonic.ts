import type { AssignmentEvent } from '@aeon/aes';
import type { AnnotationRecord } from '@aeon/annotation-stream';

export interface TonicInput {
  readonly aes: readonly AssignmentEvent[];
  readonly annotations?: readonly AnnotationRecord[];
}

export interface TonicResult {
  readonly aes: readonly AssignmentEvent[];
  readonly annotations?: readonly AnnotationRecord[];
  readonly document?: unknown;
  readonly meta?: {
    readonly errors?: readonly { readonly message: string; readonly code?: string }[];
    readonly warnings?: readonly { readonly message: string; readonly code?: string }[];
  };
}

export function materialize(input: TonicInput): TonicResult {
  const result: TonicResult = {
    aes: input.aes,
  };
  if (input.annotations) {
    (result as { annotations: readonly AnnotationRecord[] }).annotations = input.annotations;
  }
  return result;
}
