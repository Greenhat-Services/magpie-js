import type { Client, Integration } from '@greenhat-services/magpie-core';

/**
 * Reports what the process did not catch. Adding a listener for either event removes Node's own reaction to it (print
 * and exit), so after reporting, that reaction is restored unless something else in the process is handling it.
 */
export function processHandlers(): Integration {
    return {
        name: 'ProcessHandlers',
        setup(client: Client) {
            const onUncaught = (error: Error) => {
                client.captureException(error, { mechanism: { type: 'onuncaughtexception', handled: false } });

                void client.flush(2000).finally(() => {
                    if (process.listenerCount('uncaughtException') <= 1) {
                        console.error(error);
                        process.exit(1);
                    }
                });
            };

            const onRejection = (reason: unknown) => {
                client.captureException(reason, { mechanism: { type: 'onunhandledrejection', handled: false } });

                // Node's default since v15 is to raise an unhandled rejection as an uncaught exception. Keep it, so a
                // server that crashed before Magpie still crashes (and the crash is already reported).
                if (process.listenerCount('unhandledRejection') <= 1) {
                    setImmediate(() => {
                        throw reason instanceof Error ? reason : new Error(`Unhandled promise rejection: ${String(reason)}`);
                    });
                }
            };

            process.on('uncaughtException', onUncaught);
            process.on('unhandledRejection', onRejection);

            return () => {
                process.off('uncaughtException', onUncaught);
                process.off('unhandledRejection', onRejection);
            };
        },
    };
}
