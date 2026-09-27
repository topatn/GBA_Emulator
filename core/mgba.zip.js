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
const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const STORED = 0;
const DEFLATED = 8;
/** A zip always starts with a local file header signature. */
export function isZip(bytes) {
    return (bytes.length > 4 &&
        bytes[0] === 0x50 &&
        bytes[1] === 0x4b &&
        bytes[2] === 0x03 &&
        bytes[3] === 0x04);
}
function findEocd(view) {
    // The EOCD is last, but a trailing comment of up to 64 KiB may follow it.
    const min = Math.max(0, view.byteLength - 0x10000 - 22);
    for (let i = view.byteLength - 22; i >= min; i--) {
        if (view.getUint32(i, true) === SIG_EOCD)
            return i;
    }
    return -1;
}
export function listEntries(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const eocd = findEocd(view);
    if (eocd < 0)
        throw new Error('mgba: not a zip archive (no end-of-central-directory record)');
    const count = view.getUint16(eocd + 10, true);
    let offset = view.getUint32(eocd + 16, true);
    const decoder = new TextDecoder();
    const entries = [];
    for (let i = 0; i < count; i++) {
        if (view.getUint32(offset, true) !== SIG_CENTRAL)
            break;
        const nameLength = view.getUint16(offset + 28, true);
        const extraLength = view.getUint16(offset + 30, true);
        const commentLength = view.getUint16(offset + 32, true);
        entries.push({
            name: decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)),
            compression: view.getUint16(offset + 10, true),
            compressedSize: view.getUint32(offset + 20, true),
            uncompressedSize: view.getUint32(offset + 24, true),
            localHeaderOffset: view.getUint32(offset + 42, true),
        });
        offset += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
}
export async function readEntry(bytes, entry) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const header = entry.localHeaderOffset;
    if (view.getUint32(header, true) !== SIG_LOCAL) {
        throw new Error(`mgba: corrupt zip entry "${entry.name}"`);
    }
    // The local header repeats the name and extra field with its own lengths,
    // which are the ones that count for locating the data.
    const nameLength = view.getUint16(header + 26, true);
    const extraLength = view.getUint16(header + 28, true);
    const start = header + 30 + nameLength + extraLength;
    const data = bytes.subarray(start, start + entry.compressedSize);
    if (entry.compression === STORED)
        return data.slice();
    if (entry.compression !== DEFLATED) {
        throw new Error(`mgba: zip entry "${entry.name}" uses an unsupported compression method (${entry.compression})`);
    }
    if (typeof DecompressionStream === 'undefined') {
        throw new Error('mgba: this environment cannot inflate zip entries (no DecompressionStream)');
    }
    const stream = new Blob([data])
        .stream()
        .pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}
/**
 * Returns the ROM inside a zip, or the input unchanged when it is not one.
 *
 * Cartridge archives are almost always a single ROM plus the odd text file, so
 * the pick is "the first entry with an extension mGBA knows"; if none of them
 * carries a useful extension, the largest entry wins, which is what a ROM is.
 */
export async function extractRom(bytes, accept) {
    if (!isZip(bytes))
        return { bytes };
    const entries = listEntries(bytes).filter((entry) => !entry.name.endsWith('/') && entry.uncompressedSize > 0);
    if (!entries.length)
        throw new Error('mgba: the zip archive contains no files');
    const byExtension = entries.find((entry) => accept.some((ext) => entry.name.toLowerCase().endsWith(ext)));
    const chosen = byExtension ??
        entries.reduce((largest, entry) => entry.uncompressedSize > largest.uncompressedSize ? entry : largest);
    return { bytes: await readEntry(bytes, chosen), name: chosen.name };
}
//# sourceMappingURL=mgba.zip.js.map