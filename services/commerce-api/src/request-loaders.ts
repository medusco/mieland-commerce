import { AsyncLocalStorage } from "node:async_hooks";
import type DataLoader from "dataloader";
import type { AttachmentMedia } from "./repositories/products.js";

/** Request-scoped loaders for repository helpers that lack GraphQL context. */
export type RequestLoaders = {
  attachmentLoader: DataLoader<number, AttachmentMedia | null>;
};

const requestLoaders = new AsyncLocalStorage<RequestLoaders>();

/** Active request attachment loader, if any (GraphQL requests via buildContext). */
export function getRequestAttachmentLoader():
  | DataLoader<number, AttachmentMedia | null>
  | undefined {
  return requestLoaders.getStore()?.attachmentLoader;
}

/** Run `fn` with a request-scoped attachment loader (tests + non-Yoga entrypoints). */
export function runWithAttachmentLoader<T>(
  attachmentLoader: DataLoader<number, AttachmentMedia | null>,
  fn: () => T,
): T {
  return requestLoaders.run({ attachmentLoader }, fn);
}

/** Bind loaders for the remainder of the current async request (Yoga context). */
export function enterRequestLoaders(loaders: RequestLoaders): void {
  requestLoaders.enterWith(loaders);
}
