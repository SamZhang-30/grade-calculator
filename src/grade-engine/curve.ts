import type { CurveMode, GradeCategory } from "./types.js";

type CurveSettings = Pick<
  GradeCategory,
  | "curveEnabled"
  | "curveMode"
  | "curveAddend"
  | "curveMultiplier"
  | "curveExpression"
  | "curveCap"
>;

type Token =
  | { kind: "number"; value: number }
  | { kind: "identifier"; value: string }
  | { kind: "operator"; value: "+" | "-" | "*" | "/" | "^" }
  | { kind: "left" | "right" | "comma" };

export type CurveEvaluation =
  | { ok: true; value: number }
  | { ok: false; error: string };

const MAX_EXPRESSION_LENGTH = 180;
const MAX_TOKENS = 160;

function tokenise(expression: string): Token[] {
  if (expression.length > MAX_EXPRESSION_LENGTH) {
    throw new Error(`Keep the formula under ${MAX_EXPRESSION_LENGTH} characters.`);
  }

  const tokens: Token[] = [];
  let index = 0;
  while (index < expression.length) {
    const rest = expression.slice(index);
    const whitespace = rest.match(/^\s+/);
    if (whitespace) {
      index += whitespace[0].length;
      continue;
    }

    const number = rest.match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i);
    if (number) {
      const value = Number(number[0]);
      if (!Number.isFinite(value)) throw new Error("Every number must be finite.");
      tokens.push({ kind: "number", value });
      index += number[0].length;
      continue;
    }

    const identifier = rest.match(/^[a-z][a-z0-9_]*/i);
    if (identifier) {
      tokens.push({ kind: "identifier", value: identifier[0].toLowerCase() });
      index += identifier[0].length;
      continue;
    }

    const character = rest[0]!;
    if (character === "*" && rest[1] === "*") {
      tokens.push({ kind: "operator", value: "^" });
      index += 2;
      continue;
    }
    if (character === "+" || character === "-" || character === "*" || character === "/" || character === "^") {
      tokens.push({ kind: "operator", value: character });
    } else if (character === "(") {
      tokens.push({ kind: "left" });
    } else if (character === ")") {
      tokens.push({ kind: "right" });
    } else if (character === ",") {
      tokens.push({ kind: "comma" });
    } else {
      throw new Error(`“${character}” is not supported.`);
    }
    index += 1;
    if (tokens.length > MAX_TOKENS) throw new Error("That formula has too many operations.");
  }
  return tokens;
}

function finite(value: number): number {
  if (!Number.isFinite(value)) throw new Error("The formula does not produce a finite score.");
  return value;
}

function callFunction(name: string, args: number[]): number {
  const unary: Record<string, (value: number) => number> = {
    sqrt: Math.sqrt,
    abs: Math.abs,
    round: Math.round,
    floor: Math.floor,
    ceil: Math.ceil,
  };
  if (name in unary) {
    if (args.length !== 1) throw new Error(`${name}() takes one value.`);
    return finite(unary[name]!(args[0]!));
  }
  if (name === "min" || name === "max") {
    if (args.length < 2) throw new Error(`${name}() takes at least two values.`);
    return finite(name === "min" ? Math.min(...args) : Math.max(...args));
  }
  if (name === "pow") {
    if (args.length !== 2) throw new Error("pow() takes two values.");
    return finite(args[0]! ** args[1]!);
  }
  throw new Error(`Unknown function “${name}”.`);
}

/** Evaluate a deliberately small mathematical language; no JavaScript is run. */
export function evaluateCurveExpression(expression: string, x: number): CurveEvaluation {
  try {
    const tokens = tokenise(expression);
    if (tokens.length === 0) throw new Error("Enter a formula using x.");
    let cursor = 0;

    const peek = () => tokens[cursor];
    const take = () => tokens[cursor++];

    const parsePrimary = (): number => {
      const token = take();
      if (!token) throw new Error("The formula ends too soon.");
      if (token.kind === "number") return token.value;
      if (token.kind === "left") {
        const value = parseExpression();
        if (take()?.kind !== "right") throw new Error("Close every parenthesis.");
        return value;
      }
      if (token.kind === "identifier") {
        if (token.value === "x") return x;
        if (token.value === "pi") return Math.PI;
        if (token.value === "e") return Math.E;
        if (peek()?.kind !== "left") throw new Error(`Use ${token.value}() with parentheses.`);
        take();
        const args: number[] = [];
        if (peek()?.kind !== "right") {
          while (true) {
            args.push(parseExpression());
            if (peek()?.kind !== "comma") break;
            take();
          }
        }
        if (take()?.kind !== "right") throw new Error(`Close ${token.value}().`);
        return callFunction(token.value, args);
      }
      throw new Error("Expected a number, x, or a function.");
    };

    const parseUnary = (): number => {
      const token = peek();
      if (token?.kind === "operator" && (token.value === "+" || token.value === "-")) {
        take();
        const value = parseUnary();
        return token.value === "-" ? -value : value;
      }
      return parsePrimary();
    };

    const parsePower = (): number => {
      const value = parseUnary();
      const token = peek();
      if (token?.kind === "operator" && token.value === "^") {
        take();
        return finite(value ** parsePower());
      }
      return value;
    };

    const parseTerm = (): number => {
      let value = parsePower();
      while (true) {
        const token = peek();
        if (token?.kind !== "operator" || (token.value !== "*" && token.value !== "/")) break;
        take();
        const right = parsePower();
        value = finite(token.value === "*" ? value * right : value / right);
      }
      return value;
    };

    function parseExpression(): number {
      let value = parseTerm();
      while (true) {
        const token = peek();
        if (token?.kind !== "operator" || (token.value !== "+" && token.value !== "-")) break;
        take();
        const right = parseTerm();
        value = finite(token.value === "+" ? value + right : value - right);
      }
      return value;
    }

    const value = finite(parseExpression());
    if (cursor !== tokens.length) throw new Error("Check the operators and parentheses.");
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

function modeOf(settings: CurveSettings): CurveMode {
  return settings.curveMode ?? "ADDITIVE";
}

/** Returns null when a curve is ready to apply, otherwise a concise explanation. */
export function curveError(settings: CurveSettings): string | null {
  if (!settings.curveEnabled) return null;
  const mode = modeOf(settings);
  if (mode === "ADDITIVE") {
    return Number.isFinite(settings.curveAddend ?? 0) ? null : "Enter a finite adjustment.";
  }
  if (mode === "MULTIPLICATIVE") {
    return Number.isFinite(settings.curveMultiplier ?? 100) ? null : "Enter a finite multiplier.";
  }
  const checked = evaluateCurveExpression(settings.curveExpression ?? "", 75);
  return checked.ok ? null : checked.error;
}

export function hasActiveCurve(settings: CurveSettings): boolean {
  return settings.curveEnabled === true && curveError(settings) === null;
}

/** Transform one normalized score, while formulas themselves remain human-scale percentages. */
export function applyCurve(percent: number, settings: CurveSettings): number {
  if (!hasActiveCurve(settings)) return percent;
  const x = percent * 100;
  let curved: number;
  switch (modeOf(settings)) {
    case "ADDITIVE":
      curved = x + (settings.curveAddend ?? 0);
      break;
    case "MULTIPLICATIVE":
      curved = x * ((settings.curveMultiplier ?? 100) / 100);
      break;
    case "CUSTOM": {
      const evaluated = evaluateCurveExpression(settings.curveExpression ?? "", x);
      curved = evaluated.ok ? evaluated.value : x;
      break;
    }
  }
  if (settings.curveCap ?? true) curved = Math.min(100, curved);
  return Number.isFinite(curved) ? curved / 100 : percent;
}

export function applyCurveInterval<T extends { low: number; high: number }>(
  interval: T,
  settings: CurveSettings,
): T {
  const ends = [applyCurve(interval.low, settings), applyCurve(interval.high, settings)];
  return { ...interval, low: Math.min(...ends), high: Math.max(...ends) };
}
