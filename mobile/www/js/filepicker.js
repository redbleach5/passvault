/**
 * filepicker.js — Native file picker wrapper for PassVault
 *
 * On Android (Capacitor), uses the custom FilePickerPlugin which opens
 * ACTION_OPEN_DOCUMENT / ACTION_CREATE_DOCUMENT system dialogs.
 * These show the full filesystem: Downloads, internal storage, cloud, USB.
 *
 * On web (non-Capacitor), falls back to HTML <input type="file"> and
 * <a download> approaches.
 */

const IS_CAPACITOR = !!(window.Capacitor && Capacitor.Plugins);

/**
 * Get the FilePicker plugin instance (Capacitor native only).
 */
function getFilePickerPlugin() {
  if (!IS_CAPACITOR) return null;
  try {
    return Capacitor.Plugins.FilePicker || null;
  } catch (e) {
    return null;
  }
}

/**
 * Pick a file from the filesystem.
 * On Android: Opens system document picker (full filesystem access).
 * On web: Falls back to HTML file input.
 *
 * @param {Object} options - { mimeType: string } (default: '*/*')
 * @returns {Promise<{success: boolean, fileName?: string, textData?: string, base64Data?: string, size?: number, error?: string}>}
 */
async function pickFile(options = {}) {
  const plugin = getFilePickerPlugin();

  if (plugin) {
    try {
      const result = await plugin.pickFile({
        mimeType: options.mimeType || '*/*'
      });
      return result;
    } catch (e) {
      return { success: false, error: e.message || 'File picker error' };
    }
  }

  // Web fallback: use hidden file input
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = options.accept || '.vault,.passvault,.json,application/json,*/*';
    input.style.display = 'none';

    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) {
        resolve({ success: false, error: 'No file selected' });
        return;
      }
      try {
        const textData = await file.text();
        resolve({
          success: true,
          fileName: file.name,
          textData: textData,
          size: file.size
        });
      } catch (err) {
        resolve({ success: false, error: 'Failed to read file' });
      }
      document.body.removeChild(input);
    };

    input.oncancel = () => {
      resolve({ success: false, error: 'User cancelled' });
      if (input.parentNode) document.body.removeChild(input);
    };

    document.body.appendChild(input);
    input.click();
  });
}

/**
 * Save data to a file.
 * On Android: Opens system save dialog (user chooses location).
 * On web: Falls back to <a download> approach.
 *
 * @param {Object} options - { fileName: string, data: string, mimeType?: string }
 * @returns {Promise<{success: boolean, fileName?: string, size?: number, error?: string}>}
 */
async function saveFile(options = {}) {
  const plugin = getFilePickerPlugin();

  if (plugin) {
    try {
      const result = await plugin.saveFile({
        fileName: options.fileName || 'passvault-backup.vault',
        data: options.data || '',
        mimeType: options.mimeType || 'application/json'
      });
      return result;
    } catch (e) {
      return { success: false, error: e.message || 'Save error' };
    }
  }

  // Web fallback: create blob and trigger download
  try {
    const blob = new Blob([options.data || ''], { type: options.mimeType || 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = options.fileName || 'passvault-backup.vault';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    return {
      success: true,
      fileName: options.fileName,
      size: (options.data || '').length
    };
  } catch (e) {
    return { success: false, error: e.message || 'Save failed' };
  }
}

// Make globally available
window.PickFile = pickFile;
window.SaveFile = saveFile;

export { pickFile, saveFile };
