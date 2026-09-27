import type { JSONSchema } from '@wasm-gaming/engine-specs';
/**
 * Which core boots the ROM. `auto` lets `mCoreFindVF()` sniff the image, which
 * is right for every well-formed dump; the forced modes exist for headerless
 * or mislabelled files.
 */
export type MgbaSystem = 'auto' | 'gba' | 'gb';
/**
 * Game Boy hardware model, for ROMs the GB core boots. `auto` follows the
 * cartridge header (a CGB-aware cart gets CGB, everything else DMG).
 * Maps to mGBA's `gb.model` config value.
 */
export type MgbaGbModel = 'auto' | 'dmg' | 'sgb' | 'cgb' | 'agb';
/**
 * GBA idle-loop handling (`idleOptimization` in mGBA's config).
 * `remove` skips the busy-waits most games spin in, which is where nearly all
 * of the emulator's speed comes from; `ignore` emulates them cycle for cycle.
 */
export type MgbaIdleOptimization = 'ignore' | 'remove' | 'detect';
export type MgbaLogLevel = 'off' | 'error' | 'debug';
export interface MgbaOptions {
    /** Which core boots the ROM: auto-detected, or forced GBA / Game Boy. */
    system?: MgbaSystem;
    /** Game Boy hardware model. Ignored when the GBA core is running. */
    gbModel?: MgbaGbModel;
    /**
     * Idle-loop optimization for the GBA core. `remove` is mGBA's own default
     * and what makes full speed reachable; `ignore` is the accurate-but-slow
     * setting a handful of games need.
     */
    idleOptimization?: MgbaIdleOptimization;
    /**
     * Skip the BIOS intro. Without a real BIOS this is forced on — the HLE
     * BIOS has no intro to run.
     */
    skipBios?: boolean;
    /**
     * Let the D-pad report left+right (or up+down) at once. Real hardware
     * cannot, and a few games misbehave when it happens.
     */
    allowOpposingDirections?: boolean;
    /** Canvas scaling filter: `pixelated` for crisp pixels, `smooth` for linear. */
    renderFilter?: 'pixelated' | 'smooth';
    /**
     * Presented aspect ratio. `native` is square pixels — 3:2 on GBA, 10:9 on
     * Game Boy — which is what the LCDs actually had; `4:3` fills a TV-shaped
     * frame instead.
     */
    aspect?: 'native' | '4:3';
    /**
     * Blend each frame with the previous one, approximating the ghosting of the
     * original unlit LCD. Some games (and most transparency effects done by
     * flickering) were drawn expecting it.
     */
    interframeBlending?: boolean;
    /** Master audio volume, 0.0–1.0. */
    volume?: number;
    /** Poll connected gamepads (standard mapping) each frame. */
    gamepads?: boolean;
    /** Core messages printed to the console. */
    logLevel?: MgbaLogLevel;
    /** Show the demo shell's in-game settings menu on Escape. Defaults to `true`. */
    escMenu?: boolean;
}
export declare const DEFAULT_MGBA_OPTIONS: Required<MgbaOptions>;
/** Platform ids consumed by `mgbawasm_setup()` (mPLATFORM_* in core/core.h). */
export declare const MGBA_PLATFORM_IDS: Record<MgbaSystem, number>;
/** Values mGBA's `gb.model` config key takes; `auto` means "leave unset". */
export declare const MGBA_GB_MODEL_VALUES: Record<MgbaGbModel, string | null>;
export declare const MGBA_LOG_LEVEL_IDS: Record<MgbaLogLevel, number>;
/**
 * Settings the SDK can change on a running game, described once here.
 *
 * mGBA keeps its configuration in an `mCoreConfig` the core re-reads when the
 * frontend calls `reloadConfigOption()`, so most of these reach the emulation
 * without a restart; the ones that are consumed while the cartridge is being
 * mapped (the system, the Game Boy model, the BIOS) are tagged `requiresReset`.
 * The rest — canvas filtering, aspect, blending, volume — never reach the core
 * at all and are applied by the SDK.
 *
 * `DEFAULT_MGBA_OPTIONS`, the manifest's options schema and the demo shell's
 * ESC menu are all derived from this catalog, so adding a row here is enough to
 * expose a new setting.
 */
export type MgbaOptionKey = Exclude<keyof MgbaOptions, 'escMenu'>;
export type MgbaOptionValue = boolean | string | number;
interface OptionSpecBase {
    /** Option key, as used in `EngineConfig.options` and the manifest schema. */
    key: MgbaOptionKey;
    label: string;
    description: string;
    /**
     * Takes effect on the next power-on rather than immediately — the ESC menu
     * tags these, and the SDK applies them from `reset()`.
     */
    requiresReset?: boolean;
}
/** One selectable value, as offered by the menu. */
export interface MgbaChoice<T> {
    value: T;
    label: string;
}
export type MgbaOptionSpec = OptionSpecBase & ({
    type: 'boolean';
    default: boolean;
} | {
    type: 'enum';
    default: string;
    values: MgbaChoice<string>[];
} | {
    type: 'number';
    default: number;
    /** Values the menu cycles through; the schema may still take a range. */
    values: MgbaChoice<number>[];
    integer?: boolean;
    /**
     * When set, the schema advertises this range instead of the menu's
     * choices, so hosts can pass values the menu does not offer.
     */
    range?: {
        minimum: number;
        maximum: number;
    };
});
export interface MgbaOptionGroup {
    id: string;
    label: string;
    options: MgbaOptionSpec[];
}
export declare const MGBA_OPTION_GROUPS: MgbaOptionGroup[];
/** Flat view of every runtime-tweakable option across all groups. */
export declare const MGBA_ENGINE_OPTIONS: MgbaOptionSpec[];
export declare function mgbaOption(key: string): MgbaOptionSpec | undefined;
/**
 * Coerces a host- or storage-supplied value to what the option accepts,
 * returning `undefined` when it is not a value the option can take. Numbers
 * outside a `range` are clamped rather than rejected; enums are exact.
 */
export declare function coerceOptionValue(option: MgbaOptionSpec, value: unknown): MgbaOptionValue | undefined;
/** One row as the `esc-menu` component of the demo shell renders it. */
export interface EscMenuOption {
    key: string;
    label: string;
    description: string;
    type: 'boolean' | 'enum';
    value: MgbaOptionValue;
    values?: MgbaChoice<MgbaOptionValue>[];
    requiresReset?: boolean;
}
export interface EscMenuGroup {
    id: string;
    label: string;
    options: EscMenuOption[];
}
/**
 * Projects the catalog onto the shape `@wasm-gaming/engine-specs` (>=0.2.5)
 * feeds its `esc-menu` component.
 *
 * The menu lives in the demo shell now, not in this package: the shell renders
 * the rows and emits `option-change`, and the host writes the value back
 * through `engine.config`. Since the component only draws chips for `boolean`
 * and `enum`, numeric options are handed over as an enum of their menu choices
 * — the numbers survive, because the chips compare values with `===`.
 *
 * Pass the running engine's `config.values()` so the menu opens on what the
 * emulator is actually set to rather than on this package's defaults.
 */
export declare function toEscMenuGroups(values?: Record<string, MgbaOptionValue>): EscMenuGroup[];
export declare const MGBA_OPTIONS_SCHEMA: JSONSchema;
export {};
//# sourceMappingURL=mgba.options.d.ts.map