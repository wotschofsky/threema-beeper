export interface DirectorySnapshot {
    contacts: {
        identity: string;
        firstName: string;
        lastName: string;
        displayName: string;
        verification: number;
        activity: number;
        blocked: boolean;
    }[];
    groups: {
        groupKey: string;
        creatorIdentity: string;
        groupId: bigint;
        name: string;
        memberIdentities: string[];
        userState: number;
    }[];
}
