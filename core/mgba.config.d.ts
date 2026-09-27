import { type MgbaOptionKey, type MgbaOptionValue } from './mgba.options.js';
/**
 * Pushes a value into the running emulator: an `mCoreConfig` write followed by
 * `reloadConfigOption()`, a canvas style change, a gain node — whatever that
 * option means. Called after the value has been validated and recorded.
 */
export type MgbaApplier = (value: MgbaOptionValue) => void;
/**
 * The appliers the SDK installs for the build it actually loaded. An option
 * with no applier is reported as unsupported and disappears from the menu,
 * which is what keeps this package usable against an `mgba.wasm` built before
 * a given shim setter existed.
 */
export type MgbaAppliers = Partial<Record<MgbaOptionKey, MgbaApplier>>;
/**
 * Typed façade over the emulator's live settings.
 *
 * mGBA does own a configuration object — the `mCoreConfig` embedded in every
 * `mCore` — but it is C-side and the SDK keeps the rest (canvas, audio graph,
 * frame blending) in JS, so `state` is the record both this façade and the
 * running SDK read from, and every write goes through the matching applier.
 */
export interface MgbaConfig {
    supports(key: string): boolean;
    read(key: string): MgbaOptionValue | undefined;
    /** Returns `false` when the key is unknown, unsupported, or the value invalid. */
    write(key: string, value: MgbaOptionValue): boolean;
    /** Current value of every supported option. */
    values(): Record<string, MgbaOptionValue>;
    /** Restores this package's declared defaults. */
    restoreDefaults(): void;
}
export declare function bindConfig(state: Record<string, MgbaOptionValue>, appliers: MgbaAppliers): MgbaConfig;
/** Per-namespace persistence for menu tweaks, so they survive a page reload. */
export interface MgbaSettingsStore {
    load(): Record<string, MgbaOptionValue>;
    save(values: Record<string, MgbaOptionValue>): void;
    clear(): void;
}
export declare function createSettingsStore(namespace: string): MgbaSettingsStore;
//# sourceMappingURL=mgba.config.d.ts.map