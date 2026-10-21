import { Client, type Integration, type Options, setClient, getClient } from '@greenhat-services/magpie-core';
import { isolatePerRequest } from './context';
import { processHandlers } from './handlers';
import { nodeHttp } from './http';
import { defaultServerName, nodeRuntime } from './runtime';

export * from '@greenhat-services/magpie-core';
export { currentStore, isolatePerRequest, runWithRequest, storage } from './context';
export { processHandlers } from './handlers';
export { nodeHttp } from './http';
export { trackRequest, type RequestHandle, type RequestInfo } from './request';
export { nodeTransport } from './transport';

export interface NodeOptions extends Options {
    /** Report uncaught exceptions and unhandled rejections. Default true. */
    captureUnhandled?: boolean;
    /** Time and propagate the server's own `fetch` calls. Default true. */
    http?: boolean;
    sdkName?: string;
}

/**
 * Starts Magpie on a server. Per-request data (scope, transaction, the request) is isolated with AsyncLocalStorage, so
 * use `trackRequest` around each request the framework handles.
 */
export function init(options: NodeOptions = {}): Client {
    const previous = getClient();
    if (previous) void previous.close(0);

    const { captureUnhandled = true, http = true, sdkName, integrations = [], ...rest } = options;

    const client = new Client(
        { serverName: defaultServerName(), ...rest, release: rest.release ?? process.env.MAGPIE_RELEASE },
        nodeRuntime({ sdkName }),
    );

    isolatePerRequest(client);
    setClient(client);

    const defaults: Integration[] = [...(captureUnhandled ? [processHandlers()] : []), ...(http ? [nodeHttp()] : [])];
    client.setupIntegrations([...defaults, ...integrations]);

    return client;
}
