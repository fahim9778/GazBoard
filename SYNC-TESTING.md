# Trying LAN sync by hand

Nothing here is in the app yet. This is a bench: two terminals, or two
computers, exercising the transport before any of it is wired to a button.

Unzip over your GazBoard folder — everything is a new file, nothing is replaced.

## What each machine needs

**Node, and nothing else.** The sync code uses only what Node ships with, so
there is no `npm install` for any of this — not even on the machine you unzip
into.

The second machine does not need the repository at all. In the zip there is:

    dist-sync/gazboard-sync.js

One file, 37 KB, no dependencies. It is for the OTHER computer — the one
without the repository. Copy it there however you like (USB stick, email,
LocalSend if you want the irony), put it in any folder, and run it from that
folder:

    node gazboard-sync.js receive
    node gazboard-sync.js send 192.168.0.14 7MPU-K7TM

**On the machine that has the repository, do not use that file.** It sits in a
`dist-sync` subfolder, so `node gazboard-sync.js` from the repo root will fail
with `Cannot find module`. Use the npm commands instead:

    npm run sync:receive
    npm run sync:send 192.168.0.14 7MPU-K7TM

or point at the file properly, if you prefer:

    node dist-sync/gazboard-sync.js send 192.168.0.14 7MPU-K7TM

The address is the **local IPv4 address of the receiving machine on your wifi** —
the `192.168.x.x` or `10.x.x.x` sort, not a web address and not anything from
outside your house. You do not have to go looking for it: the receiving machine
prints it, along with the code, the moment you start it.

    Address          192.168.0.14   (wlan0)
    PAIRING CODE     7MPU-K7TM

Copy those two straight into the send command on the other machine. No port
number — the transfer always uses the same one.

The `npm run sync:*` commands below are the same thing from inside the repo.
Use whichever suits the machine you are on. If you change the sync code later,
rebuild that single file with `npm run build:sync-demo`.

---

## 1. The quick one: does the engine work at all

```bash
npm run test:sync
```

Two GazBoards start inside one test run, pretending to be two machines, and pair
and swap a board. Expect **50 passed, 0 failed**, in about ten seconds.

This proves the code is sound. It does not prove anything about your wifi.

---

## The two ways to run a command

Every command below comes in two forms. Use whichever fits the machine you are
standing at — they do exactly the same thing.

| On the machine with the repository | On a machine with only the one file |
|---|---|
| `npm run sync:receive` | `node gazboard-sync.js receive` |
| `npm run sync:send <address> <code>` | `node gazboard-sync.js send <address> <code>` |
| `npm run sync:discover` | `node gazboard-sync.js discover` |

The steps below show the repository form. If the machine you are on only has
`gazboard-sync.js`, swap in the right-hand column.

---

## 2. Does your network let two machines talk

On **one** computer:

```bash
npm run sync:discover          # or: node gazboard-sync.js discover
```

On the **other** computer, same wifi:

```bash
npm run sync:receive           # or: node gazboard-sync.js receive
```

Within a few seconds the first terminal should list the second by name.

**If it does** — auto-discovery works on that network, which is the main thing
worth knowing. Try it on the BRAC network as well as at home; a dual-band router
at home is the more likely place for it to fail.

**If it does not** — sync can still work by typing an address, which is step 3.

---

## 3. Actually send a board between two computers

On the **receiving** computer:

```bash
npm run sync:receive           # or: node gazboard-sync.js receive
```

It prints something like:

```
  This machine     gazzali-desktop
  Address          192.168.0.14   (wlan0)
  Listening on     port 53318

  PAIRING CODE     7MPU-K7TM
  Valid until      9:41:22 PM
  Pairing          just for this session
```

On the **sending** computer, using that address and code:

```bash
npm run sync:send 192.168.0.14 7MPU-K7TM
# or: node gazboard-sync.js send 192.168.0.14 7MPU-K7TM
```

The receiving terminal will show what is arriving and ask:

```
  A board is arriving from  gazzali-laptop
  Name                      Sent from gazzali-laptop
  Items                     2
  Size                      2.0 KB

  Accept it? [y/N]
```

Press `y`. The board is written to a `sync-inbox` folder next to where you ran
the command, as a normal `.gazboard` file — **open it in GazBoard to prove it
survived the trip.**

Press anything else and nothing is written, and the sending terminal says it was
declined.

### Sending one of your own boards

```bash
npm run sync:send 192.168.0.14 7MPU-K7TM "C:\Users\User\Downloads\Lesson plan.gazboard"
# or: node gazboard-sync.js send 192.168.0.14 7MPU-K7TM "C:\...\Lesson plan.gazboard"
```

---

## 4. The things worth trying to break

**A wrong code.** Type the code wrong on the sender. It should refuse and say
how many attempts are left, and nothing should pair.

**Someone else's machine.** Run `npm run sync:send` against the receiver
*without* a valid code — it cannot get in. Only a paired device may send.

**A classroom.** Leave one receiver running and pair from two different senders
with the same code. Both should work: the code is a session, not a one-shot.

**Forgetting.** Ctrl+C the receiver and start it again. The old pairing is gone,
so the sender has to pair afresh — that is "just for this session" working.
Start it with `npm run sync:receive -- --remember` (or
`node gazboard-sync.js receive --remember`) and the pairing would be kept
instead, which is what your own two computers would use.

---

## What is NOT here yet

- Any of it inside GazBoard. No Settings switch, no device list, no button.
- The small preview on the accept prompt. The bench version prints the name and
  item count only.
- The keep-both / replace behaviour for a board that is already on the receiving
  machine. Right now every arrival is written as a new file in `sync-inbox`.

---

## If it goes wrong

**"Did not work: no answer from that address"** — the two machines cannot reach
each other. Check they are on the same wifi, and that the receiver is still
running. A VPN on either machine will also do this.

**Firewall prompt on Windows** — Node wants to accept connections. Allow it on
private networks. Without that, nothing arrives.

**It works one way but not the other** — this is the firewall, almost always.
Sending is an outgoing connection, which Windows allows without asking.
Receiving needs an incoming one, which it blocks unless permitted. So the
machine that cannot receive is the machine with the rule missing.

To check from the other computer, in PowerShell:

    Test-NetConnection 192.168.0.129 -Port 53318

`TcpTestSucceeded : True` means the port is open and the problem is elsewhere.
`False` means the firewall, or nothing listening.

To allow it, run PowerShell **as administrator** on the machine that cannot
receive:

    New-NetFirewallRule -DisplayName "GazBoard sync" -Direction Inbound `
      -Protocol TCP -LocalPort 53318 -Action Allow -Profile Private

Discovery can work while this fails, because discovery is UDP and the transfer
is TCP — the two are allowed separately.

**"not a GazBoard"** — something is answering on that address that is not this.
Check the address you typed.

**`Cannot find module ...gazboard-sync.js`** — you are on the machine with the
repository, and that file lives in `dist-sync`. Use `npm run sync:send` there.

**"no pairing in progress"** — the code you typed has expired. Codes last five
minutes. The receiving terminal prints a fresh one automatically when the old
one runs out, so look at its screen and use the newest code shown, not the one
you copied earlier.

**"that code did not match"** — read the code off the receiving screen again.
Codes are always four characters, a dash, then four more, and they never contain
`O`, `0`, `I` or `1` — those are left out precisely because they are misread.
So a code with a zero in it was misread, not mistyped by the other machine.

**Discovery finds nothing but sending by address works** — the network blocks
broadcast traffic between devices. Worth telling me, because it is exactly the
case the manual-address fallback exists for.
