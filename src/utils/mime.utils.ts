export function mimeConfig<T extends Readonly<Record<string, string>>>(map: T) {
    return {
        map,
        allowed: new Set(Object.keys(map)),
        extensions: Object.values(map) as T[keyof T][],
    } as const;
}
