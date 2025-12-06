// https://github.com/mgmeyers/obsidian-kanban/blob/93014c2512507fde9eafd241e8d4368a8dfdf853/src/lang/helpers.ts

import en from "./locale/en";

// https://stackoverflow.com/a/41015840/
function interpolate(str: string, params: Record<string, unknown>): string {
    const names: string[] = Object.keys(params);
    const vals: unknown[] = Object.values(params);
    return new Function(...names, `return \`${str}\`;`)(...vals);
}

export function t(str: keyof typeof en, params?: Record<string, unknown>): string {
    const result = en[str];

    if (params) {
        return interpolate(result, params);
    }

    return result;
}
