import type { Breadcrumb, Level, MagpieEvent, User } from './types';
import { nowSeconds } from './util';

/** What is attached to every event captured while it is active: tags, user, context and the trail of breadcrumbs. */
export class Scope {
    tags: Record<string, string> = {};
    extra: Record<string, unknown> = {};
    contexts: Record<string, Record<string, unknown>> = {};
    user: User | undefined;
    level: Level | undefined;
    /** The route or job being handled. */
    transactionName: string | undefined;
    fingerprint: string[] | undefined;
    breadcrumbs: Breadcrumb[] = [];

    clone(): Scope {
        const s = new Scope();
        s.tags = { ...this.tags };
        s.extra = { ...this.extra };
        s.contexts = Object.fromEntries(Object.entries(this.contexts).map(([k, v]) => [k, { ...v }]));
        s.user = this.user ? { ...this.user } : undefined;
        s.level = this.level;
        s.transactionName = this.transactionName;
        s.fingerprint = this.fingerprint ? [...this.fingerprint] : undefined;
        s.breadcrumbs = [...this.breadcrumbs];

        return s;
    }

    setTag(key: string, value: string | number | boolean): this {
        this.tags[key] = String(value);

        return this;
    }

    setTags(tags: Record<string, string | number | boolean>): this {
        for (const [k, v] of Object.entries(tags)) this.setTag(k, v);

        return this;
    }

    setExtra(key: string, value: unknown): this {
        this.extra[key] = value;

        return this;
    }

    setContext(name: string, context: Record<string, unknown> | null): this {
        if (context === null) delete this.contexts[name];
        else this.contexts[name] = context;

        return this;
    }

    setUser(user: User | null): this {
        this.user = user ?? undefined;

        return this;
    }

    setLevel(level: Level | undefined): this {
        this.level = level;

        return this;
    }

    setTransactionName(name: string | undefined): this {
        this.transactionName = name;

        return this;
    }

    setFingerprint(fingerprint: string[] | undefined): this {
        this.fingerprint = fingerprint;

        return this;
    }

    /** Appends a breadcrumb, dropping the oldest once `max` is reached so memory stays bounded. */
    addBreadcrumb(breadcrumb: Breadcrumb, max: number): this {
        this.breadcrumbs.push({ timestamp: nowSeconds(), ...breadcrumb });
        if (this.breadcrumbs.length > max) this.breadcrumbs.splice(0, this.breadcrumbs.length - max);

        return this;
    }

    clear(): this {
        this.tags = {};
        this.extra = {};
        this.contexts = {};
        this.user = undefined;
        this.level = undefined;
        this.transactionName = undefined;
        this.fingerprint = undefined;
        this.breadcrumbs = [];

        return this;
    }

    /** What the event already carries wins over the scope, so a more specific value is never overwritten. */
    applyTo(event: MagpieEvent): MagpieEvent {
        if (Object.keys(this.tags).length) event.tags = { ...this.tags, ...event.tags };
        if (Object.keys(this.extra).length) event.extra = { ...this.extra, ...event.extra };
        if (Object.keys(this.contexts).length) {
            event.contexts = { ...this.contexts, ...event.contexts };
        }
        if (this.user) event.user = { ...this.user, ...event.user };
        if (this.level && !event.level) event.level = this.level;
        if (this.transactionName && !event.transaction) event.transaction = this.transactionName;
        if (this.fingerprint && !event.fingerprint) event.fingerprint = [...this.fingerprint];
        if (this.breadcrumbs.length) event.breadcrumbs = [...this.breadcrumbs, ...(event.breadcrumbs ?? [])];

        return event;
    }
}
