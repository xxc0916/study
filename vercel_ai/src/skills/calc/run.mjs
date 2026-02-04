function tokenize(expr) {
  const s = String(expr ?? '').trim();
  if (!s) throw new Error('expr 不能为空');

  const tokens = [];
  let i = 0;

  const isDigit = (c) => c >= '0' && c <= '9';
  const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';

  while (i < s.length) {
    const c = s[i];
    if (isSpace(c)) {
      i += 1;
      continue;
    }

    if (c === '(') {
      tokens.push({ type: 'lparen' });
      i += 1;
      continue;
    }
    if (c === ')') {
      tokens.push({ type: 'rparen' });
      i += 1;
      continue;
    }
    if (c === '+' || c === '-' || c === '*' || c === '/') {
      tokens.push({ type: 'op', value: c });
      i += 1;
      continue;
    }

    if (isDigit(c) || c === '.') {
      let j = i;
      let sawDot = false;
      while (j < s.length) {
        const d = s[j];
        if (isDigit(d)) {
          j += 1;
          continue;
        }
        if (d === '.') {
          if (sawDot) break;
          sawDot = true;
          j += 1;
          continue;
        }
        break;
      }
      const raw = s.slice(i, j);
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new Error(`无法解析数字：${raw}`);
      tokens.push({ type: 'num', value });
      i = j;
      continue;
    }

    throw new Error(`不支持的字符：${c}`);
  }

  return tokens;
}

function precedence(op) {
  if (op === '*' || op === '/') return 2;
  return 1;
}

function toRpn(tokens) {
  const out = [];
  const stack = [];

  let prev = null;

  for (const t of tokens) {
    if (t.type === 'num') {
      out.push(t);
      prev = t;
      continue;
    }

    if (t.type === 'op') {
      const unaryMinus = t.value === '-' && (prev === null || prev.type === 'op' || prev.type === 'lparen');

      if (unaryMinus) out.push({ type: 'num', value: 0 });

      while (stack.length) {
        const top = stack[stack.length - 1];
        if (top.type !== 'op') break;
        if (precedence(top.value) < precedence(t.value)) break;
        out.push(stack.pop());
      }
      stack.push(t);
      prev = t;
      continue;
    }

    if (t.type === 'lparen') {
      stack.push(t);
      prev = t;
      continue;
    }

    if (t.type === 'rparen') {
      while (stack.length && stack[stack.length - 1].type !== 'lparen') {
        out.push(stack.pop());
      }
      const last = stack.pop();
      if (!last || last.type !== 'lparen') throw new Error('括号不匹配');
      prev = t;
      continue;
    }
  }

  while (stack.length) {
    const t = stack.pop();
    if (t.type === 'lparen' || t.type === 'rparen') throw new Error('括号不匹配');
    out.push(t);
  }

  return out;
}

function evalRpn(tokens) {
  const stack = [];
  for (const t of tokens) {
    if (t.type === 'num') {
      stack.push(t.value);
      continue;
    }
    if (t.type !== 'op') throw new Error('无效表达式');
    const b = stack.pop();
    const a = stack.pop();
    if (a === undefined || b === undefined) throw new Error('无效表达式');
    if (t.value === '+') stack.push(a + b);
    else if (t.value === '-') stack.push(a - b);
    else if (t.value === '*') stack.push(a * b);
    else stack.push(a / b);
  }
  if (stack.length !== 1) throw new Error('无效表达式');
  return stack[0];
}

export async function run(input) {
  const expr = input?.expr;
  if (typeof expr !== 'string') throw new Error('calc 需要输入 { expr: string }');

  const tokens = tokenize(expr);
  const rpn = toRpn(tokens);
  const value = evalRpn(rpn);
  if (!Number.isFinite(value)) throw new Error('结果不是有限数字');
  return { value };
}

