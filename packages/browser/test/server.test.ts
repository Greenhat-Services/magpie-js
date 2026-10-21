import { describe, expect, it } from 'vitest';
import { init } from '../src';

describe('init on the server', () => {
    it('does nothing without a window, so one entry file works in a server-rendered app', () => {
        expect(typeof window).toBe('undefined');
        expect(init({ dsn: 'https://k@ingest.test/1' })).toBeUndefined();
    });
});
