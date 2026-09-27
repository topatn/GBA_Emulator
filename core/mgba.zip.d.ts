/**
 * A zip reader just large enough to pull a ROM out of an archive.
 *
 * mGBA can read zips when it is built against libzip or minizip, but linking
 * either into an Emscripten build means vendoring a C dependency for something
 * the platform already does: `DecompressionStream('deflate-raw')` is in every
 * browser this SDK targets and in Node 18+. So the container is parsed here —
 * end-of-central-directory, then the central directory — and the one entry that
 * looks like a ROM is inflated.
 *
 * Deliberately partial: no encryption, no zip64, no multi-disk. Those do not
 * show up around cartridge dumps, and failing loudly beats half-supporting them.
 */
export interface ZipEntry {
    name: string;
    compression: number;
    compressedSize: number;
    uncompressedSize: number;
    localHeaderOffset: number;
}
/** A zip always starts with a local file header signature. */
export declare function isZip(bytes: Uint8Array): boolean;
export declare function listEntries(bytes: Uint8Array): ZipEntry[];
export declare function readEntry(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array>;
/**
 * Returns the ROM inside a zip, or the input unchanged when it is not one.
 *
 * Cartridge archives are almost always a single ROM plus the odd text file, so
 * the pick is "the first entry with an extension mGBA knows"; if none of them
 * carries a useful extension, the largest entry wins, which is what a ROM is.
 */
export declare function extractRom(bytes: Uint8Array, accept: readonly string[]): Promise<{
    bytes: Uint8Array;
    name?: string;
}>;
//# sourceMappingURL=mgba.zip.d.ts.map