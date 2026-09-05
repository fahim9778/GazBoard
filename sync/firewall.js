// The firewall, from inside the app - on all three platforms.
//
// Why this file exists at all
// ---------------------------
// The failure it addresses is silent by construction. GazBoard binds its
// socket, the port is genuinely open, `netstat` shows it listening - and every
// packet from the next desk is dropped before it arrives. Nothing in the app
// can feel that from the inside, because a connection to your own machine
// never crosses the firewall. So without something like this, "nobody can see
// me" has no explanation anywhere on screen.
//
// On WINDOWS this is not hypothetical. It is exactly how the first two machines
// this was tested on behaved: listening on 0.0.0.0:53318, visible in
// Get-NetTCPConnection, and Test-NetConnection failing from three feet away.
// The installer runs unelevated (perMachine: false, into the user's own
// profile) so it cannot add a rule at install time; Windows asks instead, once,
// behind whatever the person was doing - and Cancel, Escape or a timeout all
// write a BLOCK rule that is never asked about again. A block beats an allow,
// so the machine is then permanently unreachable.
//
// The layers, in order:
//
//   1. The OS asks its own question. If the person says yes, none of this runs.
//   2. GazBoard READS the firewall - which needs no privileges anywhere - and
//      says plainly what it found.
//   3. Windows only: it offers to fix it, which raises one UAC prompt.
//   4. Everywhere: the exact commands, to copy or hand to whoever administers
//      the machine.
//
// Step 3 stops at Windows on purpose. Elevation on Linux means pkexec and a
// polkit agent that may not exist in the session; on macOS it means an
// osascript password prompt. Both are things this has no way to test, and an
// app that hangs on a privilege prompt is worse than one that hands you a
// command. Detect and explain there; run it only where it can be trusted.
//
// Every failure path ends in "we could not tell", never in a claim that things
// are working.

'use strict';

const { spawn } = require('node:child_process');
const { DISCOVERY_PORT, TRANSFER_PORT } = require('./node.js');

const RULE_PREFIX = 'GazBoard sharing';
const BOARDS_RULE = RULE_PREFIX + ' (boards)';
const DISCOVERY_RULE = RULE_PREFIX + ' (discovery)';

/**
 * Private and Domain only, never Public.
 *
 * Public is the profile Windows gives a café, an airport or a hotel. Opening a
 * listening port there to make a classroom feature work would be trading a
 * problem the person can see for one they cannot. If their network is marked
 * Public - which happens to plenty of university wifi - the right fix is to
 * mark that network as private in Windows, and this says so rather than
 * quietly doing it for them.
 */
const PROFILES = 'Private,Domain';

/** Platforms this knows how to look at. Others get an honest shrug. */
const supported = () => ['win32', 'darwin', 'linux'].includes(process.platform);

/** Only Windows can be repaired from inside the app. See the note at the top. */
const repairable = () => process.platform === 'win32';

/** A PowerShell single-quoted literal. Doubling the quote is the whole escape. */
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";

/** PowerShell's -EncodedCommand wants UTF-16LE base64, which sidesteps quoting entirely. */
const encode = (script) => Buffer.from(script, 'utf16le').toString('base64');

function runPowerShell(args, { timeoutMs = 25000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn('powershell.exe', args, { windowsHide: true }); }
    catch (e) { resolve({ ok: false, out: '', err: e.message, code: -1 }); return; }

    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, out, err: e.message, code: -1 }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, out, err, code }); });
  });
}

const psShell = (script, opts) =>
  runPowerShell(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encode(script)], opts);

/**
 * Ask the same question again with a UAC prompt attached.
 *
 * -Wait so we know when it is over, -PassThru for the exit code, and the whole
 * thing in a try/catch because a cancelled UAC prompt is a terminating error
 * in PowerShell, not a non-zero exit.
 */
function elevated(script, opts) {
  const inner = encode(script);
  const outer = `
$ErrorActionPreference = 'Stop'
try {
  $p = Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList @(
    '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',${q(inner)})
  exit $p.ExitCode
} catch {
  Write-Error $_.Exception.Message
  exit 1223
}`;                                        // 1223 is ERROR_CANCELLED, and says so
  return psShell(outer, opts);
}

/* ------------------------------------------------------------------ *
 *  Reading. Needs no elevation, so it can happen quietly.
 * ------------------------------------------------------------------ */

function inspectScript(exe) {
  return `
$ErrorActionPreference = 'SilentlyContinue'
$exe = ${q(exe)}
$nets = @(Get-NetConnectionProfile | ForEach-Object { "$($_.NetworkCategory)" })

# Two ways of finding the same rules: by the names we give ours, and by the
# program any rule points at. A rule Windows wrote when it asked has a name of
# its own, so looking only for ours would miss precisely the block that matters.
$byName = @(Get-NetFirewallRule -DisplayName '${RULE_PREFIX}*')
$byApp  = @(Get-NetFirewallApplicationFilter -Program $exe | Get-NetFirewallRule)
$all = @($byName + $byApp) | Sort-Object -Property Name -Unique
$in  = @($all | Where-Object { $_.Direction -eq 'Inbound' -and "$($_.Enabled)" -eq 'True' })

# A rule can let us in without ever naming this program. Somebody - or an
# administrator, or an earlier version of these very instructions - can open
# the two PORTS instead, and that works perfectly well. Looking only for rules
# tied to the executable reported "nothing has been allowed" on a machine where
# boards were visibly arriving, which is the worst kind of wrong: alarming,
# confident and false.
#
# Only rules naming one of our exact ports count. A rule whose LocalPort is
# "Any" is too broad to attribute - it may be scoped to some other program
# entirely - and guessing from it would trade this false alarm for a false
# reassurance, which is worse.
$byPort = @(Get-NetFirewallPortFilter | Where-Object {
  ($_.Protocol -eq 'TCP' -and $_.LocalPort -contains '${TRANSFER_PORT}') -or
  ($_.Protocol -eq 'UDP' -and $_.LocalPort -contains '${DISCOVERY_PORT}')
} | Get-NetFirewallRule | Where-Object {
  $_.Direction -eq 'Inbound' -and "$($_.Enabled)" -eq 'True' -and $_.Action -eq 'Allow'
})

ConvertTo-Json -Compress -InputObject ([ordered]@{
  networks = $nets
  blocked  = @($in | Where-Object { $_.Action -eq 'Block' }).Count
  allowed  = @($in | Where-Object { $_.Action -eq 'Allow' }).Count
  byPort   = $byPort.Count
  portNames = @($byPort | ForEach-Object { $_.DisplayName } | Select-Object -First 3)
  ours     = @($all | Where-Object { $_.DisplayName -like '${RULE_PREFIX}*' }).Count
})`;
}

const asArray = (v) => (Array.isArray(v) ? v : (v === null || v === undefined || v === '' ? [] : [v]));

/**
 * What the firewall has been told about this program.
 *
 * Note what this is NOT: a test that another computer can actually reach this
 * one. That cannot be done from here - a connection to your own machine never
 * crosses the firewall - so this reads the rules and reasons about them. The
 * wording it produces says so rather than claiming more than it knows.
 *
 * @returns {Promise<object>} always resolves; `state` is the part to act on
 */
async function winInspect(exe) {
  const r = await psShell(inspectScript(exe), { timeoutMs: 25000 });
  let info = null;
  try { info = JSON.parse((r.out || '').trim()); } catch { info = null; }
  if (!info || typeof info.blocked !== 'number') {
    // PowerShell missing, disabled by policy, or the cmdlets absent (they need
    // Windows 8 or Server 2012 upwards). Nothing is broken; we simply cannot see.
    return { supported: true, state: 'unknown', program: exe, detail: (r.err || '').trim().slice(0, 300) };
  }

  const networks = asArray(info.networks).filter(Boolean);
  const base = {
    supported: true,
    program: exe,
    networks,
    blocked: info.blocked,
    allowed: info.allowed,
    byPort: info.byPort || 0,
    ours: info.ours,
    // The network being Public matters on its own: even a correct rule is
    // scoped to Private and Domain, so a Public network stays shut.
    publicOnly: networks.length > 0 && networks.every((n) => n === 'Public'),
    ports: { boards: TRANSFER_PORT, discovery: DISCOVERY_PORT }
  };

  if (info.blocked > 0) return { ...base, state: 'blocked' };
  if (info.allowed > 0) return { ...base, state: 'allowed' };
  // Allowed by the ports rather than by name. Just as effective, and worth
  // naming the rule so the person can recognise their own handiwork.
  if (info.byPort > 0) {
    return { ...base, state: 'allowed', viaPorts: true, portRules: asArray(info.portNames).filter(Boolean) };
  }
  return { ...base, state: 'no-rule' };
}

/* ------------------------------------------------------------------ *
 *  macOS and Linux
 *
 *  Read-only. Both of these look at what the machine will tell an ordinary
 *  user - no sudo, no polkit, no password prompt - and then say what they
 *  found. Where that is not enough to be sure, they say THAT instead of
 *  guessing, because "your firewall is fine" is the one answer nobody can
 *  afford to be wrong about.
 * ------------------------------------------------------------------ */

/** /bin/sh, for the two platforms that have one. */
function sh(script, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn('/bin/sh', ['-c', script]); }
    catch (e) { resolve({ ok: false, out: '', err: e.message, code: -1 }); return; }
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, out, err: e.message, code: -1 }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, out, err, code }); });
  });
}

/** key=value lines out of a probe script, which is far less painful than JSON in sh. */
function fields(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/**
 * The .app a binary lives in, because that is what macOS's firewall lists.
 *
 * process.execPath inside a bundle is .../GazBoard.app/Contents/MacOS/GazBoard,
 * and socketfilterfw is happier with the bundle above it. Outside a bundle -
 * `npm start`, a CI run - there is nothing to strip and the binary is the
 * right answer anyway.
 */
function macAppPath(exe) {
  const i = exe.indexOf('.app/Contents/MacOS/');
  return i > 0 ? exe.slice(0, i + 4) : exe;
}

const MAC_FW = '/usr/libexec/ApplicationFirewall/socketfilterfw';

function macScript(app) {
  return `
FW=${JSON.stringify(MAC_FW)}
APP=${JSON.stringify(app)}
if [ ! -x "$FW" ]; then echo "tool=none"; exit 0; fi
echo "tool=alf"
echo "global=$("$FW" --getglobalstate 2>/dev/null | tr -d '\\n')"
echo "blockall=$("$FW" --getblockall 2>/dev/null | tr -d '\\n')"
echo "app=$("$FW" --getappblocked "$APP" 2>/dev/null | tr -d '\\n')"
`;
}

async function macInspect(exe) {
  const app = macAppPath(exe);
  const r = await sh(macScript(app));
  const f = fields(r.out);
  const base = { supported: true, program: app, tool: 'macOS firewall', networks: [],
    ports: { boards: TRANSFER_PORT, discovery: DISCOVERY_PORT } };

  if (f.tool !== 'alf') {
    return { ...base, state: 'unknown', detail: 'the macOS firewall tool is not where it usually lives' };
  }
  // "Firewall is disabled. (State = 0)" - off entirely, so nothing is in the way.
  if (/State = 0|disabled/i.test(f.global || '')) return { ...base, state: 'off' };
  if (!/State = [12]|enabled/i.test(f.global || '')) {
    return { ...base, state: 'unknown', detail: 'could not read whether the firewall is on' };
  }

  // Block-all mode turns away everything regardless of any per-app permission,
  // so it has to be reported on its own or a green banner would be a lie.
  if (/block all|State = 1/i.test(f.blockall || '') && !/disabled|State = 0/i.test(f.blockall || '')) {
    return { ...base, state: 'blocked', blockAll: true,
      detail: 'the firewall is set to block all incoming connections' };
  }

  const app_ = f.app || '';
  if (/is blocked/i.test(app_)) return { ...base, state: 'blocked' };
  if (/permitted|allowed/i.test(app_)) return { ...base, state: 'allowed' };
  // Not in the list at all: macOS has not been asked about it yet, and will
  // ask when something first tries to reach it - or has been asked and the
  // answer was never recorded. Either way nothing is letting it through today.
  return { ...base, state: 'no-rule' };
}

/*
 * Linux is the awkward one, and honestly so.
 *
 * Which firewall is even present varies by distro; whether it is running can
 * be read without privileges; and whether OUR ports are open usually cannot -
 * `ufw status` refuses outright without root, and firewalld's rule listing
 * goes through polkit. So this reports the shape of the situation and stops
 * where its knowledge stops, rather than inventing a verdict.
 */
const LINUX_SCRIPT = `
tool=none
active=no
readable=no
ports=
if command -v firewall-cmd >/dev/null 2>&1; then
  tool=firewalld
  if [ "$(firewall-cmd --state 2>/dev/null)" = "running" ]; then
    active=yes
    if p=$(firewall-cmd --list-ports 2>/dev/null); then readable=yes; ports="$p"; fi
  fi
fi
if [ "$active" = "no" ] && command -v ufw >/dev/null 2>&1; then
  tool=ufw
  st=$(ufw status 2>/dev/null || true)
  case "$st" in
    *"Status: active"*) active=yes; readable=yes; ports="$st" ;;
    *"Status: inactive"*) active=no; readable=yes ;;
    *) if systemctl is-active --quiet ufw 2>/dev/null; then active=yes; fi ;;
  esac
fi
if [ "$tool" = "none" ] && command -v nft >/dev/null 2>&1; then tool=nftables; fi
if [ "$tool" = "none" ] && command -v iptables >/dev/null 2>&1; then tool=iptables; fi
echo "tool=$tool"
echo "active=$active"
echo "readable=$readable"
echo "ports=$(echo "$ports" | tr '\\n' ' ')"
`;

async function linuxInspect(exe) {
  const r = await sh(LINUX_SCRIPT);
  const f = fields(r.out);
  const base = { supported: true, program: exe, tool: f.tool || 'unknown', networks: [],
    ports: { boards: TRANSFER_PORT, discovery: DISCOVERY_PORT } };

  if (!f.tool || f.tool === 'none') {
    // No firewalld, no ufw, no nft, no iptables. Nothing is filtering.
    return { ...base, state: 'off', tool: 'none' };
  }
  if (f.tool === 'nftables' || f.tool === 'iptables') {
    // Present, but reading a raw ruleset needs root and interpreting one is
    // not something to attempt on somebody's behalf.
    return { ...base, state: 'unknown',
      detail: `this machine uses ${f.tool} directly, which GazBoard cannot read without administrator rights` };
  }
  if (f.active !== 'yes') return { ...base, state: 'off' };

  if (f.readable !== 'yes') {
    return { ...base, state: 'unknown',
      detail: `${f.tool} is running, but listing its rules needs administrator rights` };
  }

  // Readable: look for our two ports in whatever the tool printed.
  const text = f.ports || '';
  const hasTcp = new RegExp(`\\b${TRANSFER_PORT}\\b[^\\n]*tcp|tcp[^\\n]*\\b${TRANSFER_PORT}\\b`, 'i').test(text);
  const hasUdp = new RegExp(`\\b${DISCOVERY_PORT}\\b[^\\n]*udp|udp[^\\n]*\\b${DISCOVERY_PORT}\\b`, 'i').test(text);
  if (hasTcp && hasUdp) return { ...base, state: 'allowed' };
  return { ...base, state: 'no-rule', openPorts: text.slice(0, 200) };
}

/* ------------------------------------------------------------------ *
 *  Writing. One UAC prompt, and only when asked for.
 * ------------------------------------------------------------------ */

function repairScript(exe) {
  return `
$ErrorActionPreference = 'Continue'
$exe = ${q(exe)}

# A dismissed prompt leaves a BLOCK rule behind, and in Windows Firewall a block
# always beats an allow. Adding permission without clearing these would look
# like it worked and change nothing at all.
Get-NetFirewallApplicationFilter -Program $exe -ErrorAction SilentlyContinue |
  Get-NetFirewallRule -ErrorAction SilentlyContinue |
  Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' } |
  Remove-NetFirewallRule -ErrorAction SilentlyContinue

# Ours, if this has been run before. Replaced rather than duplicated.
Remove-NetFirewallRule -DisplayName '${RULE_PREFIX}*' -ErrorAction SilentlyContinue

$ErrorActionPreference = 'Stop'
New-NetFirewallRule -DisplayName ${q(BOARDS_RULE)} \`
  -Description 'Lets other computers on your own network hand a board to GazBoard. Added by GazBoard itself; safe to delete.' \`
  -Direction Inbound -Program $exe -Action Allow -Profile ${PROFILES} \`
  -Protocol TCP -LocalPort ${TRANSFER_PORT} | Out-Null

New-NetFirewallRule -DisplayName ${q(DISCOVERY_RULE)} \`
  -Description 'Lets GazBoard hear other GazBoards announcing themselves on your own network. Added by GazBoard itself; safe to delete.' \`
  -Direction Inbound -Program $exe -Action Allow -Profile ${PROFILES} \`
  -Protocol UDP -LocalPort ${DISCOVERY_PORT} | Out-Null
exit 0`;
}

const removeScript = () => `
$ErrorActionPreference = 'Continue'
Remove-NetFirewallRule -DisplayName '${RULE_PREFIX}*' -ErrorAction SilentlyContinue
exit 0`;

/** True when the failure was somebody saying no to the UAC prompt. */
const wasCancelled = (r) =>
  r.code === 1223 || /cancel+ed|operation was canceled/i.test(r.err || '');

/**
 * Clear the blocks and add the permission. Raises one UAC prompt.
 *
 * The result is not taken from the exit code. Whether it worked is decided by
 * reading the firewall again afterwards, because that is the only answer worth
 * reporting - a script can exit 0 having achieved nothing.
 */
/**
 * What the firewall on THIS machine has been told about this program.
 *
 * Note what this is NOT: a test that another computer can actually reach this
 * one. That cannot be done from here - a connection to your own machine never
 * crosses the firewall - so every platform below reads rules and reasons about
 * them. The wording each produces says so rather than claiming more.
 *
 * `state` is the part to act on, and it means the same thing everywhere:
 *   allowed  - something is letting us in
 *   blocked  - something is explicitly turning us away
 *   no-rule  - a firewall is running and nothing is letting us in
 *   off      - no firewall is running, so nothing is in the way
 *   unknown  - it could not be read; say so rather than guess
 *
 * @returns {Promise<object>} always resolves, never throws
 */
async function inspect(exe = process.execPath) {
  // `repairable` rides along on every answer so the UI never has to guess from
  // which fields happen to be present which platform it is looking at.
  const fix = repairable();
  try {
    if (process.platform === 'win32') return { ...(await winInspect(exe)), repairable: fix };
    if (process.platform === 'darwin') return { ...(await macInspect(exe)), repairable: fix };
    if (process.platform === 'linux') return { ...(await linuxInspect(exe)), repairable: fix };
  } catch (e) {
    return { supported: true, repairable: fix, state: 'unknown', program: exe, detail: e && e.message };
  }
  return { supported: false, repairable: false, state: 'unsupported-platform', program: exe };
}

/**
 * Clear the blocks and add the permission. Windows only, and one UAC prompt.
 *
 * Everywhere else this refuses with `reason: 'manual'` and the caller shows
 * manualCommands() instead - deliberately, see the note at the top of the file.
 *
 * On Windows the result is not taken from the exit code. Whether it worked is
 * decided by reading the firewall again afterwards, because that is the only
 * answer worth reporting - a script can exit 0 having achieved nothing.
 */
async function repair(exe = process.execPath) {
  if (!supported()) return { ok: false, reason: 'unsupported-platform' };
  if (!repairable()) return { ok: false, reason: 'manual', after: await inspect(exe) };
  const r = await elevated(repairScript(exe), { timeoutMs: 120000 });
  if (wasCancelled(r)) return { ok: false, reason: 'cancelled', after: await inspect(exe) };
  const after = await inspect(exe);
  if (after.state === 'allowed') return { ok: true, after };
  return { ok: false, reason: 'failed', detail: (r.err || '').trim().slice(0, 300), after };
}

/** Take our rules away again. Also one UAC prompt, and also only when asked. */
async function remove(exe = process.execPath) {
  if (!repairable()) return { ok: false, reason: 'manual' };
  const r = await elevated(removeScript(), { timeoutMs: 120000 });
  if (wasCancelled(r)) return { ok: false, reason: 'cancelled', after: await inspect(exe) };
  const after = await inspect(exe);
  return { ok: after.ours === 0, after };
}

/**
 * The same thing as text, for the case where the app cannot do it.
 *
 * A managed machine may refuse elevation outright, and then the useful thing to
 * hand somebody is not an apology - it is the two lines their IT person needs.
 */
function manualCommands(exe = process.execPath, plat = process.platform, tool = null) {
  if (plat === 'win32') {
    return [
      `New-NetFirewallRule -DisplayName "${BOARDS_RULE}" -Direction Inbound -Program "${exe}" -Action Allow -Profile ${PROFILES} -Protocol TCP -LocalPort ${TRANSFER_PORT}`,
      `New-NetFirewallRule -DisplayName "${DISCOVERY_RULE}" -Direction Inbound -Program "${exe}" -Action Allow -Profile ${PROFILES} -Protocol UDP -LocalPort ${DISCOVERY_PORT}`
    ];
  }
  if (plat === 'darwin') {
    const app = macAppPath(exe);
    // --add puts it in the list; --unblockapp is the one that matters, because
    // a dismissed macOS prompt lands the app in the list as blocked, and being
    // listed is not the same as being allowed.
    return [
      `sudo ${MAC_FW} --add "${app}"`,
      `sudo ${MAC_FW} --unblockapp "${app}"`
    ];
  }
  if (plat === 'linux') {
    if (tool === 'ufw') {
      return [
        `sudo ufw allow ${TRANSFER_PORT}/tcp comment '${BOARDS_RULE}'`,
        `sudo ufw allow ${DISCOVERY_PORT}/udp comment '${DISCOVERY_RULE}'`
      ];
    }
    if (tool === 'firewalld') {
      return [
        `sudo firewall-cmd --permanent --add-port=${TRANSFER_PORT}/tcp`,
        `sudo firewall-cmd --permanent --add-port=${DISCOVERY_PORT}/udp`,
        'sudo firewall-cmd --reload'
      ];
    }
    // Which one is in charge is not known, so offer both rather than pick wrong.
    return [
      `# firewalld:\nsudo firewall-cmd --permanent --add-port=${TRANSFER_PORT}/tcp\nsudo firewall-cmd --permanent --add-port=${DISCOVERY_PORT}/udp\nsudo firewall-cmd --reload`,
      `# ufw:\nsudo ufw allow ${TRANSFER_PORT}/tcp\nsudo ufw allow ${DISCOVERY_PORT}/udp`
    ];
  }
  return [];
}

module.exports = {
  supported, repairable, inspect, repair, remove, manualCommands,
  RULE_PREFIX, BOARDS_RULE, DISCOVERY_RULE, PROFILES, MAC_FW,
  // exported for the tests, which check the scripts say what they must say
  // without a machine of that kind to run them on
  _scripts: { inspectScript, repairScript, removeScript, macScript, LINUX_SCRIPT,
    macAppPath, fields, encode, q }
};
