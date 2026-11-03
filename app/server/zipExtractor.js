const JSZip = require('jszip');
const zlib = require('zlib');

/**
 * Extracts image buffer from a ZIP buffer or raw image buffer.
 * NovelAI's /ai/upscale returns application/zip containing a single PNG file,
 * or sometimes raw image bytes directly.
 * 
 * @param {Buffer} buffer 
 * @returns {Promise<Buffer>}
 */
async function extractImageBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    buffer = Buffer.from(buffer);
  }

  // 1. Direct PNG header (0x89 50 4E 47)
  if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return buffer;
  }

  // 2. Direct WEBP header (RIFF ... WEBP)
  if (buffer.length >= 12 && buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) {
    return buffer;
  }

  // 3. ZIP package (0x50 0x4B 0x03 0x04)
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) {
    try {
      const zip = new JSZip();
      const loadedZip = await zip.loadAsync(buffer);
      const filenames = Object.keys(loadedZip.files);
      if (filenames.length === 0) {
        throw new Error('未在返回的压缩包中找到超分图像文件');
      }
      const imgName = filenames.find(n => n.endsWith('.png') || n.endsWith('.webp') || !loadedZip.files[n].dir) || filenames[0];
      const file = loadedZip.files[imgName];
      const extractedBuffer = await file.async('nodebuffer');
      return extractedBuffer;
    } catch (zipErr) {
      console.warn('[ZipExtractor] JSZip failed, falling back to manual extract:', zipErr.message);
      if (buffer.length >= 30) {
        const compMethod = buffer.readUInt16LE(8);
        const compSize = buffer.readUInt32LE(18);
        const fnLen = buffer.readUInt16LE(26);
        const extraLen = buffer.readUInt16LE(28);
        const dataOffset = 30 + fnLen + extraLen;
        const dataSlice = compSize > 0 
          ? buffer.subarray(dataOffset, dataOffset + compSize)
          : buffer.subarray(dataOffset);

        if (compMethod === 0) {
          return dataSlice;
        } else if (compMethod === 8) {
          try {
            return zlib.inflateRawSync(dataSlice);
          } catch {
            return zlib.inflateSync(dataSlice);
          }
        }
      }
      throw zipErr;
    }
  }

  return buffer;
}

module.exports = {
  extractImageBuffer
};
