/**
 * What the module puts in `runtimeConfig.public.magpie` for the plugins to read. It lives with the runtime code, not the
 * module, because the built runtime files must be able to import it.
 */
export interface PublicConfig {
    /** Empty when none was known at build time; then NUXT_PUBLIC_MAGPIE_DSN supplies it at runtime. */
    dsn: string;
    environment: string;
    release?: string;
    tracesSampleRate?: number;
    sampleRate?: number;
    sendDefaultPii?: boolean;
    debug?: boolean;
    ignoreErrors?: string[];
    tracePropagationTargets?: string[];
    client: boolean;
    server: boolean;
}
