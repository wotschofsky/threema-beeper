import type {MatrixClient} from '../../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/MatrixClient.js';

/** Discovery failures block new preparation; an expired limit is never silently reused. */
export class UploadLimits {
    private readonly client: Pick<MatrixClient, 'doesServerSupportVersion' | 'doRequest'>;
    private readonly threema: () => Promise<{maximumBytes: number}>;
    private readonly local: number;
    private readonly clock: () => number;
    private cached?: {value: number; until: number};
    private pending?: Promise<number>;
    constructor(
        client: UploadLimits['client'],
        threema: UploadLimits['threema'],
        local: number,
        clock: () => number = Date.now,
    ) {
        if (!Number.isSafeInteger(local) || local < 1 || local > 1024 ** 3)
            throw new Error('Invalid local media limit');
        this.client = client;
        this.threema = threema;
        this.local = local;
        this.clock = clock;
    }
    async get(): Promise<number> {
        if (this.cached && this.cached.until > this.clock()) return this.cached.value;
        this.pending ??= this.discover().finally(() => {
            this.pending = undefined;
        });
        return this.pending;
    }
    private async discover(): Promise<number> {
        const remote = await this.threema();
        if (!Number.isSafeInteger(remote.maximumBytes) || remote.maximumBytes < 1)
            throw new Error('Invalid Threema media limit');
        const prefix = (await this.client.doesServerSupportVersion('v1.11'))
            ? '/_matrix/client/v1/media'
            : '/_matrix/media/v3';
        const config = await this.client.doRequest('GET', `${prefix}/config`);
        if (!config || typeof config !== 'object' || Array.isArray(config))
            throw new Error('Invalid Matrix media config');
        const matrix = config['m.upload.size'];
        if (matrix !== undefined && (!Number.isSafeInteger(matrix) || matrix < 0))
            throw new Error('Invalid Matrix upload limit');
        const value = Math.min(this.local, remote.maximumBytes, matrix ?? Infinity);
        this.cached = {value, until: this.clock() + 60000};
        return value;
    }
}
