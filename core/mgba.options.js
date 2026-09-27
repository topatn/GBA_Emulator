export const DEFAULT_MGBA_OPTIONS = {
    system: 'auto',
    gbModel: 'auto',
    idleOptimization: 'remove',
    skipBios: true,
    allowOpposingDirections: false,
    renderFilter: 'pixelated',
    aspect: 'native',
    interframeBlending: false,
    volume: 1.0,
    gamepads: true,
    logLevel: 'error',
    escMenu: true,
};
/** Platform ids consumed by `mgbawasm_setup()` (mPLATFORM_* in core/core.h). */
export const MGBA_PLATFORM_IDS = {
    auto: -1,
    gba: 0,
    gb: 1,
};
/** Values mGBA's `gb.model` config key takes; `auto` means "leave unset". */
export const MGBA_GB_MODEL_VALUES = {
    auto: null,
    dmg: 'DMG',
    sgb: 'SGB',
    cgb: 'CGB',
    agb: 'AGB',
};
export const MGBA_LOG_LEVEL_IDS = {
    off: 0,
    error: 1,
    debug: 2,
};
export const MGBA_OPTION_GROUPS = [
    {
        id: 'video',
        label: 'Video',
        options: [
            {
                key: 'renderFilter',
                label: 'Image filtering',
                description: 'Scaling filter applied when the picture is stretched to the canvas. Pixelated keeps pixel art crisp; smooth softens it.',
                type: 'enum',
                default: DEFAULT_MGBA_OPTIONS.renderFilter,
                values: [
                    { value: 'pixelated', label: 'Pixelated' },
                    { value: 'smooth', label: 'Smooth' },
                ],
            },
            {
                key: 'aspect',
                label: 'Aspect ratio',
                description: 'Native is square pixels, as the handheld LCDs had them: 3:2 on GBA, 10:9 on Game Boy. 4:3 stretches the picture into a TV-shaped frame.',
                type: 'enum',
                default: DEFAULT_MGBA_OPTIONS.aspect,
                values: [
                    { value: 'native', label: 'Native' },
                    { value: '4:3', label: '4:3' },
                ],
            },
            {
                key: 'interframeBlending',
                label: 'Interframe blending',
                description: 'Blend each frame with the previous one, approximating the ghosting of the original unlit LCD. Restores transparency effects that games drew by flickering sprites every other frame.',
                type: 'boolean',
                default: DEFAULT_MGBA_OPTIONS.interframeBlending,
            },
        ],
    },
    {
        id: 'audio',
        label: 'Audio',
        options: [
            {
                key: 'volume',
                label: 'Volume',
                description: 'Master audio volume.',
                type: 'number',
                default: DEFAULT_MGBA_OPTIONS.volume,
                values: [
                    { value: 0, label: 'Mute' },
                    { value: 0.25, label: '25%' },
                    { value: 0.5, label: '50%' },
                    { value: 0.75, label: '75%' },
                    { value: 1, label: '100%' },
                ],
                range: { minimum: 0, maximum: 1 },
            },
        ],
    },
    {
        id: 'emulation',
        label: 'Emulation',
        options: [
            {
                key: 'system',
                label: 'System',
                description: 'Which core boots the ROM. Auto sniffs the image, which is right for every well-formed dump; force it for headerless or mislabelled files.',
                type: 'enum',
                default: DEFAULT_MGBA_OPTIONS.system,
                requiresReset: true,
                values: [
                    { value: 'auto', label: 'Auto' },
                    { value: 'gba', label: 'GBA' },
                    { value: 'gb', label: 'Game Boy' },
                ],
            },
            {
                key: 'gbModel',
                label: 'Game Boy model',
                description: 'Hardware the Game Boy core emulates. Auto follows the cartridge header. Ignored when a GBA ROM is loaded.',
                type: 'enum',
                default: DEFAULT_MGBA_OPTIONS.gbModel,
                requiresReset: true,
                values: [
                    { value: 'auto', label: 'Auto' },
                    { value: 'dmg', label: 'DMG' },
                    { value: 'sgb', label: 'Super GB' },
                    { value: 'cgb', label: 'Color' },
                    { value: 'agb', label: 'GBA' },
                ],
            },
            {
                key: 'idleOptimization',
                label: 'Idle loops',
                description: 'How the GBA core treats the busy-wait loops games spin in. Remove skips them and is where nearly all of the speed comes from; ignore emulates them cycle for cycle.',
                type: 'enum',
                default: DEFAULT_MGBA_OPTIONS.idleOptimization,
                values: [
                    { value: 'remove', label: 'Remove' },
                    { value: 'detect', label: 'Detect' },
                    { value: 'ignore', label: 'Ignore' },
                ],
            },
            {
                key: 'skipBios',
                label: 'Skip BIOS intro',
                description: 'Jump straight into the game instead of playing the boot animation. Forced on when no BIOS image was supplied, since the built-in HLE BIOS has no intro.',
                type: 'boolean',
                default: DEFAULT_MGBA_OPTIONS.skipBios,
                requiresReset: true,
            },
        ],
    },
    {
        id: 'controllers',
        label: 'Controllers',
        options: [
            {
                key: 'allowOpposingDirections',
                label: 'Opposing directions',
                description: 'Let the D-pad report left+right (or up+down) at once. Real hardware cannot, and a few games misbehave when it happens.',
                type: 'boolean',
                default: DEFAULT_MGBA_OPTIONS.allowOpposingDirections,
            },
            {
                key: 'gamepads',
                label: 'Gamepads',
                description: 'Poll connected gamepads (standard mapping) each frame.',
                type: 'boolean',
                default: DEFAULT_MGBA_OPTIONS.gamepads,
            },
        ],
    },
    {
        id: 'debug',
        label: 'Debug',
        options: [
            {
                key: 'logLevel',
                label: 'Core logging',
                description: 'Core messages printed to the browser console: errors and warnings, or also its informational ones.',
                type: 'enum',
                default: DEFAULT_MGBA_OPTIONS.logLevel,
                values: [
                    { value: 'off', label: 'Off' },
                    { value: 'error', label: 'Errors' },
                    { value: 'debug', label: 'Debug' },
                ],
            },
        ],
    },
];
/** Flat view of every runtime-tweakable option across all groups. */
export const MGBA_ENGINE_OPTIONS = MGBA_OPTION_GROUPS.flatMap((group) => group.options);
const OPTION_BY_KEY = new Map(MGBA_ENGINE_OPTIONS.map((option) => [option.key, option]));
export function mgbaOption(key) {
    return OPTION_BY_KEY.get(key);
}
/**
 * Coerces a host- or storage-supplied value to what the option accepts,
 * returning `undefined` when it is not a value the option can take. Numbers
 * outside a `range` are clamped rather than rejected; enums are exact.
 */
export function coerceOptionValue(option, value) {
    if (option.type === 'boolean') {
        return typeof value === 'boolean' ? value : undefined;
    }
    if (option.type === 'enum') {
        const next = String(value);
        return option.values.some((choice) => choice.value === next) ? next : undefined;
    }
    const next = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(next))
        return undefined;
    if (option.range) {
        return Math.min(option.range.maximum, Math.max(option.range.minimum, next));
    }
    return option.values.some((choice) => choice.value === next) ? next : undefined;
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
export function toEscMenuGroups(values = {}) {
    return MGBA_OPTION_GROUPS.map((group) => ({
        id: group.id,
        label: group.label,
        options: group.options.map((option) => ({
            key: option.key,
            label: option.label,
            description: option.description,
            type: option.type === 'boolean' ? 'boolean' : 'enum',
            value: values[option.key] ?? option.default,
            ...(option.type === 'boolean' ? {} : { values: option.values }),
            ...(option.requiresReset ? { requiresReset: true } : {}),
        })),
    }));
}
// -------------------------------------------------------------- schema
function schemaForOption(option) {
    if (option.type === 'boolean') {
        return { type: 'boolean', default: option.default, description: option.description };
    }
    if (option.type === 'enum') {
        return {
            type: 'string',
            enum: option.values.map((choice) => choice.value),
            default: option.default,
            description: option.description,
        };
    }
    return {
        type: option.integer ? 'integer' : 'number',
        default: option.default,
        ...(option.range
            ? { minimum: option.range.minimum, maximum: option.range.maximum }
            : { enum: option.values.map((choice) => choice.value) }),
        description: option.description,
    };
}
export const MGBA_OPTIONS_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        ...Object.fromEntries(MGBA_ENGINE_OPTIONS.map((option) => [option.key, schemaForOption(option)])),
        escMenu: {
            type: 'boolean',
            default: true,
            description: "Show the demo shell's in-game settings menu when the player presses Escape.",
        },
    },
};
//# sourceMappingURL=mgba.options.js.map