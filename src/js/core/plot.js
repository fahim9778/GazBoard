// Formula graphs: reading what was typed, working out the curves, and the
// points worth marking on them.
//
// Nothing typed is ever run as code. A formula is read by a small parser of
// our own into a tree, and the tree is turned into a function that can only do
// arithmetic and call the maths functions listed below - so a formula on a
// board that came from somebody else can draw a curve, and nothing more.
//
// What can be typed, one formula per line:
//
//   y = x^2 - 3            a function of x (or just  x^2 - 3)
//   x = y^2                a function of y, drawn sideways
//   r = 2 sin(3θ)          polar: r as a function of θ (type theta or θ)
//   (cos(t), sin(2t))      parametric, t running over the graph's t range
//   x^2 + y^2 = 25         anything else with x and y in it: an equation,
//                          drawn wherever it holds (implicit)
//   (2, 3)                 a point
//   a = 2                  sets a slider; any other single letter used in a
//                          formula (a, b, c, k, m, n…) gets a slider too
//
// Multiplication can be left out (2x, 3sin(x), (x+1)(x-1), 2πr), ^ is a power,
// |x| is the absolute value, and the usual functions are known by name.

import { t } from '../i18n.js';

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

const FUNCS = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan,
  arcsin: Math.asin, arccos: Math.acos, arctan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  sec: (v) => 1 / Math.cos(v), csc: (v) => 1 / Math.sin(v), cot: (v) => 1 / Math.tan(v),
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, exp: Math.exp,
  ln: Math.log, log: Math.log10, lg: Math.log10, log2: Math.log2,
  floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign, sgn: Math.sign
};
const FUNCS2 = { min: Math.min, max: Math.max, atan2: Math.atan2, mod: (a, b) => ((a % b) + b) % b };
const CONSTS = { pi: Math.PI, 'π': Math.PI, e: Math.E, tau: Math.PI * 2 };
const GREEK = { theta: 'θ', 'θ': 'θ', phi: 'φ', 'φ': 'φ' };

/** The letters that are not sliders: they are what the curve is drawn along. */
export const AXIS_VARS = new Set(['x', 'y', 't', 'r', 'θ', 'φ']);

export class FormulaError extends Error {}

function tokenize(src) {
  const out = [];
  const s = String(src).replace(/[−–]/g, '-').replace(/[×·∙]/g, '*').replace(/÷/g, '/').replace(/²/g, '^2').replace(/³/g, '^3').replace(/√/g, 'sqrt');
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(s.slice(i));
      if (!m) throw new FormulaError(t('“{c}” is not a number', { c }));
      out.push({ k: 'num', v: parseFloat(m[0]) }); i += m[0].length; continue;
    }
    if (/[A-Za-zπθφ]/.test(c)) {
      const m = /^[A-Za-zπθφ]+[0-9]*/.exec(s.slice(i));
      out.push({ k: 'name', v: m[0] }); i += m[0].length; continue;
    }
    if ('+-*/^(),|=<>!'.includes(c)) { out.push({ k: c }); i++; continue; }
    throw new FormulaError(t('“{c}” cannot be used in a formula', { c }));
  }
  return out;
}

/*
 * A run of letters is read as the longest names it can make, so "sinx" is
 * sin(x), "xy" is x·y and "2pir" is 2·π·r - the way it is written on a board.
 */
function splitName(name) {
  const known = [...Object.keys(FUNCS), ...Object.keys(FUNCS2), ...Object.keys(CONSTS), ...Object.keys(GREEK)].sort((a, b) => b.length - a.length);
  if (FUNCS[name] || FUNCS2[name] || name in CONSTS || name in GREEK) return [name];
  if (/^[A-Za-z][0-9]+$/.test(name)) return [name];         // a1, b2: one name
  const parts = [];
  let i = 0;
  while (i < name.length) {
    const hit = known.find((k) => name.startsWith(k, i));
    if (hit) { parts.push(hit); i += hit.length; continue; }
    parts.push(name[i]); i++;
  }
  return parts;
}

function parse(tokens) {
  // names are split into what they spell first
  const toks = [];
  tokens.forEach((tk, j) => {
    if (tk.k !== 'name') { toks.push(tk); return; }
    const parts = splitName(tk.v);
    // three or more letters straight before a bracket, none of them a known name: a function GazBoard does not have
    if (parts.length >= 3 && parts.every((q) => q.length === 1) && tokens[j + 1] && tokens[j + 1].k === '(')
      throw new FormulaError(t('“{name}” is not a function GazBoard knows', { name: tk.v }));
    for (const q of parts) toks.push({ k: 'name', v: q });
  });
  let i = 0;
  const peek = () => toks[i];
  const take = (k) => { const tk = toks[i]; if (!tk || (k && tk.k !== k)) throw new FormulaError(k ? t('“{k}” is missing', { k }) : t('The formula ends too soon')); i++; return tk; };
  const startsTerm = (tk) => tk && (tk.k === 'num' || tk.k === 'name' || tk.k === '(' || tk.k === '|');

  function expr() { return additive(); }
  function additive() {
    let n = term();
    while (peek() && (peek().k === '+' || peek().k === '-')) { const op = take().k; n = { op, a: n, b: term() }; }
    return n;
  }
  function term() {
    let n = unary();
    for (;;) {
      const tk = peek();
      if (tk && (tk.k === '*' || tk.k === '/')) { take(); n = { op: tk.k, a: n, b: unary() }; continue; }
      // written next to each other: multiplied (2x, 3sin x, (x+1)(x-1)) - but not across a |…| closing bar
      if (startsTerm(tk) && !(tk.k === '|' && inAbs > 0)) { n = { op: '*', a: n, b: power(), implicit: true }; continue; }
      return n;
    }
  }
  function unary() {
    const tk = peek();
    if (tk && tk.k === '-') { take(); return { op: 'neg', a: unary() }; }
    if (tk && tk.k === '+') { take(); return unary(); }
    return power();
  }
  function power() {
    let n = postfix();
    if (peek() && peek().k === '^') { take(); n = { op: '^', a: n, b: unary() }; }
    return n;
  }
  function postfix() {
    let n = atom();
    while (peek() && peek().k === '!') { take(); n = { op: 'fact', a: n }; }
    return n;
  }
  let inAbs = 0;
  function atom() {
    const tk = take();
    if (tk.k === 'num') return { num: tk.v };
    if (tk.k === '(') {
      const a = expr();
      if (peek() && peek().k === ',') {             // a pair: a point, or a parametric curve
        take(); const b = expr(); take(')');
        return { pair: [a, b] };
      }
      take(')');
      return { group: a };
    }
    if (tk.k === '|') { inAbs++; const a = expr(); take('|'); inAbs--; return { fn: 'abs', args: [a] }; }
    if (tk.k === 'name') {
      const name = GREEK[tk.v] || tk.v;
      if (FUNCS[name] || FUNCS2[name]) {
        // sin(x), sin x, sin^2(x) (= (sin x)^2)
        let pow = null;
        if (peek() && peek().k === '^') { take(); pow = postfix(); }
        let args;
        if (peek() && peek().k === '(') {
          take(); args = [expr()];
          while (peek() && peek().k === ',') { take(); args.push(expr()); }
          take(')');
        } else args = [power()];
        if (FUNCS2[name] ? args.length !== 2 : args.length !== 1) throw new FormulaError(FUNCS2[name] ? t('{name} needs two values', { name }) : t('{name} needs one value', { name }));
        const call = { fn: name, args };
        return pow ? { op: '^', a: call, b: pow } : call;
      }
      if (name in CONSTS) return { con: name };
      if (/^[A-Za-zθφ][0-9]*$/.test(name)) return { v: name };
      throw new FormulaError(t('“{name}” is not something GazBoard knows', { name: tk.v }));
    }
    throw new FormulaError(t('“{what}” is in the wrong place', { what: tk.k }));
  }

  const n = expr();
  if (i < toks.length) throw new FormulaError(t('“{what}” is in the wrong place', { what: toks[i].k === 'name' || toks[i].k === 'num' ? toks[i].v : toks[i].k }));
  return n;
}

/** The letters a tree uses. */
function varsOf(n, out = new Set()) {
  if (!n) return out;
  if (n.v) out.add(n.v);
  for (const k of ['a', 'b', 'group']) if (n[k]) varsOf(n[k], out);
  if (n.args) n.args.forEach((x) => varsOf(x, out));
  if (n.pair) n.pair.forEach((x) => varsOf(x, out));
  return out;
}

function fact(v) {
  if (!(v >= 0) || v > 170) return NaN;
  if (Number.isInteger(v)) { let r = 1; for (let i = 2; i <= v; i++) r *= i; return r; }
  // the gamma function for the rest (Lanczos)
  const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  const z = v; let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const tt = z + g + 0.5;
  return Math.sqrt(2 * Math.PI) * Math.pow(tt, z + 0.5) * Math.exp(-tt) * x;
}

/** The tree as a function of an environment {x, y, t, θ, a, b…}. Only arithmetic and the functions above. */
function compile(n) {
  if ('num' in n) { const v = n.num; return () => v; }
  if (n.con) { const v = CONSTS[n.con]; return () => v; }
  if (n.v) { const k = n.v; return (env) => { const v = env[k]; return v === undefined ? NaN : v; }; }
  if (n.group) return compile(n.group);
  if (n.pair) throw new FormulaError(t('A pair of values cannot be used inside a formula'));
  if (n.fn) {
    const f = FUNCS[n.fn] || FUNCS2[n.fn];
    const args = n.args.map(compile);
    if (args.length === 1) { const a = args[0]; return (env) => f(a(env)); }
    const [a, b] = args; return (env) => f(a(env), b(env));
  }
  const a = compile(n.a);
  switch (n.op) {
    case 'neg': return (env) => -a(env);
    case 'fact': return (env) => fact(a(env));
  }
  const b = compile(n.b);
  switch (n.op) {
    case '+': return (env) => a(env) + b(env);
    case '-': return (env) => a(env) - b(env);
    case '*': return (env) => a(env) * b(env);
    case '/': return (env) => a(env) / b(env);
    case '^': return (env) => {
      const x = a(env), p = b(env);
      // a negative number to an odd root (x^(1/3)) is still a real number
      if (x < 0 && !Number.isInteger(p)) {
        const q = 1 / p;
        if (Number.isFinite(q) && Math.abs(q - Math.round(q)) < 1e-9 && Math.round(q) % 2) return -Math.pow(-x, p);
      }
      return Math.pow(x, p);
    };
  }
  throw new FormulaError(t('This formula cannot be worked out'));
}

/* ------------------------------------------------------------------ *
 * The typeset label
 * ------------------------------------------------------------------ */

const TEX_FN = { sin: '\\sin', cos: '\\cos', tan: '\\tan', sinh: '\\sinh', cosh: '\\cosh', tanh: '\\tanh', sec: '\\sec', csc: '\\csc', cot: '\\cot',
  asin: '\\arcsin', acos: '\\arccos', atan: '\\arctan', arcsin: '\\arcsin', arccos: '\\arccos', arctan: '\\arctan', ln: '\\ln', log: '\\log', lg: '\\lg', exp: '\\exp',
  min: '\\min', max: '\\max', sign: '\\operatorname{sign}', sgn: '\\operatorname{sgn}', log2: '\\log_2', cbrt: '\\sqrt[3]', mod: '\\operatorname{mod}', atan2: '\\operatorname{atan2}' };
const TEX_VAR = { 'θ': '\\theta', 'φ': '\\varphi' };
const PREC = { '+': 1, '-': 1, '*': 2, '/': 2, neg: 3, '^': 4 };

function precOf(n) { return n.op ? PREC[n.op] || 5 : 9; }

export function toTex(n) {
  if (!n) return '';
  if ('num' in n) return fmtNum(n.num);
  if (n.con) return n.con === 'e' ? 'e' : n.con === 'tau' ? '\\tau' : '\\pi';
  if (n.v) return TEX_VAR[n.v] || (n.v.length > 1 ? `${n.v[0]}_{${n.v.slice(1)}}` : n.v);
  if (n.group) return `\\left(${toTex(n.group)}\\right)`;
  if (n.pair) return `\\left(${toTex(n.pair[0])},\\ ${toTex(n.pair[1])}\\right)`;
  if (n.fn) {
    if (n.fn === 'sqrt') return `\\sqrt{${toTex(n.args[0])}}`;
    if (n.fn === 'cbrt') return `\\sqrt[3]{${toTex(n.args[0])}}`;
    if (n.fn === 'abs') return `\\left|${toTex(n.args[0])}\\right|`;
    if (n.fn === 'floor') return `\\lfloor ${toTex(n.args[0])} \\rfloor`;
    if (n.fn === 'ceil') return `\\lceil ${toTex(n.args[0])} \\rceil`;
    const name = TEX_FN[n.fn] || `\\operatorname{${n.fn}}`;
    return `${name}\\left(${n.args.map(toTex).join(', ')}\\right)`;
  }
  const wrap = (c, need) => (precOf(c) < need ? `\\left(${toTex(c)}\\right)` : toTex(c));
  switch (n.op) {
    case 'neg': return `-${wrap(n.a, 3)}`;
    case 'fact': return `${wrap(n.a, 9)}!`;
    case '+': return `${toTex(n.a)} + ${toTex(n.b)}`;
    case '-': return `${toTex(n.a)} - ${wrap(n.b, 2)}`;
    case '*': {
      const l = wrap(n.a, 2), r = wrap(n.b, 2);
      // 2x, 3\sin, ab - but 2 \cdot 3 between two numbers
      const dot = ('num' in (n.b.group ? {} : n.b)) || (!n.implicit && !(n.b.v || n.b.con || n.b.fn || n.b.group));
      return dot ? `${l} \\cdot ${r}` : `${l}${/[a-zA-Z0-9}]$/.test(l) && /^[a-zA-Z0-9]/.test(r) ? ' ' : ''}${r}`;
    }
    case '/': return `\\frac{${toTex(n.a)}}{${toTex(n.b)}}`;
    case '^': return `${wrap(n.a, 5)}^{${toTex(n.b.group || n.b)}}`;
  }
  return '';
}

export function fmtNum(v, digits = 4) {
  if (!Number.isFinite(v)) return '?';
  if (Math.abs(v) < 1e-10) return '0';
  const a = Math.abs(v);
  if (a >= 1e6 || a < 1e-4) return v.toExponential(2).replace('e+', 'e');
  return String(+v.toFixed(digits));
}

/* ------------------------------------------------------------------ *
 * What a line of the graph is
 * ------------------------------------------------------------------ */

/**
 * Read one line of a graph.
 * @returns {{kind:'fx'|'fy'|'polar'|'param'|'implicit'|'point'|'slider'|'empty', tex:string, vars:Set<string>, ...}}
 *   fx: f(env) gives y for env.x; fy: x for env.y; polar: r for env.θ; param: fx/fy of env.t;
 *   implicit: F(env) whose zero set is the curve; point: a fixed (x, y); slider: name = value
 */
export function readFormula(src) {
  const text = String(src || '').trim();
  if (!text) return { kind: 'empty', tex: '', vars: new Set() };
  const tokens = tokenize(text);
  // ignore a trailing "for 0 < x < 2" style comment? kept simple: one = at most, or none
  const eq = tokens.findIndex((tk) => tk.k === '=');
  if (eq >= 0 && tokens.slice(eq + 1).some((tk) => tk.k === '=')) throw new FormulaError(t('Only one “=” please'));
  if (tokens.some((tk) => tk.k === '<' || tk.k === '>')) throw new FormulaError(t('Inequalities are not drawn yet; use “=”'));
  if (eq < 0) {
    const n = parse(tokens);
    if (n.pair) {
      const vars = varsOf(n);
      if (vars.has('t')) return { kind: 'param', x: compile(n.pair[0]), y: compile(n.pair[1]), tex: toTex(n), vars: without(vars, ['t']) };
      return { kind: 'point', x: compile(n.pair[0]), y: compile(n.pair[1]), tex: toTex(n), vars };
    }
    const vars = varsOf(n);
    if (vars.has('y')) throw new FormulaError(t('With y in it, a formula needs an “=”, like x^2 + y^2 = 4'));
    if (vars.has('θ') || vars.has('φ')) return polar(n, vars);
    return { kind: 'fx', f: compile(n), tex: `y = ${toTex(n)}`, vars: without(vars, ['x']) };
  }
  if (eq === 0 || eq === tokens.length - 1) throw new FormulaError(t('Something is missing on one side of “=”'));
  const L = parse(tokens.slice(0, eq)), R = parse(tokens.slice(eq + 1));
  const lv = L.v, rv = varsOf(R);
  const tex = `${toTex(L)} = ${toTex(R)}`;
  // a = 2: a slider's value
  if (lv && !AXIS_VARS.has(lv) && rv.size === 0) return { kind: 'slider', name: lv, value: compile(R)({}), tex, vars: new Set() };
  if (lv === 'y' && !rv.has('y')) {
    if (rv.has('θ') || rv.has('φ')) throw new FormulaError(t('Use r = … for a polar curve'));
    return { kind: 'fx', f: compile(R), tex, vars: without(rv, ['x']) };
  }
  if (lv === 'x' && !rv.has('x') && !rv.has('y') && rv.has('t')) throw new FormulaError(t('Write a parametric curve as (x(t), y(t))'));
  if (lv === 'x' && !rv.has('x')) return { kind: 'fy', f: compile(R), tex, vars: without(rv, ['y']) };
  if (lv === 'r' && !rv.has('x') && !rv.has('y') && !rv.has('r')) return polar(R, rv, tex);
  const lvs = varsOf(L);
  const all = new Set([...lvs, ...rv]);
  if (all.has('x') || all.has('y')) {
    const fl = compile(L), fr = compile(R);
    return { kind: 'implicit', F: (env) => fl(env) - fr(env), tex, vars: without(all, ['x', 'y']) };
  }
  throw new FormulaError(t('A formula needs x, y, t or θ in it to draw anything'));
}

function polar(n, vars, tex) {
  const name = vars.has('φ') ? 'φ' : 'θ';
  const f = compile(n);
  return { kind: 'polar', f: (env) => f({ ...env, θ: env.θ, φ: env.θ }), tex: tex || `r = ${toTex(n)}`, vars: without(vars, ['θ', 'φ']), angle: name };
}

function without(set, names) { const s = new Set(set); for (const k of names) s.delete(k); return s; }

/** Every slider letter a graph's formulas use, in the order they first appear, and the values lines like "a = 2" give them. */
export function slidersOf(lines) {
  const order = [], set = new Set(), given = {};
  for (const r of lines) {
    if (!r || r.error) continue;
    if (r.kind === 'slider') { given[r.name] = r.value; if (!set.has(r.name)) { set.add(r.name); order.push(r.name); } continue; }
    for (const v of r.vars || []) if (!AXIS_VARS.has(v) && !set.has(v)) { set.add(v); order.push(v); }
  }
  return { names: order, given };
}

/* ------------------------------------------------------------------ *
 * Working out the curves
 * ------------------------------------------------------------------ */

/**
 * Every line of a graph, read and drawn, in graph coordinates.
 * @param {object} g  the graph object (exprs, xMin…, tMin, tMax, params)
 * @param {number} pxW, pxH  roughly how many pixels the graph covers, for how finely to sample
 * @returns {{curves: Array<{i, kind, color, paths: number[][], tex, error?}>, env: object}}
 */
export function computeGraph(g, pxW = 600, pxH = 400) {
  const view = { x0: g.xMin, x1: g.xMax, y0: g.yMin, y1: g.yMax };
  const read = (g.exprs || []).map((e) => {
    try { return { ...readFormula(e.src), src: e.src }; } catch (err) { return { kind: 'error', error: err instanceof FormulaError ? err.message : t('This formula cannot be read'), src: e.src, vars: new Set() }; }
  });
  const { names, given } = slidersOf(read);
  const env = {};
  for (const n of names) {
    const p = g.params && g.params[n];
    env[n] = p && Number.isFinite(p.v) ? p.v : Number.isFinite(given[n]) ? given[n] : 1;
  }
  const curves = read.map((r, i) => {
    const e = (g.exprs || [])[i] || {};
    const c = { i, kind: r.kind, color: e.color || '#0063b1', tex: r.tex || '', paths: [], error: r.error || null, hidden: e.on === false, read: r };
    if (r.kind === 'error' || r.kind === 'empty' || r.kind === 'slider' || c.hidden) return c;
    try {
      if (r.kind === 'fx') c.paths = sampleFx((x) => r.f({ ...env, x }), view, pxW, pxH);
      else if (r.kind === 'fy') c.paths = sampleFx((y) => r.f({ ...env, y }), { x0: view.y0, x1: view.y1, y0: view.x0, y1: view.x1 }, pxH, pxW).map((p) => swapXY(p));
      else if (r.kind === 'polar') c.paths = sampleParam((th) => { const rr = r.f({ ...env, θ: th }); return [rr * Math.cos(th), rr * Math.sin(th)]; }, g.thMin ?? 0, g.thMax ?? Math.PI * 2, view, pxW, pxH);
      else if (r.kind === 'param') c.paths = sampleParam((tt) => [r.x({ ...env, t: tt }), r.y({ ...env, t: tt })], g.tMin ?? 0, g.tMax ?? Math.PI * 2, view, pxW, pxH);
      else if (r.kind === 'implicit') c.paths = marchingSquares((x, y) => r.F({ ...env, x, y }), view, pxW, pxH);
      else if (r.kind === 'point') { const x = r.x(env), y = r.y(env); if (Number.isFinite(x) && Number.isFinite(y)) c.point = [x, y]; }
    } catch { c.error = t('This formula cannot be worked out'); }
    if (r.kind === 'fx') c.fx = (x) => r.f({ ...env, x });
    return c;
  });
  return { curves, env, sliders: names };
}

function swapXY(p) { const q = new Array(p.length); for (let i = 0; i < p.length; i += 2) { q[i] = p[i + 1]; q[i + 1] = p[i]; } return q; }

/*
 * y = f(x), across the width. Evenly to start with, then more finely wherever
 * the curve bends sharply, so a tight curve is smooth without sampling the
 * straight bits needlessly. Where it leaves the real numbers, or leaps across
 * an asymptote (tan x at π/2), the line is broken rather than drawn as a wall.
 */
export function sampleFx(f, v, pxW, pxH) {
  const n = Math.max(64, Math.min(2000, Math.round(pxW)));
  const span = v.x1 - v.x0, ySpan = v.y1 - v.y0;
  const tolY = ySpan / Math.max(50, pxH) * 0.6;
  const big = ySpan * 4;
  const paths = [];
  let cur = null;
  const val = (x) => { const y = f(x); return Number.isFinite(y) ? y : NaN; };
  const push = (x, y) => { if (!cur) { cur = []; paths.push(cur); } cur.push(x, y); };
  const end = () => { cur = null; };
  let px = v.x0, py = val(px);
  if (!Number.isNaN(py)) push(px, clampY(py, v, ySpan));
  const refine = (x0, y0, x1, y1, depth) => {
    const xm = (x0 + x1) / 2, ym = val(xm);
    if (depth > 0 && !Number.isNaN(ym) && !Number.isNaN(y0) && !Number.isNaN(y1)) {
      const lin = (y0 + y1) / 2;
      if (Math.abs(ym - lin) > tolY && Math.abs(y1 - y0) < big) {
        refine(x0, y0, xm, ym, depth - 1);
        refine(xm, ym, x1, y1, depth - 1);
        return;
      }
    }
    step(xm, ym, depth); step(x1, y1, depth);
  };
  const step = (x, y) => {
    if (Number.isNaN(y)) { end(); return; }
    push(x, clampY(y, v, ySpan));
  };
  for (let i = 1; i <= n; i++) {
    const x = v.x0 + (span * i) / n, y = val(x);
    // a jump across the whole picture with a sign flip far off the chart is an asymptote: break there
    const leap = !Number.isNaN(py) && !Number.isNaN(y) && Math.abs(y - py) > ySpan * 0.9 &&
      (Math.max(Math.abs(y - (v.y0 + v.y1) / 2), Math.abs(py - (v.y0 + v.y1) / 2)) > ySpan * 0.6) && asymptote(f, px, x);
    if (leap) { end(); push(x, clampY(y, v, ySpan)); }
    else if (Number.isNaN(py) || Number.isNaN(y)) {
      // the edge of where it is defined (sqrt x at 0): found exactly, so the curve reaches it
      if (Number.isNaN(py) !== Number.isNaN(y)) {
        const xe = edgeOf(val, px, x);
        if (Number.isNaN(py)) { const ye = val(xe); if (!Number.isNaN(ye)) push(xe, clampY(ye, v, ySpan)); }
        else { const ye = val(xe); if (!Number.isNaN(ye)) push(xe, clampY(ye, v, ySpan)); end(); }
      }
      if (!Number.isNaN(y)) push(x, clampY(y, v, ySpan));
    } else refine(px, py, x, y, 6);
    px = x; py = y;
  }
  return paths.filter((p) => p.length >= 4);
}

/** Keep wild values to a few screens beyond the chart, so lines leave the picture at the right angle without huge numbers. */
function clampY(y, v, ySpan) { return Math.max(v.y0 - ySpan * 3, Math.min(v.y1 + ySpan * 3, y)); }

/** Between a and b, does f blow up (rather than just being steep)? */
function asymptote(f, a, b) {
  let lo = a, hi = b, ylo = f(a);
  for (let k = 0; k < 30; k++) {
    const m = (lo + hi) / 2, ym = f(m);
    if (!Number.isFinite(ym)) return true;
    if (Math.sign(ym) === Math.sign(ylo)) { lo = m; ylo = ym; } else hi = m;
  }
  const yl = f(lo), yh = f(hi);
  return Math.abs(yl - yh) > 1e6 * (Math.abs(b - a) + 1e-12) || !Number.isFinite(yl) || !Number.isFinite(yh) ||
    (Math.sign(yl) !== Math.sign(yh) && Math.min(Math.abs(yl), Math.abs(yh)) > 1e3 * (Math.abs(b - a)));
}

/** Where a function stops (or starts) being defined, between a and b. */
function edgeOf(val, a, b) {
  const aNaN = Number.isNaN(val(a));
  let lo = a, hi = b;
  for (let k = 0; k < 40; k++) {
    const m = (lo + hi) / 2;
    if (Number.isNaN(val(m)) === aNaN) lo = m; else hi = m;
  }
  return aNaN ? hi : lo;
}

/* A curve along a parameter (parametric, polar): finely, and more finely where it moves fast. */
export function sampleParam(fn, t0, t1, v, pxW, pxH) {
  if (!(t1 > t0)) return [];
  const n = 1200;
  const sx = pxW / (v.x1 - v.x0), sy = pxH / (v.y1 - v.y0);
  const paths = [];
  let cur = null;
  const at = (tt) => { const p = fn(tt); return Number.isFinite(p[0]) && Number.isFinite(p[1]) ? p : null; };
  let prev = at(t0), pt = t0;
  if (prev) { cur = [prev[0], prev[1]]; paths.push(cur); }
  const add = (p) => { if (!cur) { cur = []; paths.push(cur); } cur.push(p[0], p[1]); };
  const go = (ta, pa, tb, pb, depth) => {
    const d = Math.hypot((pb[0] - pa[0]) * sx, (pb[1] - pa[1]) * sy);
    if (d > 3 && depth > 0) {
      const tm = (ta + tb) / 2, pm = at(tm);
      if (!pm) { cur = null; return; }
      go(ta, pa, tm, pm, depth - 1); go(tm, pm, tb, pb, depth - 1);
      return;
    }
    // still far apart at the finest step: a jump, not a line
    if (d > Math.max(pxW, pxH) * 0.5) { cur = null; }
    add(pb);
  };
  for (let i = 1; i <= n; i++) {
    const tt = t0 + ((t1 - t0) * i) / n, p = at(tt);
    if (!p) { cur = null; prev = null; pt = tt; continue; }
    if (!prev) { cur = null; add(p); }
    else go(pt, prev, tt, p, 8);
    prev = p; pt = tt;
  }
  return paths.filter((p) => p.length >= 4);
}

/*
 * F(x, y) = 0, by marching squares: the chart is cut into small squares, and
 * wherever F changes sign along a square's edges the curve passes through it,
 * at the spot found by sharpening between the corners. A sign change with a
 * huge jump (1/x across 0) is not a crossing and is left out.
 */
export function marchingSquares(F, v, pxW, pxH) {
  const nx = Math.max(40, Math.min(360, Math.round(pxW / 3))), ny = Math.max(30, Math.min(360, Math.round(pxH / 3)));
  const dx = (v.x1 - v.x0) / nx, dy = (v.y1 - v.y0) / ny;
  // nudged off the grid lines so a curve through a grid point (x^2 = y^2 at 0) is not missed
  const ox = dx * 0.0137, oy = dy * 0.0193;
  const vals = new Float64Array((nx + 1) * (ny + 1));
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
    const r = F(v.x0 + i * dx + ox, v.y0 + j * dy + oy);
    vals[j * (nx + 1) + i] = Number.isFinite(r) ? r : NaN;
  }
  const V = (i, j) => vals[j * (nx + 1) + i];
  const X = (i) => v.x0 + i * dx + ox, Y = (j) => v.y0 + j * dy + oy;
  const segs = [];
  const cross = (xa, ya, fa, xb, yb, fb) => {
    // sharpen with a few steps of bisection on the real function
    let lo = 0, hi = 1, flo = fa;
    for (let k = 0; k < 10; k++) {
      const m = (lo + hi) / 2, fm = F(xa + (xb - xa) * m, ya + (yb - ya) * m);
      if (!Number.isFinite(fm)) break;
      if (Math.sign(fm) === Math.sign(flo)) { lo = m; flo = fm; } else hi = m;
    }
    const m = (lo + hi) / 2;
    return [xa + (xb - xa) * m, ya + (yb - ya) * m];
  };
  const jumpy = (a, b) => Math.abs(a - b) > 1e3 * (Math.abs(a) + Math.abs(b) + 1e-9) && Math.min(Math.abs(a), Math.abs(b)) > 1e3;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const a = V(i, j), b = V(i + 1, j), c = V(i + 1, j + 1), d = V(i, j + 1);
    if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(c) || Number.isNaN(d)) continue;
    const pts = [];
    const edge = (fa, fb, xa, ya, xb, yb) => {
      if ((fa < 0) !== (fb < 0) && !jumpy(fa, fb)) pts.push(cross(xa, ya, fa, xb, yb, fb));
    };
    edge(a, b, X(i), Y(j), X(i + 1), Y(j));
    edge(b, c, X(i + 1), Y(j), X(i + 1), Y(j + 1));
    edge(c, d, X(i + 1), Y(j + 1), X(i), Y(j + 1));
    edge(d, a, X(i), Y(j + 1), X(i), Y(j));
    if (pts.length === 2) segs.push(pts[0][0], pts[0][1], pts[1][0], pts[1][1]);
    else if (pts.length === 4) {
      // a saddle: which way the lines pair up depends on the middle
      const mid = F(X(i) + dx / 2, Y(j) + dy / 2);
      if ((mid < 0) === (a < 0)) { segs.push(pts[0][0], pts[0][1], pts[3][0], pts[3][1], pts[1][0], pts[1][1], pts[2][0], pts[2][1]); }
      else { segs.push(pts[0][0], pts[0][1], pts[1][0], pts[1][1], pts[2][0], pts[2][1], pts[3][0], pts[3][1]); }
    }
  }
  return joinSegments(segs, Math.min(dx, dy) * 1e-3);
}

/** Loose segments joined end to end into lines, so the curve is drawn as one smooth stroke. */
function joinSegments(segs, eps) {
  const n = segs.length / 4;
  if (!n) return [];
  const key = (x, y) => `${Math.round(x / eps)},${Math.round(y / eps)}`;
  const ends = new Map();
  const add = (k, s) => { const l = ends.get(k); if (l) l.push(s); else ends.set(k, [s]); };
  for (let s = 0; s < n; s++) { add(key(segs[s * 4], segs[s * 4 + 1]), s); add(key(segs[s * 4 + 2], segs[s * 4 + 3]), s); }
  const used = new Uint8Array(n);
  const paths = [];
  const other = (s, k) => {
    const list = ends.get(k) || [];
    for (const t of list) if (!used[t] && t !== s) return t;
    return -1;
  };
  for (let s = 0; s < n; s++) {
    if (used[s]) continue;
    used[s] = 1;
    const line = [segs[s * 4], segs[s * 4 + 1], segs[s * 4 + 2], segs[s * 4 + 3]];
    // grow forwards, then backwards
    for (const dir of [1, -1]) {
      for (;;) {
        const x = dir > 0 ? line[line.length - 2] : line[0], y = dir > 0 ? line[line.length - 1] : line[1];
        const k = key(x, y);
        const sg = other(-1, k);
        if (sg < 0) break;
        used[sg] = 1;
        const ka = key(segs[sg * 4], segs[sg * 4 + 1]);
        const nx = ka === k ? segs[sg * 4 + 2] : segs[sg * 4], ny = ka === k ? segs[sg * 4 + 3] : segs[sg * 4 + 1];
        if (dir > 0) line.push(nx, ny); else line.unshift(nx, ny);
      }
    }
    paths.push(line);
  }
  return paths;
}

/* ------------------------------------------------------------------ *
 * The points worth marking
 * ------------------------------------------------------------------ */

/**
 * Roots, highest and lowest points, where a curve crosses the y-axis, and
 * where two curves cross - inside the chart, with nearly-the-same points
 * merged. Functions of x are worked out exactly; other curves from their
 * drawn lines, which is to a fraction of a pixel.
 * @returns {Array<{x, y, kind:'root'|'max'|'min'|'yint'|'cross'|'point', i, j?}>}
 */
export function keyPoints(g, curves, max = 40) {
  const v = { x0: g.xMin, x1: g.xMax, y0: g.yMin, y1: g.yMax };
  const inside = (x, y) => x >= v.x0 && x <= v.x1 && y >= v.y0 && y <= v.y1;
  const out = [];
  const tolX = (v.x1 - v.x0) / 400, tolY = (v.y1 - v.y0) / 400;
  const addPt = (p) => {
    // a hair from zero is zero: -1.05e-8 is what bisection leaves of a root at the origin
    if (Math.abs(p.x) < tolX * 1e-3) p.x = 0;
    if (Math.abs(p.y) < tolY * 1e-3) p.y = 0;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !inside(p.x, p.y)) return;
    if (out.some((q) => Math.abs(q.x - p.x) < tolX * 2 && Math.abs(q.y - p.y) < tolY * 2)) return;
    out.push(p);
  };
  const live = curves.filter((c) => !c.hidden && !c.error && (c.paths.length || c.point));
  for (const c of live) {
    if (c.point) { addPt({ x: c.point[0], y: c.point[1], kind: 'point', i: c.i }); continue; }
    if (c.fx) {
      const f = c.fx, n = 600;
      let px = v.x0, py = f(px), pd = null;
      for (let k = 1; k <= n; k++) {
        const x = v.x0 + ((v.x1 - v.x0) * k) / n, y = f(x);
        if (Number.isFinite(py) && Number.isFinite(y)) {
          if (py === 0) addPt({ x: px, y: 0, kind: 'root', i: c.i });
          else if ((py < 0) !== (y < 0) && Math.abs(y - py) < (v.y1 - v.y0)) {
            const r = bisect(f, px, x);
            if (Math.abs(f(r)) < (v.y1 - v.y0) * 1e-3) addPt({ x: r, y: 0, kind: 'root', i: c.i });
          }
          const d = y - py;
          if (pd !== null && Math.abs(d) < (v.y1 - v.y0) * 0.5 && Math.abs(pd) < (v.y1 - v.y0) * 0.5 && pd !== 0 && d !== 0 && (pd > 0) !== (d > 0)) {
            const xm = extremum(f, px - (x - px), x, pd > 0);
            const ym = f(xm);
            addPt({ x: xm, y: ym, kind: pd > 0 ? 'max' : 'min', i: c.i });
          }
          pd = d;
        } else pd = null;
        px = x; py = y;
      }
      const y0 = f(0);
      if (Number.isFinite(y0)) addPt({ x: 0, y: y0, kind: 'yint', i: c.i });
    } else {
      // other curves: where their lines cross the axes
      for (const p of c.paths) for (let k = 2; k < p.length; k += 2) {
        const xa = p[k - 2], ya = p[k - 1], xb = p[k], yb = p[k + 1];
        if ((ya < 0) !== (yb < 0)) addPt({ x: xa + (xb - xa) * (ya / (ya - yb)), y: 0, kind: 'root', i: c.i });
        if ((xa < 0) !== (xb < 0)) addPt({ x: 0, y: ya + (yb - ya) * (xa / (xa - xb)), kind: 'yint', i: c.i });
      }
    }
    if (out.length > max * 3) break;
  }
  // where two curves cross
  for (let a = 0; a < live.length; a++) for (let b = a + 1; b < live.length; b++) {
    const A = live[a], B = live[b];
    if (A.point || B.point) continue;
    if (A.fx && B.fx) {
      const h = (x) => A.fx(x) - B.fx(x), n = 600;
      let px = v.x0, ph = h(px);
      for (let k = 1; k <= n; k++) {
        const x = v.x0 + ((v.x1 - v.x0) * k) / n, hh = h(x);
        if (Number.isFinite(ph) && Number.isFinite(hh) && (ph < 0) !== (hh < 0) && Math.abs(hh - ph) < (v.y1 - v.y0)) {
          const r = bisect(h, px, x);
          if (Math.abs(h(r)) < (v.y1 - v.y0) * 1e-3) addPt({ x: r, y: A.fx(r), kind: 'cross', i: A.i, j: B.i });
        }
        px = x; ph = hh;
      }
    } else {
      for (const p of crossings(A.paths, B.paths)) addPt({ x: p[0], y: p[1], kind: 'cross', i: A.i, j: B.i });
    }
  }
  return out.slice(0, max);
}

function bisect(f, a, b) {
  let fa = f(a);
  for (let k = 0; k < 60; k++) {
    const m = (a + b) / 2, fm = f(m);
    if (!Number.isFinite(fm)) return m;
    if ((fm < 0) === (fa < 0)) { a = m; fa = fm; } else b = m;
  }
  return (a + b) / 2;
}

/** The highest (or lowest) point between a and b, by golden-section search. */
function extremum(f, a, b, highest) {
  const g = (Math.sqrt(5) - 1) / 2;
  const s = highest ? -1 : 1;
  let c = b - g * (b - a), d = a + g * (b - a);
  for (let k = 0; k < 60; k++) {
    if (s * f(c) < s * f(d)) b = d; else a = c;
    c = b - g * (b - a); d = a + g * (b - a);
  }
  return (a + b) / 2;
}

/** Where the lines of two curves cross, with a grid of buckets so a long curve is not checked against every bit of another. */
export function crossings(pa, pb, limit = 60) {
  const segsB = [];
  for (const p of pb) for (let k = 2; k < p.length; k += 2) segsB.push(p[k - 2], p[k - 1], p[k], p[k + 1]);
  if (!segsB.length) return [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let k = 0; k < segsB.length; k += 2) { x0 = Math.min(x0, segsB[k]); x1 = Math.max(x1, segsB[k]); y0 = Math.min(y0, segsB[k + 1]); y1 = Math.max(y1, segsB[k + 1]); }
  const G = 64, cw = (x1 - x0) / G || 1, ch = (y1 - y0) / G || 1;
  const cell = (x, y) => Math.max(0, Math.min(G - 1, Math.floor((x - x0) / cw))) + Math.max(0, Math.min(G - 1, Math.floor((y - y0) / ch))) * G;
  const buckets = new Map();
  for (let s = 0; s < segsB.length; s += 4) {
    const ca = cell(Math.min(segsB[s], segsB[s + 2]), Math.min(segsB[s + 1], segsB[s + 3]));
    const cb = cell(Math.max(segsB[s], segsB[s + 2]), Math.max(segsB[s + 1], segsB[s + 3]));
    for (let yy = Math.floor(ca / G); yy <= Math.floor(cb / G); yy++) for (let xx = ca % G; xx <= cb % G; xx++) {
      const k = xx + yy * G; const l = buckets.get(k); if (l) l.push(s); else buckets.set(k, [s]);
    }
  }
  const out = [];
  for (const p of pa) for (let k = 2; k < p.length; k += 2) {
    const ax = p[k - 2], ay = p[k - 1], bx = p[k], by = p[k + 1];
    const seen = new Set();
    const ca = cell(Math.min(ax, bx), Math.min(ay, by)), cb = cell(Math.max(ax, bx), Math.max(ay, by));
    for (let yy = Math.floor(ca / G); yy <= Math.floor(cb / G); yy++) for (let xx = ca % G; xx <= cb % G; xx++) {
      for (const s of buckets.get(xx + yy * G) || []) {
        if (seen.has(s)) continue; seen.add(s);
        const r = segHit(ax, ay, bx, by, segsB[s], segsB[s + 1], segsB[s + 2], segsB[s + 3]);
        if (r) { out.push(r); if (out.length >= limit) return out; }
      }
    }
  }
  return out;
}

function segHit(ax, ay, bx, by, cx, cy, dx, dy) {
  const rX = bx - ax, rY = by - ay, sX = dx - cx, sY = dy - cy;
  const den = rX * sY - rY * sX;
  if (Math.abs(den) < 1e-15) return null;
  const tt = ((cx - ax) * sY - (cy - ay) * sX) / den, u = ((cx - ax) * rY - (cy - ay) * rX) / den;
  if (tt < 0 || tt > 1 || u < 0 || u > 1) return null;
  return [ax + tt * rX, ay + tt * rY];
}

/** Nice round steps for the grid and the numbers along the axes. */
export function niceStep(span, target = 8) {
  const raw = span / target;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

/** A new graph's settings. */
export function defaultGraph() {
  return {
    exprs: [{ src: 'y = x^2 - 2', color: '#0063b1' }],
    xMin: -6, xMax: 6, yMin: -4, yMax: 6,
    tMin: 0, tMax: Math.round(Math.PI * 2 * 1000) / 1000,
    params: {}, grid: true, points: true, labels: true, pins: []
  };
}

export const GRAPH_COLORS = ['#0063b1', '#d13438', '#107c10', '#ca5010', '#8764b8', '#038387', '#e3008c', '#201f1e'];
