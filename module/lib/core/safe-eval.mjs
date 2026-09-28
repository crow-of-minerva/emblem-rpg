/** @layer lib/core */

/* -------------------------------------------- */
/*  Vocabulary                                  */
/* -------------------------------------------- */

/** Token kinds the tokenizer emits. */
const T = {
  NUMBER: 'NUMBER',
  STRING: 'STRING',
  IDENT: 'IDENT',
  OP: 'OP',
  LPAREN: 'LPAREN',
  RPAREN: 'RPAREN',
  LBRACE: 'LBRACE',
  RBRACE: 'RBRACE',
  LBRACKET: 'LBRACKET',
  RBRACKET: 'RBRACKET',
  ASSIGN: 'ASSIGN',
  DOT: 'DOT',
  COMMA: 'COMMA',
  SEMI: 'SEMI',
  EOF: 'EOF'
};

/**
 * Names refused in identifiers, property paths and local declarations, so an authored expression can't reach an
 * object's prototype.
 */
const FORBIDDEN_KEYS = new Set([
  '__proto__', 'prototype', 'constructor',
  '__defineGetter__', '__defineSetter__',
  '__lookupGetter__', '__lookupSetter__'
]);

/**
 * Identifiers that parse as literals rather than as a lookup, so an expression cannot be made to mean something
 * else by a context that happens to carry a `true` key.
 */
const KEYWORDS = {
  true: { value: true },
  false: { value: false },
  null: { value: null },
  undefined: { value: undefined }
};

/* -------------------------------------------- */
/*  Errors                                      */
/* -------------------------------------------- */

/**
 * Raised for anything the language refuses: an unexpected character, a malformed expression, a forbidden name.
 * Carries the whole expression in its message, since these surface in the console with no other context.
 * @extends {Error}
 */
class SafeEvalError extends Error {
  constructor(message, expr) {
    super(`SafeEval: ${message} in expression: ${expr}`);
    this.name = 'SafeEvalError';
  }
}

/* -------------------------------------------- */
/*  Tokenizer                                   */
/* -------------------------------------------- */

/**
 * Break an expression into tokens.
 *
 * Optional chaining is tokenized as a plain dot: property access already returns `undefined` for a missing
 * intermediate, so `a?.b` and `a.b` mean the same thing here and authors may write either.
 * @param {string} expr        Expression source.
 * @returns {object[]}         Tokens, always ending in an EOF.
 * @throws {SafeEvalError}     On any character the language does not accept.
 */
function tokenize(expr) {
  const tokens = [];
  let i = 0;
  const len = expr.length;

  while (i < len) {
    const ch = expr[i];

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }

    if (ch >= '0' && ch <= '9') {
      let j = i;
      while (j < len && ((expr[j] >= '0' && expr[j] <= '9') || expr[j] === '.')) j++;
      const text = expr.slice(i, j);
      const n = Number(text);
      if (!Number.isFinite(n)) throw new SafeEvalError(`invalid number "${text}"`, expr);
      tokens.push({ type: T.NUMBER, value: n });
      i = j;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      let s = '';
      while (j < len && expr[j] !== quote) {
        if (expr[j] === '\\') {
          if (j + 1 >= len) throw new SafeEvalError('unterminated string escape', expr);
          const next = expr[j + 1];
          s += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
          j += 2;
        } else {
          s += expr[j];
          j++;
        }
      }
      if (j >= len) throw new SafeEvalError('unterminated string', expr);
      tokens.push({ type: T.STRING, value: s });
      i = j + 1;
      continue;
    }

    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '$') {
      let j = i;
      while (j < len && (
        (expr[j] >= 'a' && expr[j] <= 'z') ||
        (expr[j] >= 'A' && expr[j] <= 'Z') ||
        (expr[j] >= '0' && expr[j] <= '9') ||
        expr[j] === '_' || expr[j] === '$'
      )) j++;
      const text = expr.slice(i, j);
      if (FORBIDDEN_KEYS.has(text)) throw new SafeEvalError(`forbidden identifier "${text}"`, expr);
      tokens.push({ type: T.IDENT, value: text });
      i = j;
      continue;
    }

    if (ch === '(' ) { tokens.push({ type: T.LPAREN }); i++; continue; }
    if (ch === ')') { tokens.push({ type: T.RPAREN }); i++; continue; }
    if (ch === '{') { tokens.push({ type: T.LBRACE }); i++; continue; }
    if (ch === '}') { tokens.push({ type: T.RBRACE }); i++; continue; }
    if (ch === '[') { tokens.push({ type: T.LBRACKET }); i++; continue; }
    if (ch === ']') { tokens.push({ type: T.RBRACKET }); i++; continue; }
    if (ch === ',') { tokens.push({ type: T.COMMA }); i++; continue; }
    if (ch === ';') { tokens.push({ type: T.SEMI }); i++; continue; }

    if (ch === '?' && expr[i + 1] === '.') { tokens.push({ type: T.DOT }); i += 2; continue; }
    if (ch === '.') { tokens.push({ type: T.DOT }); i++; continue; }

    if (ch === '=' && expr[i + 1] === '=' && expr[i + 2] === '=') { tokens.push({ type: T.OP, value: '===' }); i += 3; continue; }
    if (ch === '!' && expr[i + 1] === '=' && expr[i + 2] === '=') { tokens.push({ type: T.OP, value: '!==' }); i += 3; continue; }
    if (ch === '=' && expr[i + 1] === '=') { tokens.push({ type: T.OP, value: '==' }); i += 2; continue; }
    if (ch === '!' && expr[i + 1] === '=') { tokens.push({ type: T.OP, value: '!=' }); i += 2; continue; }
    if (ch === '<' && expr[i + 1] === '=') { tokens.push({ type: T.OP, value: '<=' }); i += 2; continue; }
    if (ch === '>' && expr[i + 1] === '=') { tokens.push({ type: T.OP, value: '>=' }); i += 2; continue; }
    if (ch === '&' && expr[i + 1] === '&') { tokens.push({ type: T.OP, value: '&&' }); i += 2; continue; }
    if (ch === '|' && expr[i + 1] === '|') { tokens.push({ type: T.OP, value: '||' }); i += 2; continue; }
    if (ch === '?' && expr[i + 1] === '?') { tokens.push({ type: T.OP, value: '??' }); i += 2; continue; }

    if (ch === '=') { tokens.push({ type: T.ASSIGN }); i++; continue; }

    if (ch === '?' || ch === ':') { tokens.push({ type: T.OP, value: ch }); i++; continue; }
    if ('<>+-*/%!'.includes(ch)) { tokens.push({ type: T.OP, value: ch }); i++; continue; }

    throw new SafeEvalError(`unexpected character "${ch}"`, expr);
  }

  tokens.push({ type: T.EOF });
  return tokens;
}

/* -------------------------------------------- */
/*  Parser                                      */
/* -------------------------------------------- */

/**
 * Recursive-descent parser over the token stream, producing the AST the evaluator walks. One instance per
 * expression. `expr` is kept only so errors can quote the source.
 */
class Parser {
  /* -------------------------------------------- */
  /*  Token Stream                                */
  /* -------------------------------------------- */

  /**
   * @param {object[]} tokens    Token stream to parse.
   * @param {string} expr        Source, quoted back in error messages.
   */
  constructor(tokens, expr) {
    this.tokens = tokens;
    this.expr = expr;
    this.pos = 0;
  }

  /** The token about to be read, without consuming it. */
  peek() { return this.tokens[this.pos]; }

  /** Read the next token and advance. */
  consume() { return this.tokens[this.pos++]; }

  /** Read the next token, insisting on its kind and, when given, its value. A mismatch throws SafeEvalError. */
  expect(type, value) {
    const t = this.consume();
    if (t.type !== type || (value !== undefined && t.value !== value)) {
      throw new SafeEvalError(`expected ${value ?? type}, got ${t.value ?? t.type}`, this.expr);
    }
    return t;
  }

  /* -------------------------------------------- */
  /*  Program                                     */
  /* -------------------------------------------- */

  /**
   * Parse the input as statements when it starts with if, return, const, let or var, and as one expression
   * otherwise. A statement program yields its return value. Trailing input is refused.
   * @returns {object}           Root AST node.
   * @throws {SafeEvalError}     On a malformed program, or on trailing tokens.
   */
  parseExpression() {

    const first = this.peek();
    const isStmt = first.type === T.IDENT && (first.value === 'if' || first.value === 'return' || first.value === 'const' || first.value === 'let' || first.value === 'var');
    let node;
    if (isStmt) {
      node = { type: 'StatementProgram', stmts: this.parseStatementList(T.EOF) };
    } else {
      node = this.parseTernary();
    }
    this.consumeOptionalSemis();
    if (this.peek().type !== T.EOF) {
      throw new SafeEvalError(`unexpected trailing token "${this.peek().value ?? this.peek().type}"`, this.expr);
    }
    return node;
  }

  /**
   * Skip any run of semicolons. Statements are separated rather than terminated here, so a trailing one is fine and
   * so is a missing one.
   */
  consumeOptionalSemis() {
    while (this.peek().type === T.SEMI) this.consume();
  }

  /* -------------------------------------------- */
  /*  Statements                                  */
  /* -------------------------------------------- */

  /** Parse statements up to the `until` token kind or the end of input. */
  parseStatementList(until) {
    const stmts = [];
    this.consumeOptionalSemis();
    while (this.peek().type !== until && this.peek().type !== T.EOF) {
      stmts.push(this.parseStatement());
      this.consumeOptionalSemis();
    }
    return stmts;
  }

  /**
   * Parse one statement. Only blocks, `if`, `return` and variable declarations exist. There are no loops, which is
   * what bounds the running time of an authored expression.
   * @throws {SafeEvalError}     When nothing statement-like follows.
   */
  parseStatement() {
    const tok = this.peek();
    if (tok.type === T.LBRACE) return this.parseBlock();
    if (tok.type === T.IDENT) {
      if (tok.value === 'if') return this.parseIfStmt();
      if (tok.value === 'return') return this.parseReturnStmt();
      if (tok.value === 'const' || tok.value === 'let' || tok.value === 'var') return this.parseVarDecl();
    }
    throw new SafeEvalError(`unexpected statement-leading token "${tok.value ?? tok.type}"`, this.expr);
  }

  /** Parse a braced statement list. */
  parseBlock() {
    this.expect(T.LBRACE);
    const stmts = this.parseStatementList(T.RBRACE);
    this.expect(T.RBRACE);
    return { type: 'Block', stmts };
  }

  /**
   * Parse `if (cond) stmt [else stmt]`. The else binds to the nearest unmatched if, as it does in JavaScript,
   * because the recursion consumes it before returning.
   */
  parseIfStmt() {
    this.expectKeyword('if');
    this.expect(T.LPAREN);
    const cond = this.parseTernary();
    this.expect(T.RPAREN);
    const thenStmt = this.parseStatement();
    let elseStmt = null;

    if (this.peek().type === T.IDENT && this.peek().value === 'else') {
      this.consume();
      elseStmt = this.parseStatement();
    }
    return { type: 'IfStmt', cond, then: thenStmt, else: elseStmt };
  }

  /**
   * Parse `return [expr]`. A bare return yields `undefined`, so the end of a statement list and an explicit early
   * exit agree on what an empty result looks like.
   */
  parseReturnStmt() {
    this.expectKeyword('return');

    if (this.peek().type === T.SEMI || this.peek().type === T.EOF || this.peek().type === T.RBRACE) {
      return { type: 'ReturnStmt', expr: { type: 'Literal', value: undefined } };
    }
    const expr = this.parseTernary();
    return { type: 'ReturnStmt', expr };
  }

  /**
   * Parse a variable declaration. `const`, `let` and `var` all mean the same thing: a name in the local scope, with
   * no re-assignment, since the language has no assignment operator outside a declaration. A forbidden name throws.
   */
  parseVarDecl() {
    const kw = this.consume();
    if (kw.value !== 'const' && kw.value !== 'let' && kw.value !== 'var') {
      throw new SafeEvalError(`expected variable declaration keyword`, this.expr);
    }
    const nameTok = this.expect(T.IDENT);
    if (FORBIDDEN_KEYS.has(nameTok.value)) throw new SafeEvalError(`forbidden identifier "${nameTok.value}"`, this.expr);
    let init = { type: 'Literal', value: undefined };
    if (this.peek().type === T.ASSIGN) {
      this.consume();
      init = this.parseTernary();
    }
    return { type: 'VariableDecl', name: nameTok.value, init };
  }

  /**
   * Read the next token, insisting it is a particular keyword. Keywords are ordinary identifiers to the tokenizer,
   * so this is what distinguishes `if` the statement from `if` the property name.
   */
  expectKeyword(name) {
    const t = this.consume();
    if (t.type !== T.IDENT || t.value !== name) {
      throw new SafeEvalError(`expected "${name}", got ${t.value ?? t.type}`, this.expr);
    }
    return t;
  }

  /* -------------------------------------------- */
  /*  Expressions                                 */
  /* -------------------------------------------- */

  /**
   * Parse `cond ? then : else`, the loosest-binding expression form. The two branches recurse into `parseTernary`
   * rather than a tighter level, so ternaries chain to the right the way they do in JavaScript.
   */
  parseTernary() {
    const cond = this.parseLogicalOr();
    if (this.peek().type === T.OP && this.peek().value === '?') {
      this.consume();
      const then = this.parseTernary();
      if (this.peek().type !== T.OP || this.peek().value !== ':') {
        throw new SafeEvalError(`expected ":" in ternary`, this.expr);
      }
      this.consume();
      const elseExpr = this.parseTernary();
      return { type: 'Ternary', cond, then, else: elseExpr };
    }
    return cond;
  }

  /**
   * Parse `||` and `??`, which share a precedence level here. JavaScript refuses to mix them without parentheses,
   * but this parser allows it and reads them strictly left to right.
   */
  parseLogicalOr() {
    let left = this.parseLogicalAnd();
    while (this.peek().type === T.OP && (this.peek().value === '||' || this.peek().value === '??')) {
      const op = this.consume().value;
      const right = this.parseLogicalAnd();
      left = { type: 'BinOp', op, left, right };
    }
    return left;
  }

  /** Parse `&&`. */
  parseLogicalAnd() {
    let left = this.parseEquality();
    while (this.peek().type === T.OP && this.peek().value === '&&') {
      const op = this.consume().value;
      const right = this.parseEquality();
      left = { type: 'BinOp', op, left, right };
    }
    return left;
  }

  /**
   * Parse the equality operators. Both the strict and the loose forms exist, since authored conditions compare
   * stored values whose types are not always what the author expects.
   */
  parseEquality() {
    let left = this.parseComparison();
    while (this.peek().type === T.OP && ['===', '!==', '==', '!='].includes(this.peek().value)) {
      const op = this.consume().value;
      const right = this.parseComparison();
      left = { type: 'BinOp', op, left, right };
    }
    return left;
  }

  /** Parse the ordering comparisons. */
  parseComparison() {
    let left = this.parseAdditive();
    while (this.peek().type === T.OP && ['<', '>', '<=', '>='].includes(this.peek().value)) {
      const op = this.consume().value;
      const right = this.parseAdditive();
      left = { type: 'BinOp', op, left, right };
    }
    return left;
  }

  /** Parse addition and subtraction. */
  parseAdditive() {
    let left = this.parseMultiplicative();
    while (this.peek().type === T.OP && (this.peek().value === '+' || this.peek().value === '-')) {
      const op = this.consume().value;
      const right = this.parseMultiplicative();
      left = { type: 'BinOp', op, left, right };
    }
    return left;
  }

  /** Parse multiplication, division and remainder. */
  parseMultiplicative() {
    let left = this.parseUnary();
    while (this.peek().type === T.OP && ['*', '/', '%'].includes(this.peek().value)) {
      const op = this.consume().value;
      const right = this.parseUnary();
      left = { type: 'BinOp', op, left, right };
    }
    return left;
  }

  /** Parse a prefix `!`, `-` or `+`, recursing so they stack. */
  parseUnary() {
    if (this.peek().type === T.OP && (this.peek().value === '!' || this.peek().value === '-' || this.peek().value === '+')) {
      const op = this.consume().value;
      const operand = this.parseUnary();
      return { type: 'UnaryOp', op, operand };
    }
    return this.parsePrimary();
  }

  /**
   * Parse a literal, array, parenthesized expression or dotted path. A call must name a receiver, such as
   * `Math.max(...)`, and evaluate checks it against SAFE_METHODS.
   * @throws {SafeEvalError}     On a token that cannot start an expression, or on a bare call.
   */
  parsePrimary() {
    const t = this.peek();

    if (t.type === T.NUMBER) {
      this.consume();
      return { type: 'Literal', value: t.value };
    }

    if (t.type === T.STRING) {
      this.consume();
      return { type: 'Literal', value: t.value };
    }

    if (t.type === T.LPAREN) {
      this.consume();
      const inner = this.parseTernary();
      this.expect(T.RPAREN);
      return inner;
    }

    if (t.type === T.LBRACKET) {
      this.consume();
      const elements = [];
      if (this.peek().type !== T.RBRACKET) {
        elements.push(this.parseTernary());
        while (this.peek().type === T.COMMA) {
          this.consume();
          if (this.peek().type === T.RBRACKET) break;
          elements.push(this.parseTernary());
        }
      }
      this.expect(T.RBRACKET);
      return { type: 'ArrayLiteral', elements };
    }

    if (t.type === T.IDENT) {
      this.consume();
      if (Object.prototype.hasOwnProperty.call(KEYWORDS, t.value)) {
        return { type: 'Literal', value: KEYWORDS[t.value].value };
      }
      const path = [t.value];
      while (this.peek().type === T.DOT) {
        this.consume();
        const next = this.expect(T.IDENT);
        path.push(next.value);
      }

      if (this.peek().type === T.LPAREN) {
        this.consume();
        const args = [];
        if (this.peek().type !== T.RPAREN) {
          args.push(this.parseTernary());
          while (this.peek().type === T.COMMA) {
            this.consume();
            args.push(this.parseTernary());
          }
        }
        this.expect(T.RPAREN);
        if (path.length < 2) {

          throw new SafeEvalError(`bare function call "${path[0]}()" is not supported`, this.expr);
        }
        const method = path[path.length - 1];
        const receiverPath = path.slice(0, -1);
        return { type: 'MethodCall', receiver: { type: 'PropertyAccess', path: receiverPath }, method, args };
      }
      return { type: 'PropertyAccess', path };
    }

    throw new SafeEvalError(`unexpected token "${t.value ?? t.type}"`, this.expr);
  }
}

/* -------------------------------------------- */
/*  Safe Methods                                */
/* -------------------------------------------- */

/**
 * The only methods an expression may call, each with the receiver type it needs. Any other call, or a call on the
 * wrong receiver, evaluates to undefined.
 */
const SAFE_METHODS = {
  includes: {
    receiverCheck: (r) => Array.isArray(r) || typeof r === 'string',
    apply: (r, args) => r.includes(args[0])
  },
  indexOf: {
    receiverCheck: (r) => Array.isArray(r) || typeof r === 'string',
    apply: (r, args) => r.indexOf(args[0])
  },
  startsWith: {
    receiverCheck: (r) => typeof r === 'string',
    apply: (r, args) => r.startsWith(args[0])
  },
  endsWith: {
    receiverCheck: (r) => typeof r === 'string',
    apply: (r, args) => r.endsWith(args[0])
  },
  toLowerCase: {
    receiverCheck: (r) => typeof r === 'string',
    apply: (r) => r.toLowerCase()
  },
  toUpperCase: {
    receiverCheck: (r) => typeof r === 'string',
    apply: (r) => r.toUpperCase()
  },

  max:   { receiverCheck: (r) => r === Math, apply: (_r, args) => Math.max(...args.map(Number)) },
  min:   { receiverCheck: (r) => r === Math, apply: (_r, args) => Math.min(...args.map(Number)) },
  abs:   { receiverCheck: (r) => r === Math, apply: (_r, args) => Math.abs(Number(args[0])) },
  floor: { receiverCheck: (r) => r === Math, apply: (_r, args) => Math.floor(Number(args[0])) },
  ceil:  { receiverCheck: (r) => r === Math, apply: (_r, args) => Math.ceil(Number(args[0])) },
  round: { receiverCheck: (r) => r === Math, apply: (_r, args) => Math.round(Number(args[0])) },
  sign:  { receiverCheck: (r) => r === Math, apply: (_r, args) => Math.sign(Number(args[0])) },
  pow:   { receiverCheck: (r) => r === Math, apply: (_r, args) => Math.pow(Number(args[0]), Number(args[1])) }
};

/** The only globals in scope. Everything else an expression can name comes from the context it is given. */
const GLOBALS = { Math };

/** Build the lookup scope for one evaluation. The context is spread last, so a caller may shadow a global. */
function withGlobals(ctx) {

  return { ...GLOBALS, ...(ctx ?? {}) };
}

/* -------------------------------------------- */
/*  Evaluation                                  */
/* -------------------------------------------- */

/**
 * Resolve a dotted path for evaluate, with local declarations shadowing context names. It gives undefined at a
 * nullish value, a forbidden key or a non-string primitive, and never returns a function, since calls go through
 * SAFE_METHODS.
 */
function resolvePath(path, ctx) {
  let current;

  const first = path[0];
  const locals = ctx?.__locals;
  if (locals && Object.prototype.hasOwnProperty.call(locals, first)) {
    current = locals[first];
  } else {
    current = ctx?.[first];
  }
  for (let i = 1; i < path.length; i++) {
    if (current === null || current === undefined) return undefined;
    const key = path[i];
    if (FORBIDDEN_KEYS.has(key)) return undefined;
    if (typeof current !== 'object' && typeof current !== 'string' && typeof current !== 'function') return undefined;
    current = current[key];
  }
  return typeof current === 'function' ? undefined : current;
}

/**
 * Run one statement.
 *
 * A return travels back up as a sentinel object rather than as a thrown value, so each level can pass it along
 * and stop. The `StatementProgram` case in evaluate unwraps it.
 * @param {object} ctx           Lookup scope, carrying `__locals`.
 * @returns {object|null}        The return sentinel, or `null` when the statement produced no return.
 */
function runStatement(node, ctx) {
  switch (node.type) {
    case 'Block': {
      for (const s of node.stmts) {
        const r = runStatement(s, ctx);
        if (r && r.__safeEvalReturn) return r;
      }
      return null;
    }
    case 'IfStmt': {
      if (evaluate(node.cond, ctx)) return runStatement(node.then, ctx);
      if (node.else) return runStatement(node.else, ctx);
      return null;
    }
    case 'ReturnStmt': {
      return { __safeEvalReturn: true, value: evaluate(node.expr, ctx) };
    }
    case 'VariableDecl': {

      ctx.__locals = ctx.__locals || {};
      if (FORBIDDEN_KEYS.has(node.name)) return null;
      ctx.__locals[node.name] = evaluate(node.init, ctx);
      return null;
    }
    default:
      throw new Error(`unknown statement type ${node.type}`);
  }
}

/**
 * Evaluate a parsed AST node. Division and remainder by zero give 0, which suits stat formulas, and + concatenates
 * when either side is a string. A statement program's declarations live in a child scope, so they can't change the
 * caller's context.
 */
function evaluate(node, ctx) {
  switch (node.type) {
    case 'Literal':
      return node.value;
    case 'PropertyAccess':
      return resolvePath(node.path, ctx);
    case 'ArrayLiteral':
      return node.elements.map(e => evaluate(e, ctx));
    case 'MethodCall': {
      const recv = evaluate(node.receiver, ctx);
      if (!Object.hasOwn(SAFE_METHODS, node.method)) return undefined;
      const spec = SAFE_METHODS[node.method];
      if (!spec.receiverCheck(recv)) return undefined;
      const args = node.args.map(a => evaluate(a, ctx));
      try { return spec.apply(recv, args); } catch { return undefined; }
    }
    case 'StatementProgram': {

      const scopedCtx = Object.create(ctx ?? {});
      scopedCtx.__locals = {};
      for (const s of node.stmts) {
        const r = runStatement(s, scopedCtx);
        if (r && r.__safeEvalReturn) return r.value;
      }
      return undefined;
    }
    case 'Ternary':
      return evaluate(node.cond, ctx) ? evaluate(node.then, ctx) : evaluate(node.else, ctx);
    case 'UnaryOp': {
      const v = evaluate(node.operand, ctx);
      if (node.op === '!') return !v;
      if (node.op === '-') return -Number(v);
      if (node.op === '+') return +Number(v);
      throw new Error(`unknown unary op ${node.op}`);
    }
    case 'BinOp': {
      const a = evaluate(node.left, ctx);
      if (node.op === '&&') return a && evaluate(node.right, ctx);
      if (node.op === '||') return a || evaluate(node.right, ctx);
      if (node.op === '??') return (a !== null && a !== undefined) ? a : evaluate(node.right, ctx);
      const b = evaluate(node.right, ctx);
      switch (node.op) {
        case '+': return (typeof a === 'string' || typeof b === 'string') ? String(a) + String(b) : Number(a) + Number(b);
        case '-': return Number(a) - Number(b);
        case '*': return Number(a) * Number(b);
        case '/': return Number(b) === 0 ? 0 : Number(a) / Number(b);
        case '%': return Number(b) === 0 ? 0 : Number(a) % Number(b);
        case '===': return a === b;
        case '!==': return a !== b;
        case '==': return a == b;
        case '!=': return a != b;
        case '<': return Number(a) < Number(b);
        case '>': return Number(a) > Number(b);
        case '<=': return Number(a) <= Number(b);
        case '>=': return Number(a) >= Number(b);
        default: throw new Error(`unknown binary op ${node.op}`);
      }
    }
    default:
      throw new Error(`unknown node type ${node.type}`);
  }
}

/* -------------------------------------------- */
/*  Compilation Cache                           */
/* -------------------------------------------- */

/** Tokenize and parse an expression into an AST. Invalid input throws SafeEvalError. */
function compile(expr) {
  const tokens = tokenize(expr);
  const parser = new Parser(tokens, expr);
  return parser.parseExpression();
}

/**
 * Compiled ASTs by source. Expressions are re-evaluated constantly during stat preparation, so parsing is cached
 * even though evaluation is not.
 */
const _cache = new Map();

/** How many ASTs to hold before evicting. */
const _cacheMax = 512;

/**
 * The AST for an expression, compiling and caching it if it is new. Eviction is oldest-first by insertion, not by
 * use, which is enough here: the working set is whatever the open sheets and active effects reference.
 */
function getCompiled(expr) {
  if (_cache.has(expr)) return _cache.get(expr);
  const ast = compile(expr);
  if (_cache.size >= _cacheMax) {
    const oldest = _cache.keys().next().value;
    _cache.delete(oldest);
  }
  _cache.set(expr, ast);
  return ast;
}

/* -------------------------------------------- */
/*  Public API                                  */
/* -------------------------------------------- */

/**
 * Evaluate the authored expression DSL without eval or Function. Invalid input throws for the caller to report as
 * a structured failure.
 */
export const SafeEval = {
  /**
   * Evaluate an authored expression and return its value. Invalid input throws, for the calling rule to report.
   * @param {string} expr        Expression source.
   * @param {object} [ctx]       Values the expression may name.
   * @returns {*}                `undefined` for an empty expression.
   * @throws {SafeEvalError}
   */
  evaluate(expr, ctx) {
    if (expr === undefined || expr === null || expr === '') return undefined;
    const ast = getCompiled(String(expr));
    return evaluate(ast, withGlobals(ctx));
  }
};
