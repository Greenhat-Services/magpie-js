import { parseStack } from './stack';
import type { ExceptionValue, Frame, Mechanism } from './types';
import { normalize, truncate } from './util';

const MAX_VALUE = 8192;
const MAX_FRAMES = 100;
const MAX_CAUSES = 5;

export interface ExceptionOptions {
    mechanism: Mechanism;
    inApp?: (filename: string) => boolean;
}

/**
 * The exception values for a thrown thing, oldest cause first so the last entry is what was actually thrown (the
 * order Magpie reads). An `Error`'s `cause` chain becomes earlier entries. Anything that is not an Error (a string, an
 * object, `undefined`) is still reported, with a message that says what it was.
 */
export function exceptionValues(thrown: unknown, options: ExceptionOptions): { values: ExceptionValue[]; extra?: Record<string, unknown> } {
    const chain: unknown[] = [];
    let current: unknown = thrown;

    while (chain.length <= MAX_CAUSES && current !== undefined && current !== null) {
        chain.push(current);
        current = isError(current) ? (current as { cause?: unknown }).cause : undefined;
        if (chain.includes(current)) break;
    }

    if (chain.length === 0) chain.push(thrown);

    let extra: Record<string, unknown> | undefined;

    const values = chain.map((item, i) => {
        // Only the thrown value (first in the chain) gets the mechanism; its causes were handled by whoever wrapped them.
        const mechanism = i === 0 ? options.mechanism : { type: 'chained', handled: options.mechanism.handled };

        if (isError(item)) return fromError(item as Error, mechanism, options.inApp);

        const described = describeNonError(item);
        if (i === 0) extra = { thrown: normalize(item) };

        return { type: described.type, value: described.value, mechanism, stacktrace: { frames: [] } } satisfies ExceptionValue;
    });

    return { values: values.reverse(), extra };
}

export function fromError(error: Error, mechanism: Mechanism, inApp?: (filename: string) => boolean): ExceptionValue {
    const frames: Frame[] = parseStack(error.stack, inApp).reverse();

    return {
        type: truncate(errorName(error), 200),
        value: truncate(String(error.message ?? ''), MAX_VALUE),
        mechanism,
        // Oldest first, and the innermost frames are the ones worth keeping when there are too many.
        stacktrace: { frames: frames.slice(-MAX_FRAMES) },
    };
}

export function isError(value: unknown): boolean {
    if (value instanceof Error) return true;
    const tag = Object.prototype.toString.call(value);

    return tag === '[object Error]' || tag === '[object Exception]' || tag === '[object DOMException]';
}

function errorName(error: Error): string {
    if (error.name && error.name !== 'Error') return error.name;
    const ctor = (error as { constructor?: { name?: string } }).constructor?.name;

    return ctor && ctor !== 'Object' ? ctor : error.name || 'Error';
}

function describeNonError(value: unknown): { type: string; value: string } {
    if (typeof value === 'string') return { type: 'Error', value: truncate(value, MAX_VALUE) };

    if (value && typeof value === 'object') {
        const message = (value as { message?: unknown }).message;
        if (typeof message === 'string') return { type: 'Error', value: truncate(message, MAX_VALUE) };

        const keys = Object.keys(value).slice(0, 5).join(', ');

        return { type: 'NonErrorException', value: `Non-Error exception captured with keys: ${keys || '[none]'}` };
    }

    return { type: 'NonErrorException', value: `Non-Error value thrown: ${String(value)}` };
}
