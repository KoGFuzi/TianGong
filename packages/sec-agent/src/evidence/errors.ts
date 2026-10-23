/** The evidence set was changed by someone else — the optimistic-lock version no longer matches. */
export class TgSecEvidenceConflictError extends Error {
	constructor() {
		super("evidence changed since it was read; re-read the evidence set and retry");
		this.name = "TgSecEvidenceConflictError";
	}
}

/** The named subject has no evidence set to lock. */
export class TgSecEvidenceSubjectNotFoundError extends Error {
	constructor() {
		super("no evidence set exists for this subject");
		this.name = "TgSecEvidenceSubjectNotFoundError";
	}
}

/** A snapshot or binding the caller named is not present. */
export class TgSecEvidenceNotFoundError extends Error {
	constructor() {
		super("the referenced evidence is not present");
		this.name = "TgSecEvidenceNotFoundError";
	}
}

/** A stored snapshot's id does not match its metadata — the row was tampered with or corrupted. */
export class TgSecEvidenceHashMismatchError extends Error {
	constructor(id: string) {
		super(`evidence snapshot ${id} does not match its own metadata hash`);
		this.name = "TgSecEvidenceHashMismatchError";
	}
}
