export type { EntryTransformSpec, FinalTransformSpec } from "../schemas";

export interface EntryTransformOptions {
  allowMultipartFormData?: boolean;
  signal?: AbortSignal;
}
