import {createHash} from 'node:crypto';
import {parseBackupStatus, type BackupStatus} from '../backup/status.ts';

export class BackupNotices {
    private readonly options: {
        owner: string;
        ready: () => boolean;
        load: () => Promise<BackupStatus | undefined>;
        delivered: (id: string) => boolean;
        authorize: () => Promise<string>;
        send: (id: string, room: string, content: Record<string, unknown>) => Promise<unknown>;
    };
    constructor(options: BackupNotices['options']) { this.options = options; }

    async drain(): Promise<number> {
        if (!this.options.ready()) return 0;
        const loaded = await this.options.load();
        if (!loaded) return 0;
        const state = parseBackupStatus(loaded);
        if (!state.incident) return 0;
        const id = 'backup_' + createHash('sha256').update(JSON.stringify([
            this.options.owner, state.incident,
        ])).digest('hex');
        if (this.options.delivered(id) || !this.options.ready()) return 0;
        const room = await this.options.authorize();
        if (!this.options.ready()) return 0;
        // Fixed content across recovery/lost responses preserves encrypted retry identity.
        await this.options.send(id, room, {msgtype: 'm.notice', body:
            'A scheduled Threema bridge backup or its service restart failed. Check threema-backup.service logs, available storage, backup access and bridge status. A later attempt may have recovered; verify the latest backup before relying on it.'});
        return 1;
    }
}
