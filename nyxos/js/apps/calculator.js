import { registerApp } from '../core/registry.js';
import { el, haptic } from '../core/util.js';

registerApp({
  id: 'calculator', name: 'Calculator', icon: 'calc', color: '#c58cff', order: 20, chrome: false,
  mount(root, sys, ctx) {
    let cur = '0', prev = null, op = null, fresh = true;
    const exprEl = el('div', { class: 'calc-expr' });
    const resEl = el('div', { class: 'calc-result', text: '0' });

    const fmt = (n) => {
      if (!isFinite(n)) return 'Error';
      const s = Number(n.toPrecision(12)).toString();
      return s.length > 12 ? Number(n).toExponential(6) : s;
    };
    const paint = () => {
      resEl.textContent = cur;
      exprEl.textContent = prev != null ? `${fmt(prev)} ${op || ''}` : '';
    };
    const compute = () => {
      const a = prev, b = parseFloat(cur);
      let r = b;
      if (op === '+') r = a + b; else if (op === '−') r = a - b;
      else if (op === '×') r = a * b; else if (op === '÷') r = b === 0 ? NaN : a / b;
      return r;
    };
    const inputDigit = (d) => { if (fresh || cur === '0') { cur = d === '.' ? '0.' : d; fresh = false; } else if (!(d === '.' && cur.includes('.'))) cur += d; paint(); };
    const setOp = (o) => {
      if (op && !fresh) { prev = compute(); cur = fmt(prev); }
      else prev = parseFloat(cur);
      op = o; fresh = true; paint();
    };
    const equals = () => { if (op == null) return; prev = compute(); cur = fmt(prev); op = null; fresh = true; paint(); };
    const clearAll = () => { cur = '0'; prev = null; op = null; fresh = true; paint(); };

    const keys = [
      ['AC', 'fn', clearAll], ['±', 'fn', () => { cur = fmt(-parseFloat(cur)); paint(); }], ['%', 'fn', () => { cur = fmt(parseFloat(cur) / 100); paint(); }], ['÷', 'op', () => setOp('÷')],
      ['7', '', () => inputDigit('7')], ['8', '', () => inputDigit('8')], ['9', '', () => inputDigit('9')], ['×', 'op', () => setOp('×')],
      ['4', '', () => inputDigit('4')], ['5', '', () => inputDigit('5')], ['6', '', () => inputDigit('6')], ['−', 'op', () => setOp('−')],
      ['1', '', () => inputDigit('1')], ['2', '', () => inputDigit('2')], ['3', '', () => inputDigit('3')], ['+', 'op', () => setOp('+')],
      ['0', 'span2', () => inputDigit('0')], ['.', '', () => inputDigit('.')], ['=', 'eq', equals],
    ];
    const pad = el('div', { class: 'calc-pad' });
    for (const [label, cls, fn] of keys) {
      const b = el('button', { class: cls, text: label, on: { click: () => { haptic(6); fn(); } } });
      if (cls === 'span2') b.style.gridColumn = 'span 2';
      pad.append(b);
    }
    root.append(el('div', { class: 'calc' },
      el('div', { class: 'calc-display' }, exprEl, resEl), pad));
  },
});
