// Storage: Netlify Blobs in production; plain files when HR_LOCAL_STORE_DIR is set (tests).
import fs from 'node:fs';
import path from 'node:path';

let _s;
async function backend() {
  if (_s) return _s;
  const dir = process.env.HR_LOCAL_STORE_DIR;
  if (dir) {
    const p = (k) => path.join(dir, encodeURIComponent(k));
    const ensure = () => fs.mkdirSync(dir, { recursive: true });
    _s = {
      async getJSON(k) { try { return JSON.parse(fs.readFileSync(p(k), 'utf8')); } catch { return null; } },
      async setJSON(k, v) { ensure(); fs.writeFileSync(p(k), JSON.stringify(v)); },
      async getBin(k) { try { return fs.readFileSync(p(k)); } catch { return null; } },
      async setBin(k, buf) { ensure(); fs.writeFileSync(p(k), buf); },
      async list(prefix) { ensure(); return fs.readdirSync(dir).map(decodeURIComponent).filter((k) => k.startsWith(prefix)); },
    };
  } else {
    const { getStore } = await import('@netlify/blobs');
    const s = getStore({ name: 'hr-interviews', consistency: 'strong' });
    _s = {
      getJSON: (k) => s.get(k, { type: 'json' }),
      setJSON: (k, v) => s.setJSON(k, v),
      getBin: async (k) => { const b = await s.get(k, { type: 'arrayBuffer' }); return b ? Buffer.from(b) : null; },
      setBin: (k, buf) => s.set(k, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)),
      list: async (prefix) => { const { blobs } = await s.list({ prefix }); return blobs.map((b) => b.key); },
    };
  }
  return _s;
}

export const db = {
  getJSON: async (k) => (await backend()).getJSON(k),
  setJSON: async (k, v) => (await backend()).setJSON(k, v),
  getBin: async (k) => (await backend()).getBin(k),
  setBin: async (k, b) => (await backend()).setBin(k, b),
  list: async (p) => (await backend()).list(p),
};
