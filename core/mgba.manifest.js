import { MGBA_OPTIONS_SCHEMA } from './mgba.options.js';
export const manifest = {
    id: 'mgba',
    version: '0.1.0',
    name: 'mGBA (WebAssembly)',
    description: 'mGBA — the accuracy-focused Game Boy Advance emulator, which also runs Game Boy and Game Boy Color — compiled to WebAssembly. Loads .gba/.gb/.gbc cartridge images; the GBA BIOS is optional, since mGBA ships a high-level replacement.',
    artifacts: {
        wasm: 'mgba/mgba.wasm',
        js: 'mgba/mgba.js',
    },
    assets: [
        {
            key: 'rom',
            mountPath: '/rom.gba',
            required: true,
            accept: ['.gba', '.gb', '.gbc', '.sgb'],
            description: 'Game Boy Advance, Game Boy or Game Boy Color cartridge image. The right core is picked from the image itself, so the extension only has to be one mGBA recognizes.',
        },
        {
            key: 'bios',
            mountPath: '/bios.bin',
            required: false,
            accept: ['.bin', '.rom'],
            description: 'Optional GBA BIOS dump (16 KiB). mGBA has a high-level replacement that runs virtually everything, so this is only needed for the boot animation and the handful of titles that read the BIOS directly.',
            validate: { bytes: 16384 },
        },
    ],
    input: 'mgba',
    // The GBA LCD. The Game Boy cores render 160x144 into the same buffer, and
    // the SDK follows `currentVideoSize()` rather than these numbers at runtime.
    video: { baseWidth: 240, baseHeight: 160, aspect: '3:2' },
    options: MGBA_OPTIONS_SCHEMA,
    // coreSelectable: one package, two cores (GBA and GB) — the host may offer
    // the choice, and `options.system` is where it lands.
    capabilities: { saveStates: true, sram: true, coreSelectable: true },
};
export default manifest;
//# sourceMappingURL=mgba.manifest.js.map