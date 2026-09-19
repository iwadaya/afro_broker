// server/src/db/createUser.js — create a sign-in (or reset its password) without the demo seeds.
//
//   npm run user:create --prefix server -- --username jane.broker --email jane@example.com --display "Jane Broker" --role ADMIN
//   USER_PASSWORD=… npm run user:create --prefix server -- --username ops --email ops@example.com --display Ops
//
// Options: --role ADMIN|BROKER|VIEWER (default BROKER), --org <uuid> (default: the seeded
// broking house), --password <plain> (else USER_PASSWORD, else a hidden prompt),
// --no-must-change (default: the user must change the password at first sign-in).
// An existing username gets the new password, is re-activated and signed out everywhere.
import { pool, closePools } from './pool.js';
import { hashPassword } from '../lib/passwordHash.js';

const DEFAULT_ORG = '00000000-0000-0000-0000-00000000a0b1';
const ROLES = new Set(['ADMIN', 'BROKER', 'VIEWER']);

function parseArgs(argv) {
  const out = { role: 'BROKER', org: DEFAULT_ORG, mustChange: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const next = () => argv[++i];
    if (a === '--username') out.username = next();
    else if (a === '--email') out.email = next();
    else if (a === '--display') out.display = next();
    else if (a === '--role') out.role = String(next() || '').toUpperCase();
    else if (a === '--org') out.org = next();
    else if (a === '--password') out.password = next();
    else if (a === '--no-must-change') out.mustChange = false;
    else if (a === '-h' || a === '--help') out.help = true;
    else throw new Error(`unknown option: ${a}`);
  }
  return out;
}

function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) { reject(new Error('no TTY: pass --password or USER_PASSWORD')); return; }
    stdout.write(question);
    let buf = '';
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); stdout.write('\n'); resolve(buf); }
      else if (ch === '\u0003') { stdin.setRawMode(false); stdout.write('\n'); reject(new Error('cancelled')); }
      else if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
      else buf += ch;
    };
    stdin.on('data', onData);
  });
}

(async () => {
  let code = 0;
  try {
    const o = parseArgs(process.argv.slice(2));
    if (o.help) { process.stdout.write('usage: createUser --username U --email E --display "Name" [--role ADMIN|BROKER|VIEWER] [--org uuid] [--password P] [--no-must-change]\n'); return; }
    for (const k of ['username', 'email', 'display']) if (!o[k]) throw new Error(`--${k} is required`);
    if (!ROLES.has(o.role)) throw new Error(`--role must be one of ${[...ROLES].join(', ')}`);
    const plain = o.password || process.env.USER_PASSWORD || await promptHidden(`Password for ${o.username}: `);
    if (!plain || plain.length < 10) throw new Error('password must be at least 10 characters');
    const hash = await hashPassword(plain);
    const { rows: [u] } = await pool.query(
      `INSERT INTO public.uw_user (org_id, username, email, display_name, role_code, password_hash, must_change_password, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true)
       ON CONFLICT (username) DO UPDATE SET email=EXCLUDED.email, display_name=EXCLUDED.display_name, role_code=EXCLUDED.role_code,
         password_hash=EXCLUDED.password_hash, must_change_password=EXCLUDED.must_change_password, is_active=true,
         failed_attempts=0, session_epoch=public.uw_user.session_epoch + 1, updated_at=now()
       RETURNING user_id, username, role_code, org_id, (xmax = 0) AS inserted`,
      [o.org, o.username.trim().toLowerCase(), o.email.trim(), o.display.trim(), o.role, hash, o.mustChange]);
    process.stdout.write(`${u.inserted ? 'created' : 'updated'} ${u.username} (${u.role_code}) in org ${u.org_id} — user_id ${u.user_id}${o.mustChange ? '; must change password at first sign-in' : ''}\n`);
  } catch (err) {
    console.error(`user:create failed: ${err.message}`);
    code = 1;
  } finally {
    await closePools().catch(() => {});
    process.exitCode = code;
  }
})();
