export type PreparedImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/** Fixed canonical policy also applies when recovering older persisted projections. */
export function imageThumbnailType(type: PreparedImageMime): 'image/png' | 'image/jpeg' {
    return type === 'image/png' ? 'image/png' : 'image/jpeg';
}
