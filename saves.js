/**
 * Local Folder Save System
 * Powered exclusively by the File System Access API (showDirectoryPicker)
 * Real files on user's disk: <romname>.sav and <romname>.state<N>
 */

/**
 * Checks if the browser supports the File System Access API
 * @returns {boolean}
 */
export function isFileSystemAccessSupported() {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

/**
 * Prompts user to pick a folder on their computer for GBA saves
 * @returns {Promise<FileSystemDirectoryHandle>}
 */
export async function pickSaveFolder() {
  if (!isFileSystemAccessSupported()) {
    throw new Error('FileSystemAccessNotSupported');
  }

  const handle = await window.showDirectoryPicker({
    id: 'gba-local-saves',
    mode: 'readwrite',
    startIn: 'documents',
  });

  // Verify write permission
  let perm = await handle.queryPermission({ mode: 'readwrite' });
  if (perm !== 'granted') {
    perm = await handle.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') {
      throw new Error('Write permission denied for selected folder.');
    }
  }

  return handle;
}

/**
 * Simple hash helper to detect whether SRAM data has changed before writing to disk
 * @param {Uint8Array} data
 * @returns {number} 32-bit FNV-1a hash
 */
export function hashBytes(data) {
  if (!data) return 0;
  let hash = 2166136261;
  for (let i = 0; i < data.length; i++) {
    hash ^= data[i];
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Checks whether an SRAM buffer is all zeroes or empty (uninitialized)
 * @param {Uint8Array} data
 * @returns {boolean}
 */
export function isSramEmpty(data) {
  if (!data || data.length === 0) return true;
  // Check if every byte is 0x00 or 0xFF
  const first = data[0];
  if (first !== 0x00 && first !== 0xFF) return false;
  for (let i = 1; i < Math.min(data.length, 1024); i++) {
    if (data[i] !== first) return false;
  }
  return true;
}

/**
 * Strips file extension and special characters to produce a clean base name
 * @param {string} fileName
 * @returns {string}
 */
export function getRomBaseName(fileName) {
  if (!fileName) return 'game';
  return fileName.replace(/\.(gba|bin|zip)$/i, '').trim();
}

/**
 * Reads battery save (<romname>.sav) from the user's chosen folder
 * @param {FileSystemDirectoryHandle} dirHandle
 * @param {string} romBaseName
 * @returns {Promise<Uint8Array | null>}
 */
export async function readBatterySave(dirHandle, romBaseName) {
  if (!dirHandle || !romBaseName) return null;
  const fileName = `${romBaseName}.sav`;

  try {
    const fileHandle = await dirHandle.getFileHandle(fileName, { create: false });
    const file = await fileHandle.getFile();
    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    return bytes.length > 0 ? bytes : null;
  } catch (err) {
    // NotFoundError is normal when starting a new game
    return null;
  }
}

/**
 * Writes battery save (<romname>.sav) into the user's chosen folder
 * @param {FileSystemDirectoryHandle} dirHandle
 * @param {string} romBaseName
 * @param {Uint8Array} sramBytes
 * @returns {Promise<{ success: boolean, size: number, fileName: string }>}
 */
export async function writeBatterySave(dirHandle, romBaseName, sramBytes) {
  if (!dirHandle) throw new Error('No save folder selected.');
  if (!romBaseName) throw new Error('No ROM base name specified.');
  if (!sramBytes || sramBytes.length === 0) {
    return { success: false, size: 0, fileName: '' };
  }

  const fileName = `${romBaseName}.sav`;
  const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(sramBytes);
  await writable.close();

  return { success: true, size: sramBytes.length, fileName };
}

/**
 * Reads a save state snapshot (<romname>.state<N>) from the user's chosen folder
 * @param {FileSystemDirectoryHandle} dirHandle
 * @param {string} romBaseName
 * @param {number} slot (1-based index)
 * @returns {Promise<Uint8Array>}
 */
export async function readSaveState(dirHandle, romBaseName, slot = 1) {
  if (!dirHandle) throw new Error('No save folder selected.');
  if (!romBaseName) throw new Error('No ROM loaded.');

  const fileName = `${romBaseName}.state${slot}`;
  const fileHandle = await dirHandle.getFileHandle(fileName, { create: false });
  const file = await fileHandle.getFile();
  const arrayBuffer = await file.arrayBuffer();
  return new Uint8Array(arrayBuffer);
}

/**
 * Writes a save state snapshot (<romname>.state<N>) into the user's chosen folder
 * @param {FileSystemDirectoryHandle} dirHandle
 * @param {string} romBaseName
 * @param {number} slot (1-based index)
 * @param {Uint8Array} stateBytes
 * @returns {Promise<{ fileName: string, size: number, timestamp: Date }>}
 */
export async function writeSaveState(dirHandle, romBaseName, slot = 1, stateBytes) {
  if (!dirHandle) throw new Error('No save folder selected.');
  if (!romBaseName) throw new Error('No ROM loaded.');
  if (!stateBytes || stateBytes.length === 0) throw new Error('Empty state data.');

  const fileName = `${romBaseName}.state${slot}`;
  const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(stateBytes);
  await writable.close();

  return {
    fileName,
    size: stateBytes.length,
    timestamp: new Date(),
  };
}

/**
 * Inspects all state slots (1..5) for a given ROM in the save directory
 * @param {FileSystemDirectoryHandle} dirHandle
 * @param {string} romBaseName
 * @param {number} maxSlots
 * @returns {Promise<Array<{ slot: number, exists: boolean, size: number, modified: Date | null }>>}
 */
export async function inspectSaveSlots(dirHandle, romBaseName, maxSlots = 3) {
  if (!dirHandle || !romBaseName) return [];
  const results = [];

  for (let slot = 1; slot <= maxSlots; slot++) {
    const fileName = `${romBaseName}.state${slot}`;
    try {
      const fileHandle = await dirHandle.getFileHandle(fileName, { create: false });
      const file = await fileHandle.getFile();
      results.push({
        slot,
        exists: true,
        size: file.size,
        modified: new Date(file.lastModified),
      });
    } catch {
      results.push({
        slot,
        exists: false,
        size: 0,
        modified: null,
      });
    }
  }

  return results;
}

/**
 * Downloads a binary buffer as a file (fallback for browsers without File System Access API)
 * @param {Uint8Array} data
 * @param {string} fileName
 */
export function triggerFileDownload(data, fileName) {
  const blob = new Blob([data], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}
