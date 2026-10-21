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

/**
 * Vue's names for where an error happened. Development builds pass these as words; production builds pass a link
 * (`https://vuejs.org/error-reference/#runtime-5`) to save bytes, so the code is turned back into the words here.
 * Numbering is Vue 3.5's `ErrorCodes`; an unknown code is kept as given.
 */
const VUE_ERROR_SITES: Record<string, string> = {
    sp: 'serverPrefetch hook', bc: 'beforeCreate hook', c: 'created hook', bm: 'beforeMount hook', m: 'mounted hook',
    bu: 'beforeUpdate hook', u: 'updated hook', bum: 'beforeUnmount hook', um: 'unmounted hook', a: 'activated hook',
    da: 'deactivated hook', ec: 'errorCaptured hook', rtc: 'renderTracked hook', rtg: 'renderTriggered hook',
    '0': 'setup function', '1': 'render function', '2': 'watcher getter', '3': 'watcher callback', '4': 'watcher cleanup function',
    '5': 'native event handler', '6': 'component event handler', '7': 'vnode hook', '8': 'directive hook', '9': 'transition hook',
    '10': 'app errorHandler', '11': 'app warnHandler', '12': 'ref function', '13': 'async component loader', '14': 'scheduler flush',
    '15': 'component update', '16': 'app unmount cleanup function',
};

export function describeErrorSite(info: string): string {
    const code = /#runtime-([a-z0-9]+)$/i.exec(info)?.[1];

    return (code && VUE_ERROR_SITES[code]) || info;
}

/** Reports an error Vue caught, with the component it came from and the lifecycle step it was in ("setup function", "event handler"). */
export function captureVueError(error: unknown, instance: ComponentPublicInstance | null | undefined, info: string): void {
    const client = getClient();
    if (!client) return;

    client.withScope((scope) => {
        const file = (instance?.$options as { __file?: string } | undefined)?.__file;
        scope.setContext('vue', {
            componentName: componentName(instance),
            lifecycleHook: describeErrorSite(info),
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
