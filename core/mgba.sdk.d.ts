import type { EngineConfig, EngineInstance } from '@wasm-gaming/engine-specs';
import { manifest } from './mgba.manifest.js';
import { type MgbaConfig } from './mgba.config.js';
import { type EscMenuGroup } from './mgba.options.js';
export { manifest };
export type MgbaInstance = EngineInstance & {
    /** Live handle on the emulator settings; writes apply to the running game. */
    config: MgbaConfig;
    /**
     * The option rows for the demo shell's ESC menu, in the shape
     * `@wasm-gaming/engine-specs` (>=0.2.5) renders. Snapshot at call time — read
     * it when the menu opens, not once at boot.
     */
    escMenuGroups(): EscMenuGroup[];
    /** Which core actually booted the ROM. */
    system: 'gba' | 'gb';
};
export declare function load(config: EngineConfig): Promise<MgbaInstance>;
declare const _default: {
    manifest: import("@wasm-gaming/engine-specs").EngineManifest;
    load: typeof load;
};
export default _default;
//# sourceMappingURL=mgba.sdk.d.ts.map