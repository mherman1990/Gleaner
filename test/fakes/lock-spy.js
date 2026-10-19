// Preloaded into a `token` CLI child (node --import): the first time the CLI finds tokens.json.lock taken, it says
// "waiting" on stderr, so a test can release the lock once the child is waiting for it, not on a timer.
import fs from 'node:fs';

const write = fs.writeFileSync;
let said = false;
fs.writeFileSync = function (file, ...rest) {
  try { return write.call(this, file, ...rest); } catch (e) {
    if (e.code === 'EEXIST' && String(file).endsWith('.lock') && !said) { said = true; process.stderr.write('waiting\n'); }
    throw e;
  }
};
