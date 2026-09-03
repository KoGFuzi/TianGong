import type { HookName, Hooks } from "./agent-harness.ts";

export interface HookRegistration {
	readonly id: string;
	readonly name: HookName;
	readonly handler: (event: unknown) => unknown | Promise<unknown>;
}

/** Ordered hook registry. Hook errors are surfaced to the caller so the
 * operation layer can apply its documented fault policy. */
export class HarnessHookRegistry implements Hooks {
	private sequence = 0;
	private readonly handlers = new Map<HookName, HookRegistration[]>();
	private closed = false;

	constructor(private readonly closeError: () => Error = () => new Error("HarnessHookRegistry is closed")) {}

	on(
		name: HookName,
		handler: (event: unknown) => unknown | Promise<unknown>,
		options?: { id?: string },
	): () => void {
		if (this.closed) throw this.closeError();
		const registration: HookRegistration = {
			id: options?.id ?? `${name}:${++this.sequence}`,
			name,
			handler,
		};
		const current = this.handlers.get(name) ?? [];
		current.push(registration);
		this.handlers.set(name, current);
		return () => {
			const remaining = (this.handlers.get(name) ?? []).filter((item) => item !== registration);
			if (remaining.length === 0) this.handlers.delete(name);
			else this.handlers.set(name, remaining);
		};
	}

	close(): void {
		this.closed = true;
		this.handlers.clear();
	}

	async run(name: HookName, event: unknown): Promise<unknown[]> {
		const results: unknown[] = [];
		for (const registration of this.handlers.get(name) ?? []) {
			results.push(await registration.handler(structuredClone(event)));
		}
		return results;
	}

	clear(): void {
		this.handlers.clear();
	}
}
