import type {
	AttributeValue,
	SpanAttributes,
	SpanOptions,
	SpanStatus,
	TelemetryContext,
	TelemetrySpan,
} from "./index.ts";
import type {
	HistogramOptions,
	InstrumentOptions,
	TelemetryCounter,
	TelemetryHistogram,
	TelemetryMetrics,
	TelemetryUpDownCounter,
} from "./metrics.ts";
import { NOOP_TELEMETRY_CONTEXT } from "./noop.ts";

export type TelemetryCarrier = Readonly<Record<string, string>>;

export interface RecordedTelemetryEvent {
	readonly name: string;
	readonly attributes: Readonly<SpanAttributes>;
}

export interface RecordedTelemetryMeasurement {
	readonly kind: "counter" | "upDownCounter" | "histogram";
	readonly name: string;
	readonly description?: string;
	readonly unit?: string;
	readonly boundaries?: readonly number[];
	readonly value: number;
	readonly attributes: Readonly<SpanAttributes>;
	readonly context: TelemetryCarrier | null;
}

export interface RecordedTelemetrySpan {
	readonly id: number;
	readonly parentId: number | null;
	readonly context: TelemetryCarrier;
	readonly name: string;
	readonly attributes: Readonly<SpanAttributes>;
	readonly events: readonly RecordedTelemetryEvent[];
	readonly status: SpanStatus;
	readonly settled: boolean;
	readonly endSequence?: number;
}

interface MutableRecordedTelemetryEvent {
	name: string;
	attributes: SpanAttributes;
}

interface MutableRecordedTelemetrySpan {
	id: number;
	parentId: number | null;
	context: TelemetryCarrier;
	name: string;
	attributes: SpanAttributes;
	events: MutableRecordedTelemetryEvent[];
	status: SpanStatus;
	explicitStatus: boolean;
	settled: boolean;
	endSequence?: number;
}

interface InMemoryTelemetryState {
	metrics: TelemetryMetrics;
	scope: string;
	spans: MutableRecordedTelemetrySpan[];
	measurements: RecordedTelemetryMeasurement[];
	nextSpanId: number;
	nextEndSequence: number;
}

const contextCarriers = new WeakMap<TelemetryContext, TelemetryCarrier>();

function copyAttributeValue(value: AttributeValue): AttributeValue {
	return Array.isArray(value) ? ([...value] as AttributeValue) : value;
}

function copyAttributes(attributes?: SpanAttributes): SpanAttributes {
	const copy: SpanAttributes = {};
	if (!attributes) return copy;
	for (const [name, value] of Object.entries(attributes)) {
		if (value !== undefined) copy[name] = copyAttributeValue(value);
	}
	return copy;
}

function mergeAttributes(current: SpanAttributes, attributes: SpanAttributes): SpanAttributes {
	const merged = copyAttributes(current);
	for (const [name, value] of Object.entries(attributes)) {
		if (value !== undefined) merged[name] = copyAttributeValue(value);
	}
	return merged;
}

function copyStatus(status: SpanStatus): SpanStatus {
	if (status.status === "ok") return { status: "ok" };
	return status.error
		? { status: "error", error: { name: status.error.name, message: status.error.message } }
		: { status: "error" };
}

function automaticErrorStatus(error: unknown): SpanStatus {
	try {
		if (error instanceof Error) {
			return { status: "error", error: { name: error.name, message: error.message } };
		}
	} catch {
		// Error inspection is passive. Fall through to an error status without details.
	}
	return { status: "error" };
}

function settleSpan(
	state: InMemoryTelemetryState,
	span: MutableRecordedTelemetrySpan,
	failed: boolean,
	error?: unknown,
): void {
	if (span.settled) return;
	if (failed && !span.explicitStatus) span.status = automaticErrorStatus(error);
	span.settled = true;
	span.endSequence = state.nextEndSequence++;
}

function createSpan(
	state: InMemoryTelemetryState,
	parent: MutableRecordedTelemetrySpan | undefined,
	options: SpanOptions,
): MutableRecordedTelemetrySpan {
	const name = options.name;
	const attributes = copyAttributes(options.attributes);
	const id = state.nextSpanId++;
	return {
		id,
		parentId: parent?.id ?? null,
		context: { "tg-memory-scope": state.scope, "tg-memory-span": String(id) },
		name,
		attributes,
		events: [],
		status: { status: "ok" },
		explicitStatus: false,
		settled: false,
	};
}

function createMeasurementRecorder(
	state: InMemoryTelemetryState,
	kind: RecordedTelemetryMeasurement["kind"],
	name: string,
	options?: InstrumentOptions & HistogramOptions,
): (value: number, attributes?: SpanAttributes, context?: TelemetryContext) => void {
	const description = options?.description;
	const unit = options?.unit;
	const boundaries = kind === "histogram" && options?.boundaries !== undefined ? [...options.boundaries] : undefined;
	return (value, attributes, context) => {
		const carrier = context === undefined ? undefined : contextCarriers.get(context);
		state.measurements.push({
			kind,
			name,
			...(description === undefined ? {} : { description }),
			...(unit === undefined ? {} : { unit }),
			...(boundaries === undefined ? {} : { boundaries }),
			value,
			attributes: copyAttributes(attributes),
			context: carrier ? { ...carrier } : null,
		});
	};
}

function startInMemorySpan<T>(
	state: InMemoryTelemetryState,
	parent: MutableRecordedTelemetrySpan | undefined,
	options: SpanOptions,
	callback: (span: TelemetrySpan) => T | Promise<T>,
): Promise<T> {
	if (parent?.settled) return NOOP_TELEMETRY_CONTEXT.startSpan(options, callback);

	let recordedSpan: MutableRecordedTelemetrySpan;
	try {
		recordedSpan = createSpan(state, parent, options);
		state.spans.push(recordedSpan);
	} catch {
		return NOOP_TELEMETRY_CONTEXT.startSpan(options, callback);
	}

	const span: TelemetrySpan = {
		metrics: state.metrics,
		startSpan: <Result>(
			childOptions: SpanOptions,
			childCallback: (child: TelemetrySpan) => Result | Promise<Result>,
		) => startInMemorySpan(state, recordedSpan, childOptions, childCallback),
		addEvent(name, attributes) {
			if (recordedSpan.settled) return;
			try {
				recordedSpan.events.push({ name, attributes: copyAttributes(attributes) });
			} catch {
				// Recording is passive. Ignore malformed or unreadable telemetry payloads.
			}
		},
		setAttributes(attributes) {
			if (recordedSpan.settled) return;
			try {
				recordedSpan.attributes = mergeAttributes(recordedSpan.attributes, attributes);
			} catch {
				// Recording is passive. Ignore malformed or unreadable telemetry payloads.
			}
		},
		setStatus(status) {
			if (recordedSpan.settled) return;
			try {
				recordedSpan.status = copyStatus(status);
				recordedSpan.explicitStatus = true;
			} catch {
				// Recording is passive. Ignore malformed or unreadable telemetry payloads.
			}
		},
	};
	contextCarriers.set(span, recordedSpan.context);

	let result: T | Promise<T>;
	try {
		result = callback(span);
	} catch (error) {
		settleSpan(state, recordedSpan, true, error);
		return Promise.reject(error);
	}

	return Promise.resolve(result).then(
		(value) => {
			settleSpan(state, recordedSpan, false);
			return value;
		},
		(error: unknown) => {
			settleSpan(state, recordedSpan, true, error);
			throw error;
		},
	);
}

/**
 * Backend-neutral reference implementation that records spans in process memory.
 * Create a fresh instance to isolate tests or independent recording scopes.
 */
export class InMemoryTelemetryContext implements TelemetryContext, TelemetryMetrics {
	readonly metrics: TelemetryMetrics = this;
	private readonly state: InMemoryTelemetryState = {
		metrics: this,
		scope: crypto.randomUUID(),
		spans: [],
		measurements: [],
		nextSpanId: 1,
		nextEndSequence: 1,
	};

	startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
		return startInMemorySpan(this.state, undefined, options, callback);
	}

	counter(name: string, options?: InstrumentOptions): TelemetryCounter {
		return { add: createMeasurementRecorder(this.state, "counter", name, options) };
	}

	upDownCounter(name: string, options?: InstrumentOptions): TelemetryUpDownCounter {
		return { add: createMeasurementRecorder(this.state, "upDownCounter", name, options) };
	}

	histogram(name: string, options?: HistogramOptions): TelemetryHistogram {
		return { record: createMeasurementRecorder(this.state, "histogram", name, options) };
	}

	/** Returns detached measurements in recording order, without aggregation. */
	getMetrics(): readonly RecordedTelemetryMeasurement[] {
		return this.state.measurements.map((measurement) => ({
			...measurement,
			...(measurement.boundaries === undefined ? {} : { boundaries: [...measurement.boundaries] }),
			attributes: copyAttributes(measurement.attributes),
			context: measurement.context ? { ...measurement.context } : null,
		}));
	}

	/** Returns detached snapshots in span-start order. */
	getSpans(): readonly RecordedTelemetrySpan[] {
		return this.state.spans.map((span) => ({
			id: span.id,
			parentId: span.parentId,
			context: { ...span.context },
			name: span.name,
			attributes: copyAttributes(span.attributes),
			events: span.events.map((event) => ({
				name: event.name,
				attributes: copyAttributes(event.attributes),
			})),
			status: copyStatus(span.status),
			settled: span.settled,
			...(span.endSequence === undefined ? {} : { endSequence: span.endSequence }),
		}));
	}
}
