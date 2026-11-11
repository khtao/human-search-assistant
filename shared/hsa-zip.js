/* ============================================================================
 * HSA_ZIP · 纯 JS ZIP 打包（store 模式，无压缩）
 *
 * 两端共用：插件 Service Worker（importScripts）/ 桌面 host 与 popup（script）/
 * Node 单测（require）。不依赖任何第三方库，也不触碰宿主 API。
 *
 *   buildZip([{ name: 'a.html', data: '<html>…' }]) → Uint8Array
 *   toBase64(bytes) / fromBase64(str)               → 二进制跨 IPC 传输
 * ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HSA_ZIP = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var enc = new TextEncoder();
  var VERSION = '1.0.0';

  function toBytes(v) {
    if (v instanceof Uint8Array) return v;
    if (typeof v === 'string') return enc.encode(v);
    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    return enc.encode(String(v == null ? '' : v));
  }

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(u8) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function dosStamp(ms) {
    var d = new Date(Number.isFinite(ms) ? ms : Date.now());
    var time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    var date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time: time & 0xFFFF, date: date & 0xFFFF };
  }

  /* ZIP 采用 UTF-8 文件名标志位（bit 11），兼容中文文件名与所有主流解压工具。 */
  function buildZip(files, now) {
    var list = Array.isArray(files) ? files : [];
    var stamp = dosStamp(now);
    var flags = 0x0800;
    var localParts = [], centralParts = [], offset = 0, count = 0;

    for (var i = 0; i < list.length; i++) {
      var f = list[i] || {};
      var name = enc.encode(String(f.name || ('file-' + (i + 1))));
      var data = toBytes(f.data);
      var crc = crc32(data);
      var size = data.length;

      var lh = new Uint8Array(30 + name.length);
      var lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034B50, true);   // local file header signature
      lv.setUint16(4, 20, true);           // version needed
      lv.setUint16(6, flags, true);
      lv.setUint16(8, 0, true);            // method 0 = store
      lv.setUint16(10, stamp.time, true);
      lv.setUint16(12, stamp.date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, size, true);
      lv.setUint32(22, size, true);
      lv.setUint16(26, name.length, true);
      lv.setUint16(28, 0, true);           // extra length
      lh.set(name, 30);
      localParts.push(lh, data);

      var ch = new Uint8Array(46 + name.length);
      var cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014B50, true);   // central directory signature
      cv.setUint16(4, 20, true);           // version made by
      cv.setUint16(6, 20, true);           // version needed
      cv.setUint16(8, flags, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, stamp.time, true);
      cv.setUint16(14, stamp.date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, size, true);
      cv.setUint32(24, size, true);
      cv.setUint16(28, name.length, true);
      cv.setUint16(30, 0, true);           // extra length
      cv.setUint16(32, 0, true);           // comment length
      cv.setUint16(34, 0, true);           // disk number start
      cv.setUint16(36, 0, true);           // internal attrs
      cv.setUint32(38, 0, true);           // external attrs
      cv.setUint32(42, offset, true);      // local header offset
      ch.set(name, 46);
      centralParts.push(ch);

      offset += lh.length + size;
      count++;
    }

    var cdSize = 0;
    for (var j = 0; j < centralParts.length; j++) cdSize += centralParts[j].length;

    var eocd = new Uint8Array(22);
    var ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054B50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, count, true);
    ev.setUint16(10, count, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);

    var total = offset + cdSize + eocd.length;
    var out = new Uint8Array(total);
    var pos = 0;
    function put(arr) { out.set(arr, pos); pos += arr.length; }
    for (var a = 0; a < localParts.length; a++) put(localParts[a]);
    for (var b = 0; b < centralParts.length; b++) put(centralParts[b]);
    put(eocd);
    return out;
  }

  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function toBase64(u8) {
    var bytes = toBytes(u8), chunks = [], i = 0;
    for (; i + 2 < bytes.length; i += 3) {
      var n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      chunks.push(B64[(n >>> 18) & 63] + B64[(n >>> 12) & 63]
        + B64[(n >>> 6) & 63] + B64[n & 63]);
    }
    var rest = bytes.length - i;
    if (rest === 1) {
      var n1 = bytes[i] << 16;
      chunks.push(B64[(n1 >>> 18) & 63] + B64[(n1 >>> 12) & 63] + '==');
    } else if (rest === 2) {
      var n2 = (bytes[i] << 16) | (bytes[i + 1] << 8);
      chunks.push(B64[(n2 >>> 18) & 63] + B64[(n2 >>> 12) & 63]
        + B64[(n2 >>> 6) & 63] + '=');
    }
    return chunks.join('');
  }
  function fromBase64(str) {
    var s = String(str || '').replace(/[^A-Za-z0-9+/=]/g, '');
    var len = Math.floor(s.length / 4) * 3;
    if (s.endsWith('==')) len -= 2;
    else if (s.endsWith('=')) len -= 1;
    var out = new Uint8Array(Math.max(0, len));
    var p = 0;
    for (var i = 0; i + 3 < s.length; i += 4) {
      var a = B64.indexOf(s[i]), b = B64.indexOf(s[i + 1]);
      var c = B64.indexOf(s[i + 2]), d = B64.indexOf(s[i + 3]);
      var n = ((a & 63) << 18) | ((b & 63) << 12) | (((c & 63) & 63) << 6) | (d & 63);
      if (p < out.length) out[p++] = (n >>> 16) & 255;
      if (p < out.length) out[p++] = (n >>> 8) & 255;
      if (p < out.length) out[p++] = n & 255;
    }
    return out;
  }

  return {
    VERSION: VERSION,
    buildZip: buildZip,
    crc32: crc32,
    toBytes: toBytes,
    toBase64: toBase64,
    fromBase64: fromBase64
  };
});
