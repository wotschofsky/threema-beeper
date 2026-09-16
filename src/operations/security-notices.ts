import {createHash} from 'node:crypto';
import {parseSecurityScanState, type SecurityScanState} from './security-scan.ts';

export class SecurityNotices {
    private readonly options: {
        owner: string;
        ready: () => boolean;
        load: () => Promise<SecurityScanState | undefined>;
        delivered: (id: string) => boolean;
        authorize: () => Promise<string>;
        send: (id: string, room: string, content: Record<string, unknown>) => Promise<unknown>;
    };
    constructor(options: SecurityNotices['options']) { this.options = options; }
    async drain(): Promise<number> {
        if (!this.options.ready()) return 0;
        const loaded = await this.options.load();
        if (!loaded) return 0;
        const {pending} = parseSecurityScanState(loaded);
        if (!pending) return 0;
        const id = 'security_' + createHash('sha256').update(JSON.stringify([
            this.options.owner, pending,
        ])).digest('hex');
        if (this.options.delivered(id) || !this.options.ready()) return 0;
        const room = await this.options.authorize();
        if (!this.options.ready()) return 0;
        // Pending content survives recovery unchanged, preserving encrypted retry identity.
        const body = pending.kind === 'failed'
            ? 'A scheduled Threema bridge dependency scan failed. Check threema-security-check.service logs, scanner database freshness, storage and network access. A later scan may have recovered; verify the latest scan result.'
            : `A Threema bridge dependency scan found ${pending.count} new or increased-severity package findings. Review the latest local scan reports and threema-security-check.service logs. Findings need applicability review; no update has been installed automatically.`;
        await this.options.send(id, room, {msgtype: 'm.notice', body});
        return 1;
    }
}
