import { captureException, getClient } from '@greenhat-services/magpie-browser';
import type { App, ComponentPublicInstance } from 'vue';

/**
 * Where in the component tree a Vue error happened, in words: `UserCard > UserList > App`. Names only, no props or
 * state, which can hold personal data. Capped so a deep tree stays small.
 */
export function componentHierarchy(instance: ComponentPublicInstance | null | undefined): string[] {
    const names: string[] = [];

    for (let node: ComponentPublicInstance | null | undefined = instance, depth = 0; node && depth < 20; node = node.$parent, depth++) {
        names.push(componentName(node));
    }

    return names;
}

export function componentName(instance: ComponentPublicInstance | null | undefined): string {
    const options = (instance?.$options ?? {}) as { name?: string; __name?: string; __file?: string };
    const file = options.__file?.split(/[\\/]/).pop()?.replace(/\.vue$/, '');

    return options.name || options.__name || file || 'Anonymous';
}

/** Reports an error Vue caught, with the component it came from and the lifecycle step it was in ("setup function", "event handler"). */
export function captureVueError(error: unknown, instance: ComponentPublicInstance | null | undefined, info: string): void {
    const client = getClient();
    if (!client) return;

    client.withScope((scope) => {
        const file = (instance?.$options as { __file?: string } | undefined)?.__file;
        scope.setContext('vue', {
            componentName: componentName(instance),
            lifecycleHook: info,
            hierarchy: componentHierarchy(instance).join(' > '),
            ...(file ? { file: file.split(/[\\/]/).slice(-3).join('/') } : {}),
        });
        scope.setTag('vue.component', componentName(instance));

        captureException(error, { mechanism: { type: 'vue', handled: false } });
    });
}

/**
 * Sets `app.config.errorHandler`, keeping whatever handler the app already had. Vue stops logging errors to the
 * console as soon as a handler exists, so when there was none the error is logged here: Magpie never hides an error
 * from the developer who is looking at the console.
 */
export function attachErrorHandler(app: App): void {
    const previous = app.config.errorHandler;

    app.config.errorHandler = (error, instance, info) => {
        try {
            captureVueError(error, instance, info);
        } catch {
            // Reporting must never be the thing that breaks the app.
        }

        if (previous) previous.call(app, error, instance, info);
        else console.error(error);
    };
}
