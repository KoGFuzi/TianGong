/**
 * Node-only credential storage. Kept off the root entry point so browser bundles never pull
 * `node:fs` or the file lock into a build that has no filesystem.
 */
export { InMemoryCredentialStore } from "./auth/credential-store.ts";
export {
	FileCredentialStore,
	type FileCredentialStoreOptions,
} from "./auth/credential-store-file.ts";
export type {
	AuthOperationOptions,
	Credential,
	CredentialInfo,
	CredentialStore,
} from "./auth/types.ts";
