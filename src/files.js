// File changes Island can undo. Deletes go to the Recycle Bin (with a private backup copy
// so Undo can put things back exactly), overwrites keep the old version, and moves and new
// folders can be reversed. Each operation returns { message, undo } where undo describes
// how to reverse it; undo() carries that out.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { shell } = require('electron');

const BACKUP_LIMIT = 500 * 1024 * 1024; // larger deletes still go to the Recycle Bin, without an Island backup
const KEEP_DAYS = 14;

function expandPath(p) {
  p = String(p || '').trim().replace(/^["']|["']$/g, '').replace(/^~(?=$|[\\/])/, os.homedir());
  p = p.replace(/%([^%]+)%/g, (m, v) => process.env[v] ?? m);
  return path.resolve(p);
}

// Places Island must never change: system folders and whole drives.
function guard(p, what) {
  const n = path.resolve(p).toLowerCase();
  const win = (process.env.SystemRoot || 'C:\\Windows').toLowerCase();
  const protectedDirs = [win, (process.env.ProgramFiles || 'C:\\Program Files').toLowerCase(), (process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)').toLowerCase(), 'c:\\programdata'];
  if (/^[a-z]:\\?$/.test(n)) throw new Error(`Refusing to ${what} there: ${p} is a whole drive.`);
  if (protectedDirs.some((d) => n === d || n.startsWith(d + '\\'))) throw new Error(`Refusing to ${what} there: ${p} is in a system folder.`);
  if (n === os.homedir().toLowerCase()) throw new Error(`Refusing to ${what} there: that is your whole user folder.`);
}

function sizeOf(p, budget = BACKUP_LIMIT + 1) {
  let total = 0;
  const walk = (q) => {
    if (total > budget) return;
    const st = fs.lstatSync(q);
    if (st.isDirectory()) for (const c of fs.readdirSync(q)) walk(path.join(q, c));
    else total += st.size;
  };
  walk(p);
  return total;
}

function createFiles({ undoDir }) {
  fs.mkdirSync(undoDir, { recursive: true });
  // Old backups go after a while.
  try {
    for (const d of fs.readdirSync(undoDir)) {
      const full = path.join(undoDir, d);
      if (Date.now() - fs.statSync(full).mtimeMs > KEEP_DAYS * 86400000) fs.rmSync(full, { recursive: true, force: true });
    }
  } catch {}
  const newBackupDir = () => {
    const d = path.join(undoDir, `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };

  return {
    expandPath,
    guard,

    createFolder(raw) {
      const p = expandPath(raw);
      guard(p, 'create a folder');
      if (fs.existsSync(p)) throw new Error(`Something named "${path.basename(p)}" already exists there.`);
      // Remember the topmost folder this creates, so Undo removes exactly that.
      let top = p;
      while (!fs.existsSync(path.dirname(top))) top = path.dirname(top);
      fs.mkdirSync(p, { recursive: true });
      return { message: `Created folder ${p}`, undo: { op: 'remove_created_folder', path: top } };
    },

    moveItem(rawFrom, rawTo, { into } = {}) {
      const from = expandPath(rawFrom);
      let to = expandPath(rawTo);
      guard(from, 'move');
      guard(to, 'move things');
      if (!fs.existsSync(from)) throw new Error(`Not found: ${from}`);
      const isFile = fs.statSync(from).isFile();
      // "Move into a folder that doesn't exist yet": Windows' own move would quietly rename
      // the file to the folder's name (how Gemini CLI wiped a user's files in 2025). Create
      // the folder instead when that's clearly meant: asked for, a trailing slash, or a file
      // with an extension going to a name without one.
      let createdDir = null;
      if (!fs.existsSync(to)) {
        const looksLikeFolder = into === true || /[\\/]$/.test(String(rawTo).trim()) || (into !== false && isFile && path.extname(from) && !path.extname(to));
        if (looksLikeFolder) {
          let top = to;
          while (!fs.existsSync(path.dirname(top))) top = path.dirname(top);
          fs.mkdirSync(to, { recursive: true });
          createdDir = top;
        }
      }
      if (fs.existsSync(to) && fs.statSync(to).isDirectory() && path.basename(to).toLowerCase() !== path.basename(from).toLowerCase()) to = path.join(to, path.basename(from));
      if (fs.existsSync(to) && from.toLowerCase() !== to.toLowerCase()) throw new Error(`Something named "${path.basename(to)}" already exists at the destination; not overwriting it.`);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      try {
        fs.renameSync(from, to);
      } catch (e) {
        if (e.code !== 'EXDEV') throw e;
        fs.cpSync(from, to, { recursive: true, errorOnExist: true });
        fs.rmSync(from, { recursive: true });
      }
      // Check it really happened before saying so.
      if (!fs.existsSync(to) || fs.existsSync(from) && from.toLowerCase() !== to.toLowerCase()) throw new Error(`The move didn't complete: ${from} → ${to}`);
      const renamed = path.dirname(from).toLowerCase() === path.dirname(to).toLowerCase();
      return { message: `${renamed ? 'Renamed' : 'Moved'} ${from} → ${to}${createdDir ? ` (made the folder ${path.dirname(to)})` : ''}`, undo: { op: 'move', from: to, to: from, ...(createdDir ? { createdDir } : {}) } };
    },

    async deleteItems(rawPaths) {
      const items = [];
      let backupDir = null;
      let budget = BACKUP_LIMIT;
      for (const raw of rawPaths) {
        const p = expandPath(raw);
        guard(p, 'delete');
        if (!fs.existsSync(p)) throw new Error(`Not found: ${p}`);
        let backup = null;
        const size = sizeOf(p);
        if (size <= budget) {
          backupDir ||= newBackupDir();
          backup = path.join(backupDir, `${items.length}-${path.basename(p)}`);
          fs.cpSync(p, backup, { recursive: true });
          budget -= size;
        }
        await shell.trashItem(p);
        items.push({ original: p, backup });
      }
      const all = items.every((i) => i.backup);
      return {
        message: `Moved ${items.length} item${items.length > 1 ? 's' : ''} to the Recycle Bin: ${items.map((i) => i.original).join(', ')}${all ? '' : ' (some were too big to back up; restore those from the Recycle Bin if needed)'}`,
        undo: { op: 'restore', items },
      };
    },

    writeTextFile(raw, content, mode = 'overwrite') {
      const p = expandPath(raw);
      guard(p, 'write');
      const existed = fs.existsSync(p);
      let backup = null;
      if (existed) {
        if (fs.statSync(p).isDirectory()) throw new Error(`${p} is a folder.`);
        backup = path.join(newBackupDir(), path.basename(p));
        fs.copyFileSync(p, backup);
      }
      fs.mkdirSync(path.dirname(p), { recursive: true });
      if (mode === 'append') fs.appendFileSync(p, content);
      else fs.writeFileSync(p, content);
      return { message: `${existed ? (mode === 'append' ? 'Added to' : 'Overwrote') : 'Created'} ${p} (${Buffer.byteLength(content)} bytes)${existed ? '; the old version is kept for Undo' : ''}`, undo: existed ? { op: 'restore_file', path: p, backup } : { op: 'remove_new_file', path: p } };
    },

    // Reverse an operation; never destroys anything the user may have created since.
    async undo(u) {
      switch (u?.op) {
        case 'remove_created_folder': {
          if (!fs.existsSync(u.path)) return `The folder is already gone: ${u.path}`;
          const hasFiles = (q) => fs.readdirSync(q).some((c) => { const f = path.join(q, c); return fs.statSync(f).isDirectory() ? hasFiles(f) : true; });
          if (hasFiles(u.path)) throw new Error(`The folder isn't empty any more, so it was left alone: ${u.path}`);
          await shell.trashItem(u.path);
          return `Removed the folder ${u.path} (it's in the Recycle Bin)`;
        }
        case 'move': {
          if (!fs.existsSync(u.from)) throw new Error(`Can't find it at ${u.from} any more.`);
          if (fs.existsSync(u.to)) throw new Error(`Something already exists at ${u.to}; not overwriting it.`);
          fs.mkdirSync(path.dirname(u.to), { recursive: true });
          fs.renameSync(u.from, u.to);
          // Remove a folder the move created, if it's empty again.
          if (u.createdDir) {
            try {
              const empty = (q) => fs.readdirSync(q).every((c) => { const f = path.join(q, c); return fs.statSync(f).isDirectory() && empty(f); });
              if (fs.existsSync(u.createdDir) && empty(u.createdDir)) fs.rmSync(u.createdDir, { recursive: true });
            } catch {}
          }
          return `Moved it back to ${u.to}`;
        }
        case 'restore': {
          const done = [];
          const missing = [];
          for (const i of u.items) {
            if (fs.existsSync(i.original)) { done.push(`${i.original} (already back)`); continue; }
            if (!i.backup || !fs.existsSync(i.backup)) { missing.push(i.original); continue; }
            fs.mkdirSync(path.dirname(i.original), { recursive: true });
            fs.cpSync(i.backup, i.original, { recursive: true });
            done.push(i.original);
          }
          if (missing.length && !done.length) throw new Error(`No backup for ${missing.join(', ')}; restore it from the Recycle Bin.`);
          return `Restored ${done.join(', ')}${missing.length ? `. Restore from the Recycle Bin: ${missing.join(', ')}` : ''}`;
        }
        case 'restore_file': {
          if (!fs.existsSync(u.backup)) throw new Error('The saved old version is gone.');
          fs.copyFileSync(u.backup, u.path);
          return `Put back the previous version of ${u.path}`;
        }
        case 'remove_new_file': {
          if (!fs.existsSync(u.path)) return `Already gone: ${u.path}`;
          await shell.trashItem(u.path);
          return `Removed ${u.path} (it's in the Recycle Bin)`;
        }
      }
      throw new Error('This action has no undo.');
    },
  };
}

module.exports = { createFiles, expandPath };
